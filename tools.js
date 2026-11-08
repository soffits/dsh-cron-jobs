/**
 * Model-facing tools for dsh-cron-jobs: create, change, list and view
 * scheduled jobs from a conversation.
 *
 * A separate plugin entry from the scheduler (index.js), so it can be
 * mounted globally or in one agent preset, and so that reloading the
 * scheduler (for example after a config change) never unregisters the tools:
 * the scheduler is looked up as the `cronJobs` service at call time.
 */
import z from '@deepseek-ai/schemastery'
import { formatLocalTime } from './src/prompt.js'

export const name = 'dsh-cron-jobs-tools'
export const inject = ['tools']

export const Config = z.object({
  prefix: z.string().default('cron_job')
    .description('Tool name prefix: <prefix>_create, _edit, _list and _view. "schedule" gives the names of DSH\'s built-in Schedule tools, for use in its place.'),
})

/** Runs shown by the view tool, and characters of each output tail. */
export const VIEW_RUNS = 5
export const VIEW_TAIL_CHARS = 300

const RRULE_HELP = 'RFC 5545 schedule: one DTSTART line, a newline, and one RRULE line. DTSTART ends in Z for UTC or carries TZID with an IANA zone, and local clock time is kept across daylight-saving changes. A DTSTART in the past is fine: runs start with the first occurrence after now. COUNT is at most 1000; use UNTIL (a UTC instant ending in Z) for longer rules. MINUTELY and HOURLY take no BY parts, so pick clock times with DAILY or WEEKLY plus BYHOUR and BYMINUTE. Example: "DTSTART;TZID=America/Toronto:20261109T100000\\nRRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261215T150000Z".'

/**
 * @param {string} prefix
 * @returns {Record<string, object>} JSON Schema of each tool's parameters.
 */
export function toolSchemas(prefix) {
  const schedule = {
    cron: { type: 'string', description: 'Cron expression, 5 fields (6 with seconds first), read in timeZone.' },
    rrule: { type: 'string', description: RRULE_HELP },
    at: { type: 'string', description: 'Run once at this time: ISO 8601 with an offset (2026-11-20T09:00:00-05:00), or without one (2026-11-20T09:00) read in timeZone.' },
  }
  const fields = {
    prompt: { type: 'string', description: 'Instruction delivered to the target session at each run, as a scheduled message from the user. Required unless command is set.' },
    command: { type: 'string', description: 'Shell command run with bash in cwd at each run. With a prompt it is a gate: the prompt is delivered only when stdout is not empty and its last line is not {"wakeAgent": false}, with stdout appended. Without a prompt no agent is involved.' },
    target: {
      type: 'string',
      enum: ['this_session', 'new_once', 'new'],
      description: 'Where the prompt goes; defaults to new. this_session: this session, for reminders and follow-ups to this conversation. new_once: one new session, opened by the first run and used by every later run. new: a new session for each run, archived once its turn ends. New sessions use cwd and this session\'s agent preset.',
    },
    sessionId: { type: 'string', description: 'Deliver to this other existing session instead of target.' },
    cwd: { type: 'string', description: 'Working directory of the command and of new sessions; defaults to this session\'s.' },
  }
  return {
    create: object({
      title: { type: 'string', description: 'Job name in the user\'s language, at most 200 characters: action plus object, without timing or status.' },
      ...fields,
      ...schedule,
      timeZone: { type: 'string', description: 'IANA zone such as America/Toronto. Required with cron and with an at without offset; rrule takes its zone from DTSTART.' },
    }, ['title']),
    edit: object({
      id: { type: 'string', description: 'Job id.' },
      action: {
        type: 'string',
        enum: ['update', 'pause', 'resume', 'delete'],
        description: 'update changes the given fields; pause holds the schedule; resume continues it from now; delete removes the job and its run history.',
      },
      title: { type: 'string', description: 'New job name.' },
      prompt: { ...fields.prompt, description: 'New prompt; an empty string removes it.' },
      command: { ...fields.command, description: 'New command; an empty string removes it.' },
      ...schedule,
      timeZone: { type: 'string', description: `Zone for a new cron or at, as in ${prefix}_create; given alone, it moves a cron schedule to this zone.` },
      target: { ...fields.target, description: `New target, as in ${prefix}_create.` },
      sessionId: fields.sessionId,
      cwd: { type: 'string', description: 'New working directory of the command and of new sessions.' },
    }, ['id', 'action']),
    list: object({}, []),
    view: object({ id: { type: 'string', description: 'Job id.' } }, ['id']),
  }
}

