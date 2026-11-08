import { decideWake } from './wake.js'
import { buildAgentPrompt, formatLocalTime, sessionTitle } from './prompt.js'
import { HISTORY_TAIL_CHARS } from './history.js'

/** Characters of stdout/stderr shown in the log after each run. */
export const LOG_TAIL_CHARS = 400

/** Stand-in history used when a runner has none. */
const NO_HISTORY = {
  begin: async () => undefined,
  finish: async () => {},
  update: async () => {},
  runs: () => [],
}

const HOUR_MS = 3600 * 1000

/**
 * Whether a job wakes an agent: it has an `agent` block with a prompt.
 * @param {Job} job
 */
export function isGated(job) {
  return typeof job.agent?.prompt === 'string' && job.agent.prompt.trim() !== ''
}

/**
 * The model chosen for a job's woken sessions, or undefined to use the preset
 * or host default. Needs both a provider and a model.
 * @param {Job} job
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function agentModel(job) {
  const provider = job.agent?.model?.provider?.trim()
  const model = job.agent?.model?.model?.trim()
  if (!provider || !model) return undefined
  const reasoningEffort = job.agent.model.reasoningEffort?.trim()
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

/**
 * Where and how a gated job's agent runs, after plugin defaults.
 * @param {Job} job
 * @param {{ agentCwd?: string, autoArchive?: boolean, reuseWithinHours?: number }} [defaults] - Plugin-level settings.
 * @returns {{ cwd?: string, autoArchive: boolean, reuseWithinHours: number }}
 */
export function agentSettings(job, defaults = {}) {
  const cwd = job.agent?.cwd || defaults.agentCwd || job.cwd || undefined
  return {
    ...(cwd ? { cwd } : {}),
    autoArchive: job.agent?.autoArchive ?? defaults.autoArchive ?? false,
    reuseWithinHours: job.agent?.reuseWithinHours ?? defaults.reuseWithinHours ?? 0,
  }
}

/**
 * Runs one configured job per tick. A tick that arrives while the previous run
 * of the same job is still going is skipped.
 *
 * @typedef {object} Job
 * @property {string} name
 * @property {string} cron
 * @property {string} [timeZone]
 * @property {string} command
 * @property {string} [cwd]
 * @property {number} [timeoutSeconds]
 * @property {{ prompt?: string, preset?: string, cwd?: string, model?: { provider?: string, model?: string, reasoningEffort?: string }, autoArchive?: boolean, reuseWithinHours?: number }} [agent]
 */
export class JobRunner {
  /**
   * @param {Job} job
   * @param {object} deps
   * @param {(options: object) => Promise<import('./command.js').CommandResult>} deps.run - Runs a command.
   * @param {(request: { text: string, title: string, agentPreset?: string, cwd?: string, model?: object }) => Promise<string>} deps.wake - Opens an agent session; resolves to its id.
   * @param {(request: { sessionId: string, text: string, mayUnarchive: boolean }) => Promise<{ queued?: boolean }>} [deps.reuse] - Sends the prompt into an existing session (see session.js deliverToSession); without it every wake opens a new session.
   * @param {(sessionId: string, options: { signal?: AbortSignal, isLatest: () => boolean, lock: Function }) => Promise<{ archive: string, note?: string }>} [deps.settle] - Archives a session after its turn (see session.js archiveWhenIdle); without it nothing is archived.
   * @param {{ agentCwd?: string, autoArchive?: boolean, reuseWithinHours?: number }} [deps.defaults] - Plugin-level agent settings.
   * @param {{ info: Function, warn: Function }} deps.logger
   * @param {AbortSignal} [deps.signal] - Stops a running command when aborted.
   * @param {(entry: object) => Promise<void>} [deps.record] - Appends a run record (see runlog.js).
   * @param {{ begin: Function, finish: Function }} [deps.history] - Saved run history (see history.js).
   * @param {() => Date} [deps.now]
   */
  constructor(job, { run, wake, reuse, settle, defaults = {}, logger, signal, record = async () => {}, history = NO_HISTORY, now = () => new Date() }) {
    this.job = job
    this.reuse = reuse
    this.settle = settle
    this.defaults = defaults
    /** Latest run that sent a prompt to each session; only that run archives it. */
    this.latestRun = new Map()
    /** Per-session queue that keeps a delivery and an archive from overlapping. */
    this.locks = new Map()
    /** Archive waits in progress, for tests and shutdown. */
    this.settling = new Set()
    this.record = record
    this.history = history
    this.run = run
    this.wake = wake
    this.logger = logger
    this.signal = signal
    this.now = now
    this.running = false
    /** The run in progress: when it started and what started it; null when idle. */
    this.current = null
  }

