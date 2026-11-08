import { Cron } from 'croner'
import { JobRunner, agentModel, agentSettings, isGated, jobKind } from './job.js'
import { ScheduleError, ScheduleTimer, describeSchedule, parseSchedule, scheduleFromInput } from './schedule.js'
import { JobStore } from './store.js'

/** Longest job title accepted from the tools. */
export const MAX_TITLE_LENGTH = 200

/**
 * A request about a stored job that cannot be carried out; `code` says why.
 * Schedule problems arrive as {@link ScheduleError} with their own codes.
 */
export class JobInputError extends Error {
  /**
   * @param {'not_found' | 'read_only' | 'invalid_job' | 'invalid_state'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'JobInputError'
    this.code = code
  }
}

/**
 * Owns every job: config jobs from the plugin config and stored jobs created
 * with the tools. One runner per job id, a timer for each job that should
 * run, pause and resume, manual runs, create/update/delete of stored jobs,
 * and the read model the Web page and the tools show.
 *
 * Config jobs are keyed by name (their id is their name). Their timers are
 * croner timers for cron expressions, as before, and schedule timers for
 * rrule and one-time schedules; ticks missed while DSH is down are not
 * caught up. Stored jobs keep their next run in storage, so a run missed
 * while DSH was down happens once at startup, and they can be changed only
 * through this controller.
 *
 * Job state, as shown to the user:
 * - `active`: scheduled.
 * - `paused`: paused from the page or a tool; the timer is held and the pause is saved.
 * - `disabled`: `enabled: false` in the plugin config. Config wins over a
 *   saved pause, which only applies again once the job is enabled.
 * - `invalid`: the schedule could not be parsed, or the job has neither a command nor a prompt.
 * - `ended`: a one-time or bounded schedule has no more runs.
 * Every state still allows a manual run.
 */
export class CronJobs {
  /**
   * @param {object} options
   * @param {import('./job.js').Job[]} options.jobs - Config jobs.
   * @param {{ info: Function, warn: Function, error: Function }} options.logger
   * @param {Function} options.run - Command runner, see {@link import('./command.js').runCommand}.
   * @param {Function} options.wake - Agent session opener.
   * @param {Function} [options.reuse] - Sends a prompt into an existing session.
   * @param {Function} [options.settle] - Archives a session after its turn.
   * @param {{ agentCwd?: string, autoArchive?: boolean, reuseWithinHours?: number }} [options.defaults] - Plugin-level agent settings.
   * @param {AbortSignal} [options.signal] - Stops running commands when aborted.
   * @param {(entry: object) => Promise<void>} [options.record] - Run log, see runlog.js.
   * @param {import('./history.js').HistoryStore} [options.history] - Saved runs, pause state and stored jobs.
   * @param {typeof Cron} [options.CronClass] - Replaceable for tests.
   * @param {typeof ScheduleTimer} [options.TimerClass] - Replaceable for tests.
   * @param {() => Date} [options.now]
   */
  constructor({ jobs, logger, run, wake, reuse, settle, defaults = {}, signal, record, history, CronClass = Cron, TimerClass = ScheduleTimer, now = () => new Date() }) {
    this.logger = logger
    this.defaults = defaults
    this.history = history
    this.store = history?.tasks === undefined ? undefined : new JobStore(history.tasks)
    this.CronClass = CronClass
    this.TimerClass = TimerClass
    this.now = now
    this.deps = { run, wake, reuse, settle, defaults, logger, signal, record, history, now }
    /** @type {Map<string, { job: object, runner: JobRunner, spec?: object, record?: object, timer?: any, error?: string }>} */
    this.entries = new Map()
    this.inflight = new Set()
    this.stopped = false
    for (const job of jobs) {
      if (this.entries.has(job.name)) {
        logger.error('[%s] duplicate job name; this copy is not scheduled', job.name)
        continue
      }
      this.add({ job: fromConfig(job) })
    }
    for (const stored of this.store?.all() ?? []) {
      if (this.entries.has(stored.id)) {
        logger.error('[%s] stored job id clashes with a config job name; the stored job is not loaded', stored.id)
        continue
      }
      this.add({ job: fromStored(stored), record: stored })
    }
  }

