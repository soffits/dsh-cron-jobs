import { Cron } from 'croner'
import { JobRunner, agentModel, isGated } from './job.js'

/**
 * Owns every configured job: one runner per unique job name, a cron timer for
 * each enabled job with a valid schedule, pause and resume, manual runs, and
 * the read model the Web page shows.
 *
 * Job state, as shown to the user:
 * - `active`: scheduled and running on its cron timer.
 * - `paused`: paused from the page; the timer is held and the pause is saved.
 * - `disabled`: `enabled: false` in the plugin config. Config wins over a
 *   saved pause, which only applies again once the job is enabled.
 * - `invalid`: the cron expression or time zone could not be parsed.
 * Every state still allows a manual run.
 */
export class CronJobs {
  /**
   * @param {object} options
   * @param {import('./job.js').Job[]} options.jobs
   * @param {{ info: Function, warn: Function, error: Function }} options.logger
   * @param {Function} options.run - Command runner, see {@link import('./command.js').runCommand}.
   * @param {Function} options.wake - Agent session opener.
   * @param {AbortSignal} [options.signal] - Stops running commands when aborted.
   * @param {(entry: object) => Promise<void>} [options.record] - Run log, see runlog.js.
   * @param {import('./history.js').HistoryStore} [options.history] - Saved runs and pause state.
   * @param {typeof Cron} [options.CronClass] - Replaceable for tests.
   * @param {() => Date} [options.now]
   */
  constructor({ jobs, logger, run, wake, signal, record, history, CronClass = Cron, now = () => new Date() }) {
    this.logger = logger
    this.history = history
    this.CronClass = CronClass
    this.now = now
    /** @type {Map<string, { job: object, runner: JobRunner, timer?: Cron, error?: string }>} */
    this.entries = new Map()
    this.inflight = new Set()
    this.stopped = false
    for (const job of jobs) {
      if (this.entries.has(job.name)) {
        logger.error('[%s] duplicate job name; this copy is not scheduled', job.name)
        continue
      }
      const runner = new JobRunner(job, { run, wake, logger, signal, record, history, now })
      this.entries.set(job.name, { job, runner })
    }
  }

  /** Arm the timers of enabled jobs; paused jobs start held. */
  start() {
    for (const entry of this.entries.values()) {
      const { job } = entry
      if (job.enabled === false) continue
      let timer
      try {
        timer = new this.CronClass(job.cron, { timezone: job.timeZone || undefined }, () => {
          if (this.isPaused(job.name)) return
          this.track(entry.runner.tick(), job.name)
        })
        if (this.isPaused(job.name)) timer.pause?.()
      } catch (error) {
        timer?.stop()
        entry.error = error instanceof Error ? error.message : String(error)
        this.logger.error('[%s] not scheduled: %s', job.name, entry.error)
        continue
      }
      entry.timer = timer
      const next = this.nextRun(entry)
      this.logger.info('[%s] scheduled "%s"%s, %s', job.name, job.cron,
        job.timeZone ? ` (${job.timeZone})` : '',
        this.isPaused(job.name) ? 'paused' : `next run ${next ? next.toISOString() : 'never'}`)
    }
    return this
  }

  /** Runners of the jobs that have a timer. */
  scheduledRunners() {
    const runners = new Map()
    for (const [name, entry] of this.entries) if (entry.timer) runners.set(name, entry.runner)
    return runners
  }

  /**
   * Stop every timer, then wait for runs in progress to end. Running commands
   * stop when the abort signal given to the runners fires.
   */
  async stop() {
    this.stopped = true
    for (const entry of this.entries.values()) entry.timer?.stop()
    await Promise.allSettled([...this.inflight])
  }

  isPaused(name) {
    return this.history?.paused(name) === true
  }

  /** The job list for the page. */
  list() {
    return [...this.entries.values()].map(entry => this.view(entry))
  }

  /** Runs of one job, newest first, or undefined for an unknown job. */
  runs(name) {
    if (!this.entries.has(name)) return undefined
    return this.history?.runs(name) ?? []
  }

  /**
   * Start one run now, outside the schedule. Allowed in every state.
   * @returns {{ ok: true, startedAt: string } | { ok: false, code: 'not-found' | 'busy' | 'stopped' }}
   */
  runNow(name) {
    const entry = this.entries.get(name)
    if (entry === undefined) return { ok: false, code: 'not-found' }
    if (this.stopped) return { ok: false, code: 'stopped' }
    if (entry.runner.running) return { ok: false, code: 'busy' }
    this.track(entry.runner.tick({ trigger: 'manual' }), name)
    return { ok: true, startedAt: entry.runner.current.startedAt }
  }

  /**
   * Pause or resume a job's schedule; the choice is saved and survives restarts.
   * A run in progress is not stopped.
   * @returns {Promise<{ ok: true, job: object } | { ok: false, code: 'not-found' }>}
   */
  async setPaused(name, paused) {
    const entry = this.entries.get(name)
    if (entry === undefined) return { ok: false, code: 'not-found' }
    await this.history?.setPaused(name, paused, this.now())
    if (entry.timer) {
      if (paused) entry.timer.pause?.()
      else entry.timer.resume?.()
    }
    this.logger.info('[%s] %s', name, paused ? 'paused' : 'resumed')
    return { ok: true, job: this.view(entry) }
  }

  view(entry) {
    const { job, runner, timer, error } = entry
    const paused = this.isPaused(job.name)
    const state = job.enabled === false ? 'disabled' : error !== undefined ? 'invalid' : paused ? 'paused' : 'active'
    const next = state === 'active' ? this.nextRun(entry) : null
    return {
      name: job.name,
      state,
      ...(error !== undefined ? { error } : {}),
      paused,
      pausedAt: this.history?.state(job.name).pausedAt ?? null,
      cron: job.cron,
      timeZone: job.timeZone || null,
      command: job.command,
      cwd: job.cwd || null,
      timeoutSeconds: job.timeoutSeconds ?? 0,
      gated: isGated(job),
      agent: isGated(job)
        ? { prompt: job.agent.prompt, preset: job.agent.preset || null, cwd: job.agent.cwd || job.cwd || null, model: agentModel(job) ?? null }
        : null,
      nextRunAt: next ? next.toISOString() : null,
      running: runner.current,
      lastRun: this.history?.lastRun(job.name) ?? null,
      scheduled: timer !== undefined,
    }
  }

  nextRun(entry) {
    try {
      return entry.timer?.nextRun() ?? null
    } catch {
      return null
    }
  }

  track(promise, name) {
    const tracked = promise
      .catch(error => this.logger.error('[%s] run failed: %s', name, String(error)))
      .finally(() => this.inflight.delete(tracked))
    this.inflight.add(tracked)
    return tracked
  }
}
