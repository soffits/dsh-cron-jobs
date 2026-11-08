import { CronJobs } from './controller.js'

/**
 * Arm a cron timer for every enabled job. A job whose cron expression or time
 * zone is invalid is logged and left out; the others still run.
 *
 * A thin wrapper over {@link CronJobs} for callers that only need timers.
 *
 * @param {object} options
 * @param {import('./job.js').Job[]} options.jobs
 * @param {{ info: Function, warn: Function, error: Function }} options.logger
 * @param {Function} options.run - Command runner, see {@link import('./command.js').runCommand}.
 * @param {Function} options.wake - Agent session opener.
 * @param {AbortSignal} [options.signal] - Stops running commands when aborted.
 * @param {(entry: object) => Promise<void>} [options.record] - Run recorder, see {@link import('./runlog.js').createRunLog}.
 * @param {Function} [options.CronClass] - Replaceable for tests.
 * @returns {{ runners: Map<string, import('./job.js').JobRunner>, stop: () => void }}
 */
export function startJobs(options) {
  const jobs = new CronJobs(options).start()
  return {
    runners: jobs.scheduledRunners(),
    stop() {
      jobs.stop()
    },
  }
}
