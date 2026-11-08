/**
 * The Web page's channel to the Host: one exact Fetch route per endpoint on
 * DSH's shared `/api` channel, registered with `ctx.connection.fetch.register`.
 * The page POSTs a JSON payload to `api/dsh-cron-jobs/<endpoint>` and gets
 * the handler's `{ ok, value | error }` result back as JSON.
 *
 * Not `ctx.connection.rpc.handle`: in DSH 0.2.x that call looks up the web
 * server from the Connection plugin's own context, which does not inject it,
 * so it throws for every outside plugin and no route is mounted (the page
 * then got HTTP 405 from the static file fallback). Exact `/api` routes sit
 * behind the same authentication as the rest of the Web GUI, and DSH lets
 * only the owner reach them, which this plugin needs because the endpoints
 * run shell commands.
 */
export const CHANNEL = '/api/dsh-cron-jobs'

/** Endpoints the page calls, each served at `${CHANNEL}/<endpoint>`. */
export const ENDPOINTS = Object.freeze(['list', 'runs', 'run', 'pause', 'delete'])

/** DSH answers exact `/api` routes only for the owner, so their caller is the owner. */
const OWNER = Object.freeze({ principal: Object.freeze({ kind: 'owner' }) })

/**
 * Exact Fetch routes for `ctx.connection.fetch.register`.
 * @param {ReturnType<typeof createRpcHandler>} handler
 * @returns {{ path: string, methods: ['POST'], requestBody: 'buffered', fetch: (request: Request) => Promise<Response> }[]}
 */
export function createRoutes(handler) {
  return ENDPOINTS.map(endpoint => ({
    path: `${CHANNEL}/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let payload
      try {
        const text = await request.text()
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        return Response.json(failure('bad-request', 'The request body is not JSON.'), { status: 400 })
      }
      return Response.json(await handler(endpoint, payload, request.signal, OWNER))
    },
  }))
}

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
        if (result.ok) return success({ job: result.job })
        if (result.code === 'ended') return failure('ended', 'This job has no more runs.')
        return notFound(input)
      }
      case 'delete': {
        // Only jobs created with the tools; config jobs are changed in the config.
        try {
          return success(await jobs.remove(nameOf(input)))
        } catch (error) {
          if (error?.code === 'read_only') return failure('read-only', 'This job is defined in the plugin config; remove it there.')
          if (error?.code === 'not_found') return notFound(input)
          throw error
        }
      }
      default:
        return failure('not-found', `Unknown endpoint ${JSON.stringify(endpoint)}.`)
    }
  }
}

/** The job's id (for config jobs, its name); older pages send `name`. */
function nameOf(input) {
  if (typeof input.id === 'string') return input.id
  return typeof input.name === 'string' ? input.name : ''
}

function success(value) {
  return { ok: true, value }
}

function failure(code, message) {
  return { ok: false, error: { code: `cron-jobs/${code}`, message, details: {} } }
}

function notFound(input) {
  return failure('not-found', `No job ${JSON.stringify(nameOf(input))}.`)
}
