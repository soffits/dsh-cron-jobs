/**
 * DeepSeek Harness Host plugin: run shell commands on cron schedules inside
 * the Host process, and optionally open an agent session when a gate
 * command's output asks for one. Run history and pause state are kept in
 * DSH's storage domain service, as are jobs created with the model-facing
 * tools (tools.js), which reach the running scheduler through the
 * `cronJobs` service provided here. The "Cron tasks" Web page (client.js)
 * reads and controls jobs over authenticated routes on DSH's /api channel.
 */
import { Config } from './src/config.js'
import { runCommand } from './src/command.js'
import { archiveWhenIdle, deliverToSession, openAgentSession } from './src/session.js'
import { CronJobs } from './src/controller.js'
import { createRunLog } from './src/runlog.js'
import { openHistory } from './src/history.js'
import { createRoutes, createRpcHandler } from './src/rpc.js'

export const name = 'dsh-cron-jobs'
export const inject = ['storageDomain']
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ jobs: import('./src/job.js').Job[], runLog?: string, historyRecords?: number, defaultAgentCwd?: string, autoArchive?: boolean, reuseWithinHours?: number }} config
 */
export function apply(ctx, config) {
  const logger = ctx.logger('cron-jobs')
  let current

  // The tools plugin looks this up at call time; `controller()` is undefined
  // while the jobs start or stop.
  ctx.provide?.('cronJobs', Object.freeze({ controller: () => current }))

  ctx.effect(() => {
    // Aborting stops commands still running when the plugin unloads.
    const controller = new AbortController()
    let jobs
    let history
    const ready = (async () => {
      history = await openHistory(ctx.storageDomain, {
        limit: config.historyRecords, logger, signal: controller.signal,
      })
      if (controller.signal.aborted) return
      jobs = new CronJobs({
        jobs: config.jobs ?? [],
        logger,
        run: runCommand,
        wake: request => openAgentSession(ctx, request, logger),
        reuse: request => deliverToSession(ctx, request),
        settle: (sessionId, options) => archiveWhenIdle(ctx, sessionId, options),
        defaults: {
          agentCwd: config.defaultAgentCwd || undefined,
          autoArchive: config.autoArchive ?? true,
          reuseWithinHours: config.reuseWithinHours ?? 0,
        },
        signal: controller.signal,
        record: createRunLog(config.runLog || undefined, logger),
        history,
      }).start()
      current = jobs
    })().catch(error => logger.error('cron jobs not started: %s', error instanceof Error ? error.message : String(error)))
    return async () => {
      current = undefined
      // Stop the timers first so no new run starts with an aborted signal.
      const stopping = jobs?.stop()
      controller.abort()
      await ready
      // Let ended runs save their outcome before the storage closes.
      await (stopping ?? jobs?.stop())
      await history?.close()
    }
  }, 'cron-jobs.schedule()')

  // The Web page's routes; present only in hosts that serve the Web GUI.
  // Exact /api Fetch routes, not connection.rpc.handle: see src/rpc.js.
  ctx.inject(['connection', 'webServer'], (sub) => {
    for (const route of createRoutes(createRpcHandler(() => current))) sub.connection.fetch.register(route)
  })
}