  /**
   * Run the job once. `running` and `current` are set before the first await,
   * so a caller can read them as soon as this returns its promise.
   * @param {{ trigger?: 'schedule' | 'manual' }} [options] - What started the run.
   * @returns {Promise<{ status: 'skipped' | 'done' | 'failed' | 'idle' | 'woke' | 'wake-failed', sessionId?: string }>}
   */
  async tick({ trigger = 'schedule' } = {}) {
    const { job, logger } = this
    if (this.running) {
      logger.warn('[%s] previous run still going; skipping this tick', job.name)
      await this.record({ time: this.now().toISOString(), job: job.name, event: 'skipped' })
      return { status: 'skipped' }
    }
    this.running = true
    const firedAt = this.now()
    this.current = { startedAt: firedAt.toISOString(), trigger }
    let result
    let outcome = { status: 'failed' }
    let thrown
    let runId
    try {
      logger.info('[%s] start%s', job.name, trigger === 'manual' ? ' (run now)' : '')
      // A start line on its own shows a run that never finished (DSH stopped mid-run).
      await this.record({ time: firedAt.toISOString(), job: job.name, event: 'start', ...(trigger === 'manual' ? { trigger } : {}) })
      runId = await this.history.begin(job.name, { trigger, startedAt: firedAt.toISOString() })
      outcome = await this.runOnce(firedAt, r => { result = r })
      return outcome
    } catch (error) {
      thrown = describeError(error)
      throw error
    } finally {
      const endedAt = this.now()
      await this.record({
        time: endedAt.toISOString(),
        job: job.name,
        event: 'end',
        status: outcome.status,
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        ...(thrown ? { error: thrown } : {}),
        ...(result ? {
          outcome: describeOutcome(result, job),
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs,
          stdoutTail: tail(result.stdout ?? ''),
          stderrTail: tail(result.stderr ?? ''),
        } : {}),
      })
      if (runId !== undefined) {
        await this.history.finish(job.name, runId, {
          status: outcome.status,
          endedAt: endedAt.toISOString(),
          durationMs: result?.durationMs ?? (endedAt.getTime() - firedAt.getTime()),
          sessionId: outcome.sessionId,
          sessionOpenedAt: outcome.sessionOpenedAt,
          reused: outcome.reused,
          queued: outcome.queued,
          reuseNote: outcome.reuseNote,
          archive: outcome.archive,
          error: thrown ?? outcome.error ?? result?.error,
          ...(result ? {
            outcome: describeOutcome(result, job),
            exitCode: result.exitCode ?? null,
            stdoutTail: tail(result.stdout ?? '', HISTORY_TAIL_CHARS),
            stderrTail: tail(result.stderr ?? '', HISTORY_TAIL_CHARS),
          } : {}),
        })
      }
      this.running = false
      this.current = null
      if (outcome.archive === 'pending' && runId !== undefined) this.watchArchive(outcome.sessionId, runId)
    }
  }

  /**
   * @param {Date} firedAt
   * @param {(result: import('./command.js').CommandResult) => void} keep - Receives the command result.
   */
  async runOnce(firedAt, keep) {
    const { job, logger } = this
    const result = await this.run({
      command: job.command,
      cwd: job.cwd || undefined,
      timeoutMs: (job.timeoutSeconds ?? 0) * 1000,
      signal: this.signal,
    })
    keep(result)
    this.logResult(result)
    if (!result.ok) return { status: 'failed' }
    if (!isGated(job)) return { status: 'done' }

    const decision = decideWake(result)
    if (!decision.wake) {
      logger.info('[%s] not waking agent: %s', job.name, decision.reason)
      return { status: 'idle' }
    }
    const localTime = formatLocalTime(firedAt, job.timeZone || undefined)
    const settings = agentSettings(job, this.defaults)
    const text = buildAgentPrompt({
      jobName: job.name,
      prompt: job.agent.prompt,
      stdout: result.stdout,
      droppedBytes: result.stdoutDropped,
      firedAt: localTime,
    })
    const archive = settings.autoArchive && this.settle !== undefined ? { archive: 'pending' } : {}
    let reuseNote
    const previous = this.reusableRun(settings, firedAt)
    if (previous !== undefined) {
      try {
        const sent = await this.withSessionLock(previous.sessionId, async () => {
          const delivered = await this.reuse({ sessionId: previous.sessionId, text, mayUnarchive: settings.autoArchive })
          // Inside the lock, so an earlier run's archive wait sees it was superseded.
          this.latestRun.set(previous.sessionId, null)
          return delivered
        })
        logger.info('[%s] sent the prompt to session %s%s', job.name, previous.sessionId, sent?.queued ? ' (queued behind its current turn)' : '')
        return {
          status: 'woke',
          sessionId: previous.sessionId,
          sessionOpenedAt: previous.sessionOpenedAt ?? previous.startedAt,
          reused: true,
          ...(sent?.queued ? { queued: true } : {}),
          ...archive,
        }
      } catch (error) {
        reuseNote = `session ${previous.sessionId} not reused: ${describeError(error)}`
        logger.warn('[%s] %s; opening a new session', job.name, reuseNote)
      }
    }
    try {
      const opened = await this.wake({
        text,
        title: sessionTitle(job.name, localTime),
        ...(job.agent.preset ? { agentPreset: job.agent.preset } : {}),
        ...(agentModel(job) ? { model: agentModel(job) } : {}),
        ...(settings.cwd ? { cwd: settings.cwd } : {}),
      })
      const sessionId = typeof opened === 'string' ? opened : opened.sessionId
      this.latestRun.set(sessionId, null)
      logger.info('[%s] woke agent in session %s', job.name, sessionId)
      return {
        status: 'woke',
        sessionId,
        sessionOpenedAt: firedAt.toISOString(),
        ...(reuseNote ? { reuseNote } : {}),
        ...archive,
      }
    } catch (error) {
      const reason = describeError(error)
      logger.warn('[%s] could not wake agent: %s', job.name, reason)
      return { status: 'wake-failed', error: reason, ...(reuseNote ? { reuseNote } : {}) }
    }
  }

