/**
 * Supervised watchers: long-running commands the plugin keeps alive. Each
 * stdout line becomes an event on the watcher's channel:
 *
 * - a JSON object line is the event's data (its string `id`, if any, is the
 *   dedupe key); `{"wakeAgent": false}` lines are ignored;
 * - any other non-empty line is the event's text.
 *
 * A watcher that exits is started again after a backoff (1 s doubling to
 * 5 min, back to 1 s once a run lasted a minute). One that stays down (no run
 * lasting `upAfterMs` for `downAlertMs`) sends one alert, and one line when it
 * is back. A `once` watcher runs a single time and is then done.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { isChannel } from './events.js'
import { KILL_GRACE_MS } from './command.js'

export const MIN_BACKOFF_MS = 1000
export const MAX_BACKOFF_MS = 5 * 60 * 1000
/** A run that lasts this long counts as up, and resets the backoff. */
export const UP_AFTER_MS = 60 * 1000
/** Down this long: one alert. */
export const DOWN_ALERT_MS = 15 * 60 * 1000
/** Longest stdout line read; the rest of a longer line is dropped. */
export const MAX_LINE_CHARS = 64 * 1024
const STDERR_TAIL_CHARS = 2000
const WATCHER_ID = /^[A-Za-z0-9_.-]{1,80}$/

/** A watcher definition that cannot be used. */
export class WatcherInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WatcherInputError'
    this.code = 'invalid_watcher'
  }
}

/** Check a watcher definition; returns a clean copy. */
export function checkWatcher(input) {
  const id = typeof input?.id === 'string' ? input.id.trim() : ''
  if (!WATCHER_ID.test(id)) throw new WatcherInputError('watcher id must be 1-80 letters, digits, _ . -')
  const channel = typeof input.channel === 'string' ? input.channel.trim() : ''
  if (!isChannel(channel)) throw new WatcherInputError(`${JSON.stringify(input.channel)} is not a channel name: dot-separated names of letters, digits, _ : -`)
  const command = typeof input.command === 'string' ? input.command : ''
  if (command.trim() === '') throw new WatcherInputError('a watcher needs a command')
  return {
    id,
    channel,
    command,
    ...(typeof input.cwd === 'string' && input.cwd.trim() !== '' ? { cwd: input.cwd.trim() } : {}),
    ...(input.once === true ? { once: true } : {}),
  }
}

/** Parse one stdout line into an event, or undefined to ignore it. */
export function lineEvent(line, channel, source) {
  const text = line.replace(/\r$/, '')
  if (text.trim() === '') return undefined
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { channel, text, source }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (value.wakeAgent === false && Object.keys(value).length === 1) return undefined
    return { channel, data: value, source, ...(typeof value.id === 'string' ? { key: value.id } : {}) }
  }
  return { channel, data: value, source }
}

/**
 * Runs and restarts a set of watchers.
 */
export class WatcherSupervisor {
  /**
   * @param {object} options
   * @param {(event: object) => void} options.emit - Receives each event.
   * @param {{ info: Function, warn: Function }} options.logger
   * @param {(entry: object) => Promise<void>} [options.record] - Run log.
   * @param {(text: string, watcher: object) => Promise<void>} [options.notify] - Sends a down or back-up note.
   * @param {(id: string) => Promise<void>} [options.onDone] - A once watcher finished.
   * @param {string} [options.stateRoot] - Each watcher gets `<stateRoot>/<id>` as DSH_CRON_STATE_DIR.
   * @param {() => number} [options.now]
   * @param {object} [options.limits] - Backoff and alert times, for tests.
   * @param {typeof spawn} [options.spawn]
   */
  constructor({ emit, logger, record = async () => {}, notify = async () => {}, onDone = async () => {}, stateRoot, now = () => Date.now(), limits = {}, spawn: spawnImpl = spawn }) {
    this.emit = emit
    this.logger = logger
    this.record = record
    this.notify = notify
    this.onDone = onDone
    this.stateRoot = stateRoot
    this.now = now
    this.limits = { minBackoffMs: MIN_BACKOFF_MS, maxBackoffMs: MAX_BACKOFF_MS, upAfterMs: UP_AFTER_MS, downAlertMs: DOWN_ALERT_MS, ...limits }
    this.spawn = spawnImpl
    /** @type {Map<string, Watcher>} */
    this.watchers = new Map()
    this.stopped = false
  }

