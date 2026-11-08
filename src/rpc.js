/**
 * The Web page's channel to the Host, carried by DSH's Connection service:
 * the page calls `ctx.connection.rpc.call(CHANNEL, endpoint, payload)` and
 * the Host answers through `ctx.connection.rpc.handle(CHANNEL, handler)`.
 * Connection authenticates every request; this handler additionally accepts
 * only the owner, because the endpoints run shell commands.
 */
export const CHANNEL = '/dsh-cron-jobs'

/**
 * @param {() => import('./controller.js').CronJobs | undefined} current - The running jobs, or undefined while starting or stopped.
 * @returns {(endpoint: string, payload: unknown, signal: AbortSignal, peer?: { principal?: { kind?: string } }) => Promise<object>}
 */
export function createRpcHandler(current) {
  return async (endpoint, payload, _signal, peer) => {
    if (peer?.principal?.kind !== 'owner') return failure('forbidden', 'Only the owner can manage cron jobs.')
    const jobs = current()
    if (jobs === undefined) return failure('unavailable', 'Cron jobs are starting or stopping; try again shortly.')
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    switch (endpoint) {
      case 'list':
        return success({
          jobs: jobs.list(),
          historyRecords: jobs.history?.limit ?? null,
          historyDurable: jobs.history?.durable === true,
          now: new Date().toISOString(),
        })
      case 'runs': {
        const runs = jobs.runs(nameOf(input))
        return runs === undefined ? notFound(input) : success({ runs })
      }
      case 'run': {
        const result = jobs.runNow(nameOf(input))
        if (result.ok) return success({ startedAt: result.startedAt })
        if (result.code === 'busy') return failure('busy', 'This job is already running.')
        if (result.code === 'stopped') return failure('unavailable', 'Cron jobs are stopping.')
        return notFound(input)
      }
      case 'pause': {
        if (typeof input.paused !== 'boolean') return failure('bad-request', '`paused` must be true or false.')
        const result = await jobs.setPaused(nameOf(input), input.paused)
        return result.ok ? success({ job: result.job }) : notFound(input)
      }
      default:
        return failure('not-found', `Unknown endpoint ${JSON.stringify(endpoint)}.`)
    }
  }
}

function nameOf(input) {
  return typeof input.name === 'string' ? input.name : ''
}

function success(value) {
  return { ok: true, value }
}

function failure(code, message) {
  return { ok: false, error: { code: `cron-jobs/${code}`, message, details: {} } }
}

function notFound(input) {
  return failure('not-found', `No job named ${JSON.stringify(nameOf(input))}.`)
}
