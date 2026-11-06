import { Cron } from 'croner'
import { JobRunner } from './job.js'

/**
 * Arm a cron timer for every enabled job. A job whose cron expression or time
 * zone is invalid is logged and left out; the others still run.
 *
 * @param {object} options
 * @param {import('./job.js').Job[]} options.jobs
 * @param {{ info: Function, warn: Function, error: Function }} options.logger
 * @param {Function} options.run - Command runner, see {@link import('./command.js').runCommand}.
 * @param {Function} options.wake - Agent session opener.
 * @param {AbortSignal} [options.signal] - Stops running commands when aborted.
 * @param {(entry: object) => Promise<void>} [options.record] - Run recorder, see {@link import('./runlog.js').createRunLog}.
 * @param {typeof Cron} [options.CronClass] - Replaceable for tests.
 * @returns {{ runners: Map<string, JobRunner>, stop: () => void }}
 */
export function startJobs({ jobs, logger, run, wake, signal, record, CronClass = Cron }) {
  const timers = []
  const runners = new Map()
  for (const job of jobs) {
    if (job.enabled === false) continue
    if (runners.has(job.name)) {
      logger.error('[%s] duplicate job name; this copy is not scheduled', job.name)
      continue
    }
    const runner = new JobRunner(job, { run, wake, logger, signal, record })
    let timer
    let next
    try {
      timer = new CronClass(job.cron, { timezone: job.timeZone || undefined }, () => {
        runner.tick().catch(error => logger.error('[%s] run failed: %s', job.name, String(error)))
      })
      next = timer.nextRun()
    } catch (error) {
      timer?.stop()
      logger.error('[%s] not scheduled: %s', job.name, error instanceof Error ? error.message : String(error))
      continue
    }
    runners.set(job.name, runner)
    timers.push(timer)
    logger.info('[%s] scheduled "%s"%s, next run %s', job.name, job.cron,
      job.timeZone ? ` (${job.timeZone})` : '', next ? next.toISOString() : 'never')
  }
  return {
    runners,
    stop() {
      for (const timer of timers) timer.stop()
    },
  }
}