function object(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/**
 * Tool definitions. `getJobs` answers the running scheduler, or undefined
 * while it starts or reloads; `ctx` reads Host services for session checks.
 */
export function createTools({ prefix = 'cron_job', getJobs, ctx }) {
  const schemas = toolSchemas(prefix)
  const tool = (suffix, description, execute, title, kind) => ({
    name: `${prefix}_${suffix}`,
    description,
    parameters: schemas[suffix],
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const problem = checkArgs(schemas[suffix], args)
      if (problem) return failure('invalid_arguments', problem)
      const jobs = getJobs()
      if (jobs === undefined) return failure('unavailable', 'The scheduler is starting or reloading; try again in a few seconds.')
      try {
        return await execute(args ?? {}, jobs, exec?.agent)
      } catch (error) {
        if (typeof error?.code === 'string' && error instanceof Error) return failure(error.code, error.message)
        throw error
      }
    },
    presentCall: args => ({ card: 'generic', title, kind, ...(args?.title ?? args?.id ? { rawInput: args.title ?? args.id } : {}) }),
  })

  return [
    tool('create',
      'Create a scheduled job. Each run executes command and/or delivers prompt to the target session as a scheduled message from the user. Give exactly one of cron, rrule or at. Returns the job with its id and next run. A run missed while DSH was down happens once at startup.',
      async (args, jobs, agent) => modelJob(await jobs.create({
        title: args.title,
        prompt: args.prompt,
        command: args.command,
        schedule: { cron: args.cron, rrule: args.rrule, at: args.at, timeZone: args.timeZone },
        cwd: args.cwd || callerCwd(agent),
        preset: callerPreset(agent),
        target: await resolveTarget(ctx, agent, args.target ?? 'new', args.sessionId),
        createdBy: agent?.session?.id,
      })),
      'Create scheduled job', 'other'),
    tool('edit',
      `Update, pause, resume or delete one job created with ${prefix}_create, by id. Jobs from the plugin config are read-only.`,
      async (args, jobs, agent) => {
        const { id, action } = args
        const changes = ['title', 'prompt', 'command', 'cron', 'rrule', 'at', 'timeZone', 'target', 'sessionId', 'cwd'].filter(key => args[key] !== undefined)
        if (action !== 'update' && changes.length > 0) return failure('invalid_arguments', `${action} takes only id and action.`)
        if (action === 'delete') return await jobs.remove(id)
        if (action === 'pause' || action === 'resume') {
          jobs.storedEntry(id)
          const result = await jobs.setPaused(id, action === 'pause')
          if (!result.ok) return failure('invalid_state', 'The job has ended; give it a new schedule with action update.')
          return modelJob(result.job)
        }
        if (changes.length === 0) return failure('invalid_arguments', 'update needs at least one field to change.')
        const scheduleGiven = ['cron', 'rrule', 'at', 'timeZone'].some(key => args[key] !== undefined)
        const targetGiven = args.target !== undefined || args.sessionId !== undefined
        return modelJob(await jobs.update(id, {
          title: args.title,
          prompt: args.prompt,
          command: args.command,
          cwd: args.cwd,
          ...(scheduleGiven ? { schedule: { cron: args.cron, rrule: args.rrule, at: args.at, timeZone: args.timeZone } } : {}),
          ...(targetGiven ? { target: await resolveTarget(ctx, agent, args.target ?? 'new', args.sessionId) } : {}),
        }))
      },
      'Edit scheduled job', 'other'),
    tool('list',
      `List every scheduled job, from tools and from the plugin config, with id, title, state, schedule, next run, target and last run. ${prefix}_view shows the prompt, command and recent runs.`,
      async (_args, jobs) => ({ jobs: jobs.list().map(job => modelJob(job, { brief: true })) }),
      'List scheduled jobs', 'read'),
    tool('view',
      `View one job by id: its full definition and its ${VIEW_RUNS} latest runs.`,
      async ({ id }, jobs) => {
        const job = jobs.get(id)
        if (job === undefined) return failure('not_found', `No job with id ${JSON.stringify(id)}.`)
        return { ...modelJob(job), recentRuns: (jobs.runs(id) ?? []).slice(0, VIEW_RUNS).map(modelRun) }
      },
      'View scheduled job', 'read'),
  ]
}