  /**
   * Make the running set match `definitions`: start new ones, stop removed
   * ones, restart changed ones.
   * @param {{ id: string, channel: string, command: string, cwd?: string, once?: boolean, source?: string }[]} definitions
   */
  set(definitions) {
    if (this.stopped) return
    const wanted = new Map(definitions.map(def => [def.id, def]))
    for (const [id, watcher] of this.watchers) {
      const def = wanted.get(id)
      if (def === undefined || !sameDefinition(def, watcher.def)) {
        watcher.stop()
        this.watchers.delete(id)
      }
    }
    for (const [id, def] of wanted) {
      if (this.watchers.has(id)) continue
      const watcher = new Watcher(def, this)
      this.watchers.set(id, watcher)
      watcher.start()
    }
  }

  /** Status of every watcher, for the page and the tools. */
  list() {
    return [...this.watchers.values()].map(watcher => watcher.view())
  }

  get(id) {
    return this.watchers.get(id)?.view()
  }

  async stop() {
    this.stopped = true
    await Promise.allSettled([...this.watchers.values()].map(watcher => watcher.stop()))
  }
}

function sameDefinition(a, b) {
  return a.channel === b.channel && a.command === b.command && (a.cwd ?? '') === (b.cwd ?? '') && !!a.once === !!b.once
}

class Watcher {
  constructor(def, supervisor) {
    this.def = def
    this.sup = supervisor
    this.child = undefined
    this.state = 'starting'
    this.backoffMs = supervisor.limits.minBackoffMs
    this.restarts = 0
    this.lastExit = undefined
    this.startedAt = undefined
    this.upTimer = undefined
    this.restartTimer = undefined
    this.downTimer = undefined
    this.downSince = undefined
    this.alerted = false
    this.stopped = false
    this.events = 0
    this.lastEventAt = undefined
    this.stderr = ''
    this.exited = undefined
  }

  view() {
    const { def } = this
    return {
      id: def.id,
      channel: def.channel,
      command: def.command,
      cwd: def.cwd ?? null,
      once: def.once === true,
      source: def.source ?? 'tool',
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      restarts: this.restarts,
      events: this.events,
      lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      downSince: this.downSince ? new Date(this.downSince).toISOString() : null,
      lastExit: this.lastExit ?? null,
      stderrTail: this.stderr.trim() || null,
    }
  }

