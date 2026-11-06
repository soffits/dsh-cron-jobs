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
   * @param {() => Date} [deps.now]
   */
  constructor(job, { run, wake, logger, signal, now = () => new Date() }) {
    this.job = job
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
      return { status: 'skipped' }
    }
    this.running = true
    try {
      const firedAt = this.now()
      logger.info('[%s] start', job.name)
      const result = await this.run({
        command: job.command,
        cwd: job.cwd || undefined,
        timeoutMs: (job.timeoutSeconds ?? 0) * 1000,
        signal: this.signal,
      })
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
    } finally {
      this.running = false
    }
  }

  logResult(result) {
    const { job, logger } = this
    const seconds = (result.durationMs / 1000).toFixed(1)
    let outcome
    if (result.error !== undefined) outcome = `error: ${result.error}`
    else if (result.timedOut) outcome = `timed out after ${job.timeoutSeconds}s`
    else if (result.aborted) outcome = 'stopped'
    else if (result.signal) outcome = `killed by ${result.signal}`
    else outcome = `exit ${result.exitCode}`
    const log = result.ok ? logger.info : logger.warn
    log.call(logger, '[%s] %s in %ss', job.name, outcome, seconds)
    const out = tail(result.stdout)
    const err = tail(result.stderr)
    if (out) log.call(logger, '[%s] stdout: %s', job.name, out)
    if (err) log.call(logger, '[%s] stderr: %s', job.name, err)
  }
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
