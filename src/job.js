import { decideWake } from './wake.js'
import { buildAgentPrompt, formatLocalTime, sessionTitle } from './prompt.js'

/** Characters of stdout/stderr shown in the log after each run. */
export const LOG_TAIL_CHARS = 400

/**
 * Whether a job wakes an agent: it has an `agent` block with a prompt.
 * @param {Job} job
 */
export function isGated(job) {
  return typeof job.agent?.prompt === 'string' && job.agent.prompt.trim() !== ''
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
 * @property {{ prompt?: string, preset?: string, cwd?: string }} [agent]
 */
export class JobRunner {
  /**
   * @param {Job} job
   * @param {object} deps
   * @param {(options: object) => Promise<import('./command.js').CommandResult>} deps.run - Runs a command.
   * @param {(request: { text: string, title: string, agentPreset?: string, cwd?: string }) => Promise<string>} deps.wake - Opens an agent session; resolves to its id.
   * @param {{ info: Function, warn: Function }} deps.logger
   * @param {AbortSignal} [deps.signal] - Stops a running command when aborted.
   * @param {(entry: object) => Promise<void>} [deps.record] - Appends a run record (see runlog.js).
   * @param {() => Date} [deps.now]
   */
  constructor(job, { run, wake, logger, signal, record = async () => {}, now = () => new Date() }) {
    this.job = job
    this.record = record
    this.run = run
    this.wake = wake
    this.logger = logger
    this.signal = signal
    this.now = now
    this.running = false
  }

  /**
   * Run the job once.
   * @returns {Promise<{ status: 'skipped' | 'done' | 'failed' | 'idle' | 'woke' | 'wake-failed', sessionId?: string }>}
   */
  async tick() {
    const { job, logger } = this
    if (this.running) {
      logger.warn('[%s] previous run still going; skipping this tick', job.name)
      await this.record({ time: this.now().toISOString(), job: job.name, event: 'skipped' })
      return { status: 'skipped' }
    }
    this.running = true
    const firedAt = this.now()
    let result
    let outcome = { status: 'failed' }
    let thrown
    try {
      logger.info('[%s] start', job.name)
      // A start line on its own shows a run that never finished (DSH stopped mid-run).
      await this.record({ time: firedAt.toISOString(), job: job.name, event: 'start' })
      outcome = await this.runOnce(firedAt, r => { result = r })
      return outcome
    } catch (error) {
      thrown = describeError(error)
      throw error
    } finally {
      this.running = false
      await this.record({
        time: this.now().toISOString(),
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
    try {
      const sessionId = await this.wake({
        text: buildAgentPrompt({
          jobName: job.name,
          prompt: job.agent.prompt,
          stdout: result.stdout,
          droppedBytes: result.stdoutDropped,
          firedAt: localTime,
        }),
        title: sessionTitle(job.name, localTime),
        ...(job.agent.preset ? { agentPreset: job.agent.preset } : {}),
        ...(job.agent.cwd || job.cwd ? { cwd: job.agent.cwd || job.cwd } : {}),
      })
      logger.info('[%s] woke agent in session %s', job.name, sessionId)
      return { status: 'woke', sessionId }
    } catch (error) {
      logger.warn('[%s] could not wake agent: %s', job.name, describeError(error))
      return { status: 'wake-failed' }
    }
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

function tail(text) {
  const trimmed = text.trim()
  if (trimmed.length <= LOG_TAIL_CHARS) return trimmed
  return `…${trimmed.slice(-LOG_TAIL_CHARS)}`
}

function describeError(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