  async start() {
    if (this.stopped) return
    const { def, sup } = this
    const env = { ...process.env, DSH_CRON_WATCHER: def.id, DSH_CRON_CHANNEL: def.channel }
    this.pidFile = undefined
    if (sup.stateRoot) {
      const dir = join(sup.stateRoot, def.id)
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        env.DSH_CRON_STATE_DIR = dir
        this.pidFile = join(dir, '.watcher.pid')
        await reapStale(this.pidFile, def.id, sup.logger)
      } catch (error) {
        sup.logger.warn('[watcher %s] state directory not made: %s', def.id, String(error))
      }
    }
    if (this.stopped) return
    let child
    try {
      child = sup.spawn('bash', ['-c', def.command], {
        cwd: def.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      this.exit({ error: error instanceof Error ? error.message : String(error) })
      return
    }
    this.child = child
    if (this.pidFile && child.pid !== undefined) writeFile(this.pidFile, `${child.pid}\n`, { mode: 0o600 }).catch(() => {})
    this.state = 'running'
    this.startedAt = sup.now()
    this.stderr = ''
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    sup.logger.info('[watcher %s] started (pid %s)', def.id, child.pid)
    sup.record({ time: new Date(sup.now()).toISOString(), job: null, event: 'watcher-start', watcher: def.id, pid: child.pid ?? null })
    this.upTimer = setTimeout(() => this.up(), sup.limits.upAfterMs)
    this.upTimer.unref?.()

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', line => this.line(line))
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })
    let done = false
    const finish = (fields) => {
      if (done) return
      done = true
      lines.close()
      this.exit(fields)
    }
    child.on('error', error => { if (child.pid === undefined) finish({ error: error.message }) })
    child.on('close', (code, signal) => finish({ code, signal }))
  }

  line(raw) {
    const { def, sup } = this
    const line = raw.length > MAX_LINE_CHARS ? raw.slice(0, MAX_LINE_CHARS) : raw
    const event = lineEvent(line, def.channel, `watcher:${def.id}`)
    if (event === undefined) return
    this.events++
    this.lastEventAt = sup.now()
    try {
      sup.emit(event)
    } catch (error) {
      sup.logger.warn('[watcher %s] event not taken: %s', def.id, String(error))
    }
  }

  /** The run has lasted long enough to count as working. */
  up() {
    this.upTimer = undefined
    const { def, sup } = this
    this.backoffMs = sup.limits.minBackoffMs
    clearTimeout(this.downTimer)
    this.downTimer = undefined
    const wasDown = this.downSince !== undefined
    this.downSince = undefined
    if (wasDown && this.alerted) {
      this.alerted = false
      sup.record({ time: new Date(sup.now()).toISOString(), job: null, event: 'watcher-up', watcher: def.id })
      sup.notify(`✅ Watcher ${def.id} (${def.channel}) works again.`, def).catch(() => {})
    }
  }

  exit({ code = null, signal = null, error }) {
    const { def, sup } = this
    clearTimeout(this.upTimer)
    this.upTimer = undefined
    this.child = undefined
    if (this.pidFile) rm(this.pidFile, { force: true }).catch(() => {})
    const ranMs = this.startedAt === undefined ? 0 : sup.now() - this.startedAt
    this.lastExit = { at: new Date(sup.now()).toISOString(), code, signal, ...(error ? { error } : {}), ranMs }
    this.resolveExit?.()
    if (this.stopped) {
      this.state = 'stopped'
      return
    }
    const stderrTail = this.stderr.trim().slice(-500)
    sup.record({ time: new Date(sup.now()).toISOString(), job: null, event: 'watcher-exit', watcher: def.id, code, signal, ...(error ? { error } : {}), ranMs, ...(stderrTail ? { stderrTail } : {}) })
    if (def.once) {
      this.state = 'done'
      sup.logger.info('[watcher %s] finished (%s)', def.id, error ?? (signal ? `signal ${signal}` : `exit ${code}`))
      sup.onDone(def.id).catch(() => {})
      return
    }
    sup.logger.warn('[watcher %s] exited (%s) after %ss; restarting in %ss', def.id, error ?? (signal ? `signal ${signal}` : `exit ${code}`), Math.round(ranMs / 1000), Math.round(this.backoffMs / 1000))
    this.state = 'backoff'
    if (this.downSince === undefined) {
      this.downSince = sup.now()
      this.downTimer = setTimeout(() => this.down(), sup.limits.downAlertMs)
      this.downTimer.unref?.()
    }
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, sup.limits.maxBackoffMs)
    this.restarts++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.start()
    }, delay)
    this.restartTimer.unref?.()
  }

  /** Still down after the alert time: say so once. */
  down() {
    this.downTimer = undefined
    if (this.stopped || this.downSince === undefined || this.alerted) return
    const { def, sup } = this
    this.alerted = true
    const minutes = Math.round((sup.now() - this.downSince) / 60000)
    const exit = this.lastExit
    const how = exit?.error ?? (exit?.signal ? `killed by ${exit.signal}` : `exit ${exit?.code}`)
    const stderr = this.stderr.trim().slice(-300)
    sup.record({ time: new Date(sup.now()).toISOString(), job: null, event: 'watcher-down', watcher: def.id, downMs: sup.now() - this.downSince })
    sup.notify(`⚠️ Watcher ${def.id} (${def.channel}) has been down for ${minutes} min (${this.restarts} restarts, last: ${how})${stderr ? `: ${stderr}` : ''}. Jobs on this channel only run on their schedule until it is back.`, def).catch(() => {})
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.upTimer)
    clearTimeout(this.restartTimer)
    clearTimeout(this.downTimer)
    this.upTimer = this.restartTimer = this.downTimer = undefined
    const child = this.child
    if (child === undefined) {
      this.state = this.state === 'done' ? 'done' : 'stopped'
      return
    }
    killTree(child, 'SIGTERM')
    const kill = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
    kill.unref?.()
    await this.exited
    clearTimeout(kill)
  }
}

/**
 * Stop a copy of this watcher left running by a DSH process that died
 * without stopping it (SIGKILL, OOM): its process group would otherwise keep
 * running next to the new copy. Only a process whose environment names this
 * watcher is touched, so a reused pid is safe.
 */
async function reapStale(pidFile, id, logger) {
  const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim())
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')
  if (!environ.split('\0').includes(`DSH_CRON_WATCHER=${id}`)) return
  logger.warn('[watcher %s] stopping a copy left running by an earlier DSH (pid %s)', id, pid)
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
  }
}

function killTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch { /* gone */ }
  }
}