/**
 * Register the tools. Mounted globally (the bundle's default) every agent
 * gets them; mounted in a preset, only that preset's agents do.
 */
export function apply(ctx, config = {}) {
  for (const definition of createTools({ prefix: config.prefix || 'cron_job', getJobs: () => ctx.get('cronJobs')?.controller(), ctx })) {
    ctx.tools.register(definition)
  }
}

/** Where a job's prompt goes, from the tool's target choice. */
async function resolveTarget(ctx, agent, target, sessionId) {
  if (sessionId) {
    await requireSession(ctx, sessionId)
    return { kind: 'session', sessionId }
  }
  if (target === 'this_session') {
    const own = agent?.session?.id
    if (!own) throw codeError('invalid_target', 'This call has no session to deliver to; use new or new_once.')
    if (delegationDepth(agent) > 0) throw codeError('invalid_target', 'A subagent session cannot be a target; use new or new_once, or pass the parent session as sessionId.')
    return { kind: 'session', sessionId: own }
  }
  return { kind: target }
}

async function requireSession(ctx, sessionId) {
  if (ctx?.get?.('agents')?.get?.(sessionId) !== undefined) return
  const persistence = ctx?.get?.('sessionPersistence')
  if (persistence?.stat === undefined) return
  const stored = await persistence.stat(sessionId).catch(() => undefined)
  if (stored === undefined) throw codeError('invalid_target', `No session ${JSON.stringify(sessionId)}.`)
}

function delegationDepth(agent) {
  return Math.max(agent?.session?.header?.delegationDepth ?? 0, agent?.options?.subagentDepth ?? 0)
}

function callerCwd(agent) {
  return agent?.session?.header?.cwd || undefined
}

function callerPreset(agent) {
  try {
    return agent?.ctx?.get?.('agentPresets')?.composedPreset?.(agent.ctx) || undefined
  } catch {
    return undefined
  }
}

/** A job as the model sees it. `brief` leaves out the prompt and command text. */
export function modelJob(job, { brief = false } = {}) {
  const zone = job.timeZone ?? undefined
  return {
    id: job.id,
    title: job.name,
    source: job.source,
    kind: job.kind,
    state: job.state,
    ...(job.error ? { error: job.error } : {}),
    schedule: job.schedule?.text ?? null,
    ...(job.nextRunAt ? { nextRunAt: job.nextRunAt, nextRunAtLocal: `${formatLocalTime(new Date(job.nextRunAt), zone)}${zone ? ` ${zone}` : ''}` } : { nextRunAt: null }),
    ...(job.target ? { target: job.target.sessionId ? `${job.target.kind} ${job.target.sessionId}` : job.target.kind } : {}),
    ...(brief ? {} : {
      ...(job.agent ? { prompt: job.agent.prompt, preset: job.agent.preset, sessionCwd: job.agent.cwd } : {}),
      ...(job.command ? { command: job.command, cwd: job.cwd } : {}),
      ...(job.createdBy ? { createdBy: job.createdBy } : {}),
    }),
    lastRun: job.lastRun ? { status: job.lastRun.status, startedAt: job.lastRun.startedAt, ...(job.lastRun.sessionId ? { sessionId: job.lastRun.sessionId } : {}) } : null,
  }
}

function modelRun(run) {
  const tail = text => (text && text.length > VIEW_TAIL_CHARS ? `…${text.slice(-VIEW_TAIL_CHARS)}` : text)
  return Object.fromEntries(Object.entries({
    startedAt: run.startedAt,
    trigger: run.trigger,
    status: run.status,
    outcome: run.outcome,
    sessionId: run.sessionId,
    error: run.error,
    stdoutTail: tail(run.stdoutTail),
    stderrTail: tail(run.stderrTail),
  }).filter(([, value]) => value !== undefined && value !== ''))
}

/** Check arguments against the flat schemas above; returns a message or undefined. */
export function checkArgs(schema, args) {
  const input = args ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) return 'arguments must be an object'
  for (const key of schema.required) if (input[key] === undefined) return `missing ${key}`
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key]
    if (property === undefined) return `unknown argument ${key}`
    if (value === undefined) continue
    if (typeof value !== property.type) return `${key} must be a ${property.type}`
    if (property.enum && !property.enum.includes(value)) return `${key} must be one of ${property.enum.join(', ')}`
  }
  return undefined
}

function failure(code, message) {
  return { code, message }
}

function codeError(code, message) {
  return Object.assign(new Error(message), { code })
}