  add(entry) {
    entry.spec = entry.job.spec
    entry.runner = new JobRunner(entry.job, {
      ...this.deps,
      ...(entry.record ? { keepSession: sessionId => this.keepSession(entry, sessionId) } : {}),
    })
    this.entries.set(entry.job.id, entry)
    return entry
  }

  /** Arm the timers of jobs that should run; paused jobs start held. */
  start() {
    for (const entry of this.entries.values()) {
      // Archives an earlier copy of the plugin left waiting on a running turn.
      entry.runner.resumeArchives().catch(error => this.logger.warn('[%s] pending archives not resumed: %s', entry.job.name, String(error)))
    }
    for (const entry of this.entries.values()) this.arm(entry)
    return this
  }

  /** (Re)create the timer of one job from its current definition. */
  arm(entry) {
    entry.timer?.stop()
    entry.timer = undefined
    entry.error = undefined
    const { job, record } = entry
    if (jobKind(job) === undefined) {
      entry.error = 'the job has neither a command nor an agent prompt'
      this.logger.error('[%s] not scheduled: %s', job.name, entry.error)
      return
    }
    if (record ? record.status === 'ended' : job.enabled === false) return
    const paused = this.pausedEntry(entry)
    let timer
    try {
      if (!record && entry.spec?.kind === 'cron') {
        timer = new this.CronClass(job.cron, { timezone: job.timeZone || undefined }, () => this.fire(entry))
        if (paused) timer.pause?.()
      } else {
        if (job.specError) throw new ScheduleError('invalid_rule', job.specError)
        timer = new this.TimerClass(parseSchedule(entry.spec), {
          onFire: () => this.fire(entry),
          now: () => this.now().getTime(),
          paused,
          ...(record?.scheduledAt ? { first: new Date(record.scheduledAt) } : {}),
        })
      }
    } catch (error) {
      timer?.stop()
      entry.error = error instanceof Error ? error.message : String(error)
      this.logger.error('[%s] not scheduled: %s', job.name, entry.error)
      return
    }
    entry.timer = timer
    const next = this.nextRun(entry)
    const configCron = !record && entry.spec.kind === 'cron'
    this.logger.info('[%s] scheduled "%s"%s, %s', job.name, configCron ? job.cron : describeSchedule(entry.spec),
      configCron ? (job.timeZone ? ` (${job.timeZone})` : '') : record ? ` (${job.id})` : '',
      paused ? 'paused' : `next run ${next ? next.toISOString() : 'never'}`)
  }

  fire(entry) {
    if (this.pausedEntry(entry)) return
    const tick = entry.runner.tick()
    this.track(entry.record ? tick.finally(() => this.saveNext(entry)) : tick, entry.job.name)
  }

  /** After a scheduled run of a stored job: save its next run, or end it. */
  async saveNext(entry) {
    if (this.entries.get(entry.job.id) !== entry || this.store === undefined) return
    const current = this.store.get(entry.job.id)
    if (current === undefined) return
    const next = entry.timer?.nextRun() ?? null
    const status = current.status === 'active' && next === null ? 'ended' : current.status
    await this.saveRecord(entry, { ...current, status, scheduledAt: next?.toISOString() })
    if (status === 'ended') {
      entry.timer?.stop()
      entry.timer = undefined
      this.logger.info('[%s] ended: no more runs', entry.job.name)
    }
  }

  /** A new_once job opened its session: later runs go there. */
  async keepSession(entry, sessionId) {
    const current = this.store?.get(entry.job.id)
    if (current === undefined || current.target.kind !== 'new_once') return
    const target = { kind: 'new_once', sessionId }
    entry.job.target = target
    await this.saveRecord(entry, { ...current, target })
  }

  async saveRecord(entry, record) {
    const clean = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
    await this.store.put(clean)
    entry.record = this.store.get(clean.id) ?? clean
  }