  /**
   * The job's previous woken run whose session may take this prompt: the
   * newest run with a session, opened (first woken) within the reuse window.
   * The window counts from the session's first wake, not its latest reuse, so
   * a frequent job still starts a fresh session every `reuseWithinHours`.
   * Only sessions this plugin opened for this job are candidates.
   */
  reusableRun(settings, firedAt) {
    if (!(settings.reuseWithinHours > 0) || this.reuse === undefined) return undefined
    const previous = this.history.runs(this.job.name).find(run => run.sessionId && run.status === 'woke')
    if (previous === undefined) return undefined
    const opened = Date.parse(previous.sessionOpenedAt ?? previous.startedAt)
    if (!Number.isFinite(opened)) return undefined
    const age = firedAt.getTime() - opened
    return age >= 0 && age < settings.reuseWithinHours * HOUR_MS ? previous : undefined
  }

  /**
   * Archive a woken session once its turn is over and save the result in the
   * run's history. Runs in the background: a tick never waits for an agent.
   * A later run that sends to the same session takes over the archive.
   */
  watchArchive(sessionId, runId) {
    const { job, logger } = this
    this.latestRun.set(sessionId, runId)
    const watch = (async () => {
      const result = await this.settle(sessionId, {
        signal: this.signal,
        isLatest: () => this.latestRun.get(sessionId) === runId,
        lock: fn => this.withSessionLock(sessionId, fn),
      })
      // Unloading: leave 'pending' for the next copy of the plugin to finish.
      if (result.archive === 'pending' || this.signal?.aborted) return
      if (this.latestRun.get(sessionId) === runId) this.latestRun.delete(sessionId)
      if (result.archive === 'archived') logger.info('[%s] archived session %s', job.name, sessionId)
      else if (result.archive === 'kept') logger.info('[%s] kept session %s: %s', job.name, sessionId, result.note)
      await this.history.update(job.name, runId, { archive: result.archive, archiveNote: result.note })
    })().catch((error) => {
      logger.warn('[%s] archive of session %s failed: %s', job.name, sessionId, describeError(error))
      if (!this.signal?.aborted) return this.history.update(job.name, runId, { archive: 'kept', archiveNote: describeError(error) })
    }).finally(() => this.settling.delete(watch))
    this.settling.add(watch)
    return watch
  }

  /**
   * After a restart or config reload: finish archives an earlier copy of the
   * plugin left pending. The newest pending run of each session takes it;
   * older ones on the same session are marked superseded.
   */
  async resumeArchives() {
    if (this.settle === undefined) return
    const seen = new Set()
    for (const run of this.history.runs(this.job.name)) {
      if (run.archive !== 'pending' || !run.sessionId) continue
      if (seen.has(run.sessionId)) {
        await this.history.update(this.job.name, run.id, { archive: 'superseded' })
        continue
      }
      seen.add(run.sessionId)
      this.watchArchive(run.sessionId, run.id)
    }
  }

  /** Run fn after any earlier delivery or archive of the same session. */
  withSessionLock(sessionId, fn) {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    const tail = next.catch(() => {})
    this.locks.set(sessionId, tail)
    tail.then(() => { if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId) })
    return next
  }

  logResult(result) {
    const { job, logger } = this
    const seconds = (result.durationMs / 1000).toFixed(1)
    const outcome = describeOutcome(result, job)
    const log = result.ok ? logger.info : logger.warn
    log.call(logger, '[%s] %s in %ss', job.name, outcome, seconds)
    const out = tail(result.stdout)
    const err = tail(result.stderr)
    if (out) log.call(logger, '[%s] stdout: %s', job.name, out)
    if (err) log.call(logger, '[%s] stderr: %s', job.name, err)
  }
}

/** One-phrase result of a command run, as used in the log and run records. */
function describeOutcome(result, job) {
  if (result.error !== undefined) return `error: ${result.error}`
  if (result.timedOut) return `timed out after ${job.timeoutSeconds}s`
  if (result.aborted) return 'stopped'
  if (result.signal) return `killed by ${result.signal}`
  return `exit ${result.exitCode}`
}

function tail(text, limit = LOG_TAIL_CHARS) {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `…${trimmed.slice(-limit)}`
}

function describeError(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
