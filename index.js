/**
 * DeepSeek Harness Host plugin: run shell commands on cron schedules inside
 * the Host process, and optionally open an agent session when a gate
 * command's output asks for one.
 */
import { Config } from './src/config.js'
import { runCommand } from './src/command.js'
import { openAgentSession } from './src/session.js'
import { startJobs } from './src/scheduler.js'

export const name = 'dsh-cron-jobs'
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ jobs: import('./src/job.js').Job[] }} config
 */
export function apply(ctx, config) {
  const logger = ctx.logger('cron-jobs')
  ctx.effect(() => {
    // Aborting stops commands still running when the plugin unloads.
    const controller = new AbortController()
    const scheduled = startJobs({
      jobs: config.jobs ?? [],
      logger,
      run: runCommand,
      wake: request => openAgentSession(ctx, request, logger),
      signal: controller.signal,
    })
    return () => {
      scheduled.stop()
      controller.abort()
    }
  }, 'cron-jobs.schedule()')
}