  /** Runners of the jobs that have a timer. */
  scheduledRunners() {
    const runners = new Map()
    for (const [id, entry] of this.entries) if (entry.timer) runners.set(id, entry.runner)
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

  isPaused(id) {
    const entry = this.entries.get(id)
    return entry === undefined ? false : this.pausedEntry(entry)
  }

  pausedEntry(entry) {
    if (entry.record) return entry.record.status === 'paused'
    return this.history?.paused(entry.job.id) === true
  }

  /** The job list for the page and the tools. */
  list() {
    return [...this.entries.values()].map(entry => this.view(entry))
  }

  /** One job's view, or undefined. */
  get(id) {
    const entry = this.entries.get(id)
    return entry === undefined ? undefined : this.view(entry)
  }

  /** Runs of one job, newest first, or undefined for an unknown job. */
  runs(id) {
    if (!this.entries.has(id)) return undefined
    return this.history?.runs(id) ?? []
  }

  /**
   * Start one run now, outside the schedule. Allowed in every state; it does
   * not move the schedule.
   * @returns {{ ok: true, startedAt: string } | { ok: false, code: 'not-found' | 'busy' | 'stopped' }}
   */
  runNow(id) {
    const entry = this.entries.get(id)
    if (entry === undefined) return { ok: false, code: 'not-found' }
    if (this.stopped) return { ok: false, code: 'stopped' }
    if (entry.runner.running) return { ok: false, code: 'busy' }
    this.track(entry.runner.tick({ trigger: 'manual' }), entry.job.name)
    return { ok: true, startedAt: entry.runner.current.startedAt }
  }

  /**
   * Pause or resume a job's schedule; the choice is saved and survives restarts.
   * A run in progress is not stopped. Resuming a stored job continues from the
   * present; a schedule with no future run ends.
   * @returns {Promise<{ ok: true, job: object } | { ok: false, code: 'not-found' | 'ended' }>}
   */
  async setPaused(id, paused) {
    const entry = this.entries.get(id)
    if (entry === undefined) return { ok: false, code: 'not-found' }
    if (entry.record) {
      if (entry.record.status === 'ended') return { ok: false, code: 'ended' }
      let status = paused ? 'paused' : 'active'
      if (paused) entry.timer?.pause?.()
      else entry.timer?.resume?.()
      const next = entry.timer?.nextRun() ?? null
      if (!paused && entry.timer && next === null) status = 'ended'
      await this.saveRecord(entry, {
        ...entry.record, status, updatedAt: this.now().toISOString(),
        scheduledAt: entry.timer ? next?.toISOString() : entry.record.scheduledAt,
      })
      if (status === 'ended') {
        entry.timer?.stop()
        entry.timer = undefined
      }
    } else {
      await this.history?.setPaused(id, paused, this.now())
      if (entry.timer) {
        if (paused) entry.timer.pause?.()
        else entry.timer.resume?.()
      }
    }
    this.logger.info('[%s] %s', entry.job.name, paused ? 'paused' : 'resumed')
    return { ok: true, job: this.view(entry) }
  }

  /**
   * Create a stored job. The caller has filled in defaults (directory,
   * preset, target).
   * @param {object} input
   * @param {string} input.title
   * @param {string} [input.prompt]
   * @param {string} [input.command]
   * @param {{ cron?: string, rrule?: string, at?: string, timeZone?: string }} input.schedule
   * @param {string} [input.cwd]
   * @param {string} [input.preset]
   * @param {{ kind: 'new' } | { kind: 'new_once' } | { kind: 'session', sessionId: string }} input.target
   * @param {string} [input.createdBy]
   * @returns {Promise<object>} The job's view.
   * @throws {JobInputError | ScheduleError}
   */
  async create(input) {
    const store = this.requireStore()
    const now = this.now()
    const spec = scheduleFromInput(input.schedule)
    const draft = {
      id: '',
      title: title(input.title),
      ...text('prompt', input.prompt),
      ...text('command', input.command),
      schedule: spec,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.preset ? { preset: input.preset } : {}),
      target: input.target ?? { kind: 'new' },
      status: 'active',
      scheduledAt: firstRun(spec, now),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    }
    requireWork(draft)
    draft.id = store.newId(id => this.entries.has(id))
    await store.put(draft)
    const entry = this.add({ job: fromStored(store.get(draft.id)), record: store.get(draft.id) })
    if (!this.stopped) this.arm(entry)
    this.logger.info('[%s] created stored job %s', entry.job.name, draft.id)
    return this.view(entry)
  }

