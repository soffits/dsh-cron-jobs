/**
 * The event inbox: a directory where anything on this machine drops one JSON
 * file per event (bin/dsh-cron-event.js), for the running plugin to pick up.
 * It needs no port, token or network path into DSH, and events wait there
 * while DSH is down. Same design as the Telegram plugin's outbox.
 *
 * Files: `<id>.json` waiting, `<id>.processing` taken by the plugin and kept
 * until every run it started has begun (put back as `.json` after a restart),
 * `<id>.result.json` the matched jobs, written only when the sender waits.
 */
import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Result files nobody collected are removed after this long. */
const RESULT_TTL_MS = 3600 * 1000

/**
 * Write one event atomically.
 * @param {{ channel: string, data?: any, text?: string, key?: string, source?: string }} event
 * @param {{ dir: string, wait?: boolean }} options - `wait` asks the plugin for a result file.
 * @returns {Promise<string>} The event's file id.
 */
export async function enqueueEvent(event, { dir, wait = false }) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const temporary = join(dir, `${id}.tmp`)
  await writeFile(temporary, JSON.stringify({ ...event, at: new Date().toISOString(), ...(wait ? { wait: true } : {}) }) + '\n', { mode: 0o600 })
  await rename(temporary, join(dir, `${id}.json`))
  return id
}

/**
 * Wait for the plugin's result for one event.
 * @returns {Promise<object | undefined>} undefined after the timeout.
 */
export async function waitForEventResult(id, { dir, timeoutMs }) {
  const path = join(dir, `${id}.result.json`)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const result = JSON.parse(await readFile(path, 'utf8'))
      await rm(path, { force: true })
      return result
    } catch {
      // Not written yet.
    }
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/**
 * Plugin side: read events from the inbox, oldest first.
 * @param {object} options
 * @param {string} options.dir
 * @param {(input: object, ack: () => void) => { matched: string[], duplicate?: boolean }} options.handle - Dispatches one event; calls ack once the event may be deleted. Throws for a malformed event.
 * @param {(error: unknown) => void} options.onError
 * @param {number} [options.intervalMs] - Rescan period; file watching only speeds it up.
 */
export function createEventSpool({ dir, handle, onError, intervalMs = 1000 }) {
  let timer
  let watcher
  let draining
  let again = false
  let stopped = false
  /** Files handed to jobs and not yet released. */
  const held = new Set()

  async function recover() {
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.endsWith('.processing')) await rename(join(dir, name), join(dir, name.replace(/\.processing$/u, '.json'))).catch(() => {})
      else if (name.endsWith('.tmp')) {
        const info = await stat(join(dir, name)).catch(() => undefined)
        if (info !== undefined && Date.now() - info.mtimeMs > RESULT_TTL_MS) await rm(join(dir, name), { force: true })
      }
    }
  }

  async function sweep(names) {
    for (const name of names) {
      if (!name.endsWith('.result.json')) continue
      const info = await stat(join(dir, name)).catch(() => undefined)
      if (info !== undefined && Date.now() - info.mtimeMs > RESULT_TTL_MS) await rm(join(dir, name), { force: true })
    }
  }

  async function drainOnce() {
    const names = (await readdir(dir).catch(() => [])).sort()
    await sweep(names)
    for (const name of names) {
      if (stopped) return
      if (!name.endsWith('.json') || name.endsWith('.result.json')) continue
      const id = name.slice(0, -'.json'.length)
      const claimed = join(dir, `${id}.processing`)
      try {
        await rename(join(dir, name), claimed)
      } catch {
        continue
      }
      let input
      let outcome
      held.add(claimed)
      let acked = false
      const ack = () => {
        if (acked) return
        acked = true
        held.delete(claimed)
        // Its runs have started, so the file goes even after a stop.
        rm(claimed, { force: true }).catch(onError)
      }
      try {
        input = JSON.parse(await readFile(claimed, 'utf8'))
        const result = handle(input, ack)
        outcome = { ok: true, ...result }
      } catch (error) {
        if (error?.code === 'unavailable') {
          // The scheduler is stopping: back in line for the next start, and no more reading.
          stopped = true
          held.delete(claimed)
          await rename(claimed, join(dir, name)).catch(onError)
          return
        }
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
        ack()
      }
      if (input?.wait === true) {
        await writeFile(join(dir, `${id}.result.json`), JSON.stringify(outcome) + '\n', { mode: 0o600 }).catch(onError)
      }
    }
  }

  function drain() {
    if (stopped) return Promise.resolve()
    if (draining !== undefined) {
      again = true
      return draining
    }
    draining = (async () => {
      do {
        again = false
        await drainOnce()
      } while (again && !stopped)
    })().catch(onError).finally(() => { draining = undefined })
    return draining
  }

  return {
    async start() {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700).catch(() => {})
      await recover()
      try {
        watcher = watch(dir, () => { void drain() })
        watcher.on('error', () => {})
      } catch {
        // The interval still picks events up.
      }
      timer = setInterval(() => { void drain() }, intervalMs)
      timer.unref?.()
      await drain()
    },
    /** Stop reading; held events stay as .processing and come back at the next start. */
    async stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      watcher?.close()
      watcher = undefined
      await draining
    },
    drain,
    held,
  }
}
