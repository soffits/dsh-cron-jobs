/**
 * DeepSeek Harness Host plugin: run shell commands on cron schedules inside
 * the Host process, and optionally open an agent session when a gate
 * command's output asks for one. Run history and pause state are kept in
 * DSH's storage domain service, as are jobs created with the model-facing
 * tools (tools.js), which reach the running scheduler through the
 * `cronJobs` service provided here. The "Cron tasks" Web page (client.js)
 * reads and controls jobs over authenticated routes on DSH's /api channel.
 * Results are delivered through whichever service a job's delivery target
 * names, looked up with `ctx.get()` when a result is ready (src/deliver.js).
 * Events from the inbox directory (src/spool.js, bin/dsh-cron-event.js) and
 * from supervised watchers (src/watchers.js) start the jobs subscribed to
 * their channel (src/events.js).
 */
import { Config } from './src/config.js'
import { runCommand } from './src/command.js'
import { archiveWhenIdle, deliverToSession, openAgentSession, waitForAnswer } from './src/session.js'
import { sendMessage } from './src/deliver.js'
import { CronJobs } from './src/controller.js'
import { createAnswerChecks } from './src/answer-check.js'
import { createRunLog } from './src/runlog.js'
import { openHistory } from './src/history.js'
import { createRoutes, createRpcHandler } from './src/rpc.js'
import { createEventSpool } from './src/spool.js'
import { defaultEventDir, defaultWatcherStateRoot } from './src/events.js'

/** Set once per DSH process, so `dsh.started` means a DSH start, not a plugin reload. */
const STARTED = Symbol.for('@soffits/dsh-cron-jobs/started')

export const name = 'dsh-cron-jobs'
export const inject = ['storageDomain']
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ jobs: import('./src/job.js').Job[], watchers?: object[], events?: { coalesceSeconds?: number, maxRunsPerHour?: number }, runLog?: string, historyRecords?: number, defaultAgentCwd?: string, autoArchive?: boolean, reuseWithinHours?: number, deliver?: { via?: string, to?: string } }} config
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
    let checks
    let spool
    // A job's answerCheck runs as the turn its prompt started is about to close.
    const stopTurnHook = ctx.on?.('agent/turn-stopping', payload => checks?.onTurnStopping(payload))
    const ready = (async () => {
      history = await openHistory(ctx.storageDomain, {
        limit: config.historyRecords, logger, signal: controller.signal,
      })
      if (controller.signal.aborted) return
      const record = createRunLog(config.runLog || undefined, logger)
      checks = createAnswerChecks({ run: runCommand, logger, record })
      jobs = new CronJobs({
        jobs: config.jobs ?? [],
        logger,
        run: runCommand,
        wake: request => openAgentSession(ctx, request, logger),
        reuse: request => deliverToSession(ctx, request),
        settle: (sessionId, options) => archiveWhenIdle(ctx, sessionId, options),
        // The channel is found by name at send time, so it may load after
        // this plugin, reload, or be missing for a while (the delivery waits).
        send: (target, message, from, options) => sendMessage({ lookup: name => ctx.get(name), target, message, from, signal: controller.signal, ...options }),
        answer: (sessionId, messageId, options) => waitForAnswer(ctx, sessionId, messageId, options),
        checks,
        defaults: {
          agentCwd: config.defaultAgentCwd || undefined,
          autoArchive: config.autoArchive ?? true,
          reuseWithinHours: config.reuseWithinHours ?? 0,
          deliver: config.deliver,
        },
        signal: controller.signal,
        record,
        history,
        events: config.events,
        watchers: config.watchers ?? [],
        watcherOptions: { stateRoot: defaultWatcherStateRoot() },
      }).start()
      current = jobs
      // Once per process: jobs waiting for a DSH restart run now.
      if (!globalThis[STARTED]) {
        globalThis[STARTED] = true
        jobs.emit({ channel: 'dsh.started', source: 'dsh', data: { processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() } })
      }
      if (controller.signal.aborted) return
      spool = createEventSpool({
        dir: defaultEventDir(),
        handle: (input, ack) => jobs.emit(input, ack),
        onError: error => logger.warn('event inbox: %s', error instanceof Error ? error.message : String(error)),
      })
      await spool.start()
    })().catch(error => logger.error('cron jobs not started: %s', error instanceof Error ? error.message : String(error)))
    return async () => {
      current = undefined
      stopTurnHook?.()
      // Stop reading events first, so none reaches a stopping scheduler.
      await spool?.stop()
      // Stop the timers first so no new run starts with an aborted signal.
      const stopping = jobs?.stop()
      controller.abort()
      await ready
      await spool?.stop()
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