  /**
   * Change a stored job. Omitted fields stay; an empty prompt or command
   * removes it. A new schedule (or a new time zone for a cron schedule)
   * starts from the present and reactivates an ended job; a paused job stays
   * paused.
   * @param {string} id
   * @param {{ title?: string, prompt?: string, command?: string, schedule?: { cron?: string, rrule?: string, at?: string, timeZone?: string }, cwd?: string, preset?: string, target?: object }} patch
   * @returns {Promise<object>} The job's view.
   */
  async update(id, patch) {
    const entry = this.storedEntry(id)
    const now = this.now()
    const current = entry.record
    const next = { ...current, updatedAt: now.toISOString() }
    if (patch.title !== undefined) next.title = title(patch.title)
    for (const field of ['prompt', 'command']) {
      if (patch[field] === undefined) continue
      delete next[field]
      Object.assign(next, text(field, patch[field]))
    }
    if (patch.cwd !== undefined) next.cwd = patch.cwd || undefined
    if (patch.preset !== undefined) next.preset = patch.preset || undefined
    if (patch.target !== undefined) next.target = patch.target
    if (patch.schedule !== undefined) {
      next.schedule = changedSchedule(current.schedule, patch.schedule)
      next.scheduledAt = firstRun(next.schedule, now)
      if (next.status === 'ended') next.status = 'active'
    }
    requireWork(next)
    await this.saveRecord(entry, next)
    entry.job = fromStored(entry.record)
    entry.spec = entry.job.spec
    entry.runner.job = entry.job
    if (!this.stopped) this.arm(entry)
    this.logger.info('[%s] updated stored job %s', entry.job.name, id)
    return this.view(entry)
  }

  /** Delete a stored job and its run history. A run in progress finishes. */
  async remove(id) {
    const entry = this.storedEntry(id)
    entry.timer?.stop()
    entry.timer = undefined
    await this.store.delete(id)
    this.entries.delete(id)
    await this.history?.forget(id)
    this.logger.info('[%s] deleted stored job %s', entry.job.name, id)
    return { id, deleted: true }
  }

  storedEntry(id) {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new JobInputError('not_found', `no job with id ${JSON.stringify(id)}`)
    if (!entry.record) throw new JobInputError('read_only', `${JSON.stringify(id)} is defined in the plugin config; change it there`)
    return entry
  }

  requireStore() {
    if (this.store === undefined) throw new JobInputError('invalid_state', 'job storage is not available')
    return this.store
  }

  view(entry) {
    const { job, runner, timer, error, record, spec } = entry
    const paused = this.pausedEntry(entry)
    let state
    if (record) state = error !== undefined ? 'invalid' : record.status === 'ended' ? 'ended' : paused ? 'paused' : 'active'
    else if (job.enabled === false) state = 'disabled'
    else if (error !== undefined) state = 'invalid'
    else if (paused) state = 'paused'
    else if (spec?.kind !== 'cron' && timer && this.nextRun(entry) === null) state = 'ended'
    else state = 'active'
    const next = state === 'active' ? this.nextRun(entry) : null
    const gated = isGated(job)
    return {
      id: job.id,
      name: job.name,
      source: record ? 'tool' : 'config',
      kind: jobKind(job) ?? null,
      state,
      ...(error !== undefined ? { error } : {}),
      paused,
      pausedAt: record ? (paused ? record.updatedAt : null) : this.history?.state(job.id).pausedAt ?? null,
      schedule: spec ? { ...spec, text: describeSchedule(spec) } : null,
      cron: spec?.kind === 'cron' ? spec.expression : null,
      timeZone: scheduleZone(spec) ?? null,
      command: job.command || null,
      cwd: job.cwd || null,
      timeoutSeconds: job.timeoutSeconds ?? 0,
      gated,
      agent: gated ? agentView(job, this.defaults) : null,
      target: gated ? targetView(job) : null,
      nextRunAt: next ? next.toISOString() : null,
      running: runner.current,
      lastRun: this.history?.lastRun(job.id) ?? null,
      scheduled: timer !== undefined,
      ...(record ? { createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.createdBy ? { createdBy: record.createdBy } : {}) } : {}),
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

/** A config job as the runner and timers see it. */
function fromConfig(job) {
  const given = ['cron', 'rrule', 'at'].filter(key => typeof job[key] === 'string' && job[key].trim() !== '')
  let spec
  let specError
  if (given.length !== 1) {
    specError = 'set exactly one of cron, rrule or at'
  } else if (given[0] === 'cron') {
    spec = { kind: 'cron', expression: job.cron, ...(job.timeZone ? { timeZone: job.timeZone } : {}) }
  } else {
    try {
      spec = scheduleFromInput({ [given[0]]: job[given[0]], ...(given[0] === 'at' && job.timeZone ? { timeZone: job.timeZone } : {}) })
    } catch (error) {
      specError = error instanceof Error ? error.message : String(error)
    }
  }
  const sessionId = job.agent?.sessionId?.trim()
  return {
    ...job,
    id: job.name,
    source: 'config',
    ...(spec?.kind !== 'cron' && spec ? { timeZone: scheduleZone(spec) } : {}),
    spec,
    specError,
    ...(sessionId ? { target: { kind: 'session', sessionId } } : {}),
  }
}

/** A stored job as the runner and timers see it. */
function fromStored(record) {
  return {
    id: record.id,
    name: record.title,
    source: 'tool',
    ...(record.command ? { command: record.command } : {}),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    timeoutSeconds: record.timeoutSeconds ?? DEFAULT_STORED_TIMEOUT_SECONDS,
    timeZone: scheduleZone(record.schedule),
    ...(record.prompt ? { agent: { prompt: record.prompt, ...(record.preset ? { preset: record.preset } : {}), ...(record.cwd ? { cwd: record.cwd } : {}) } } : {}),
    target: record.target,
    spec: record.schedule,
  }
}

/** Command time limit of stored jobs, the same default as config jobs. */
const DEFAULT_STORED_TIMEOUT_SECONDS = 3600

function scheduleZone(spec) {
  if (spec === undefined) return undefined
  if (spec.kind === 'rrule') {
    try {
      return parseSchedule(spec).timeZone
    } catch {
      return undefined
    }
  }
  return spec.timeZone || undefined
}

function firstRun(spec, now) {
  const first = parseSchedule(spec).next(now.getTime())
  if (first === undefined) throw new ScheduleError('not_future', 'the schedule has no run after now')
  return first.toISOString()
}

function changedSchedule(current, input) {
  const { cron, rrule, at, timeZone } = input
  if ([cron, rrule, at].some(value => value !== undefined && value !== '')) return scheduleFromInput(input)
  if (timeZone !== undefined && current.kind === 'cron') return scheduleFromInput({ cron: current.expression, timeZone })
  throw new ScheduleError('invalid_rule', 'give cron, rrule or at for the new schedule (timeZone alone changes only a cron schedule)')
}

function title(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '') throw new JobInputError('invalid_job', 'title must not be empty')
  if (trimmed.length > MAX_TITLE_LENGTH) throw new JobInputError('invalid_job', `title is longer than ${MAX_TITLE_LENGTH} characters`)
  return trimmed
}

function text(field, value) {
  return typeof value === 'string' && value.trim() !== '' ? { [field]: value } : {}
}

function requireWork(record) {
  if (!record.prompt && !record.command) throw new JobInputError('invalid_job', 'a job needs a prompt, a command, or both')
  if ((record.target.kind === 'session') && !record.target.sessionId) throw new JobInputError('invalid_job', 'a session target needs a session id')
}

function agentView(job, defaults) {
  const settings = agentSettings(job, defaults)
  const target = job.target?.kind ?? 'new'
  return {
    prompt: job.agent.prompt,
    preset: job.agent.preset || null,
    cwd: settings.cwd ?? null,
    // Where the cwd came from: the job, the plugin default, or the job's command cwd.
    cwdSource: job.agent.cwd ? 'job' : defaults.agentCwd ? 'default' : job.cwd ? 'command' : null,
    model: agentModel(job) ?? null,
    // An explicit session is never archived or swapped for another one.
    autoArchive: target === 'session' ? false : settings.autoArchive,
    reuseWithinHours: target === 'new' ? settings.reuseWithinHours : 0,
  }
}

function targetView(job) {
  const target = job.target ?? { kind: 'new' }
  return { kind: target.kind, sessionId: target.sessionId ?? null }
}
