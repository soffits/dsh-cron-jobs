import { JobRunner, agentModel, agentSettings, isGated, jobKind } from './job.js'
import { CronTimer, ScheduleError, ScheduleTimer, describeSchedule, parseSchedule, scheduleFromInput } from './schedule.js'
import { JobStore } from './store.js'
import { deliveryTarget, resolveDelivery } from './deliver.js'
import { DEFAULT_COALESCE_SECONDS, DEFAULT_MAX_RUNS_PER_HOUR, Deduper, EventBatcher, EventInputError, checkPatterns, normalizeEvent, subscribed } from './events.js'
import { WatcherInputError, WatcherSupervisor, checkWatcher } from './watchers.js'

/** How often the watchdog looks for lost timers. */
export const WATCHDOG_MS = 60_000

/** How late a tick must be before the watchdog treats its timer as lost. */
export const OVERDUE_MS = 60_000

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
 * schedule timers (cron through {@link CronTimer}); ticks missed while DSH
 * is down are not caught up. A watchdog runs a tick whose timer was lost
 * (its due time passed without a run) late, and writes an `overdue` line to
 * the run log, so a tick is never missed silently while DSH runs. Stored jobs keep their next run in storage, so a run missed
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
   * @param {Function} [options.send] - Hands a result to its delivery service (see deliver.js sendMessage).
   * @param {Function} [options.answer] - Waits for a woken agent's final answer (see session.js waitForAnswer).
   * @param {{ agentCwd?: string, autoArchive?: boolean, reuseWithinHours?: number, deliver?: object }} [options.defaults] - Plugin-level agent settings and default delivery target.
   * @param {AbortSignal} [options.signal] - Stops running commands when aborted.
   * @param {(entry: object) => Promise<void>} [options.record] - Run log, see runlog.js.
   * @param {import('./history.js').HistoryStore} [options.history] - Saved runs, pause state and stored jobs.
   * @param {typeof CronTimer} [options.CronClass] - Timer for config cron jobs; replaceable for tests.
   * @param {typeof ScheduleTimer} [options.TimerClass] - Replaceable for tests.
   * @param {() => Date} [options.now]
   * @param {number} [options.watchdogMs] - How often the watchdog looks for lost timers; 0 turns it off.
   * @param {number} [options.overdueMs] - How far past its due time a tick must be before the watchdog runs it.
   * @param {{ coalesceSeconds?: number, maxRunsPerHour?: number }} [options.events] - Event batching (events.js).
   * @param {{ set: typeof setTimeout, clear: typeof clearTimeout }} [options.timers] - Event batch timers; replaceable for tests.
   * @param {object[]} [options.watchers] - Watchers from the plugin config.
   * @param {object} [options.watcherOptions] - Passed to {@link WatcherSupervisor} (stateRoot, limits, spawn).
   */
  constructor({ jobs, logger, run, wake, reuse, settle, send, answer, checks, defaults = {}, signal, record, history, CronClass = CronTimer, TimerClass = ScheduleTimer, now = () => new Date(), watchdogMs = WATCHDOG_MS, overdueMs = OVERDUE_MS, events = {}, timers, watchers = [], watcherOptions = {} }) {
    this.logger = logger
    this.defaults = defaults
    this.history = history
    this.store = history?.tasks === undefined ? undefined : new JobStore(history.tasks)
    this.CronClass = CronClass
    this.TimerClass = TimerClass
    this.now = now
    this.watchdogMs = watchdogMs
    this.overdueMs = overdueMs
    this.record = record ?? (async () => {})
    this.deps = { run, wake, reuse, settle, send, answer, checks, defaults, logger, signal, record, history, now }
    this.eventSettings = {
      coalesceMs: (events.coalesceSeconds ?? DEFAULT_COALESCE_SECONDS) * 1000,
      maxRunsPerHour: events.maxRunsPerHour ?? DEFAULT_MAX_RUNS_PER_HOUR,
      ...(timers ? { timers } : {}),
    }
    this.deduper = new Deduper({ now: () => this.now().getTime() })
    this.configWatchers = []
    for (const def of watchers) {
      if (def.enabled === false) continue
      try {
        const clean = checkWatcher(def)
        if (this.configWatchers.some(other => other.id === clean.id)) throw new WatcherInputError(`duplicate watcher id ${clean.id}`)
        this.configWatchers.push({ ...clean, source: 'config' })
      } catch (error) {
        logger.error('[watcher %s] not started: %s', def?.id, error instanceof Error ? error.message : String(error))
      }
    }
    this.watcherOptions = watcherOptions
    this.supervisor = undefined
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
    this.subscribe(entry)
    return entry
  }

  /** (Re)create the event batcher of a job with `on`; waiting events are dropped. */
  subscribe(entry) {
    entry.batcher?.discard()
    entry.batcher?.stop()
    entry.batcher = undefined
    if (!(entry.job.on?.length > 0)) return
    entry.batcher = new EventBatcher({
      ...this.eventSettings,
      now: () => this.now().getTime(),
      busy: () => entry.runner.running,
      start: batch => this.runEvents(entry, batch),
    })
  }

  /** Start an event run; the batcher only calls this when the job is idle. */
  runEvents(entry, batch) {
    if (this.stopped || !this.listening(entry)) return
    this.runTracked(entry, entry.runner.tick({ trigger: 'event', events: batch }), { scheduled: true })
  }

  /**
   * Whether a job takes events now: it subscribes, is not paused, ended or
   * disabled, and its definition is valid.
   */
  listening(entry) {
    if (entry.batcher === undefined || entry.error !== undefined) return false
    if (entry.record) return entry.record.status === 'active'
    return entry.job.enabled !== false && !this.pausedEntry(entry)
  }

  /**
   * Take one event: drop a duplicate, hand it to every job listening on its
   * channel, and call `release` once all those runs have started.
   * @param {object} input - `{ channel, data?, text?, key?, source?, at? }`.
   * @param {() => void} [release]
   * @returns {{ matched: string[], duplicate?: true }} Ids of the jobs it went to.
   * @throws {EventInputError} for a malformed event.
   */
  emit(input, release = () => {}) {
    const event = normalizeEvent(input, this.now)
    if (this.stopped) throw Object.assign(new Error('the scheduler is stopping'), { code: 'unavailable' })
    if (this.deduper.seenBefore(event)) {
      release()
      this.record({ time: this.now().toISOString(), job: null, event: 'event', channel: event.channel, duplicate: true })
      return { matched: [], duplicate: true }
    }
    const targets = [...this.entries.values()].filter(entry => this.listening(entry) && subscribed(entry.job.on, event.channel))
    let left = targets.length
    const done = () => { if (--left === 0) release() }
    if (left === 0) release()
    for (const entry of targets) entry.batcher.add(event, done)
    const matched = targets.map(entry => entry.job.id)
    this.record({ time: this.now().toISOString(), job: null, event: 'event', channel: event.channel, ...(event.source ? { source: event.source } : {}), matched })
    if (matched.length > 0) this.logger.info('event %s for %s', event.channel, matched.join(', '))
    return { matched }
  }

  /** Arm the timers of jobs that should run; paused jobs start held. */
  start() {
    for (const entry of this.entries.values()) {
      // Archives an earlier copy of the plugin left waiting on a running turn.
      entry.runner.resumeArchives().catch(error => this.logger.warn('[%s] pending archives not resumed: %s', entry.job.name, String(error)))
      // Answers an earlier copy was still waiting for.
      entry.runner.resumeDeliveries().catch(error => this.logger.warn('[%s] pending deliveries not resumed: %s', entry.job.name, String(error)))
    }
    for (const entry of this.entries.values()) this.arm(entry)
    // A line per start and stop, so a gap in the run log can be told apart
    // from a lost tick: no runs happen between a stop and the next start.
    this.record({ time: this.now().toISOString(), job: null, event: 'scheduler-start', jobs: this.entries.size, scheduled: this.scheduledRunners().size })
    if (this.watchdogMs > 0) {
      this.watchdog = setInterval(() => this.checkOverdue(), this.watchdogMs)
      this.watchdog.unref?.()
    }
    this.startWatchers()
    return this
  }

  /** Start the config and stored watchers. */
  startWatchers() {
    if (this.supervisor !== undefined || this.stopped) return
    this.supervisor = new WatcherSupervisor({
      ...this.watcherOptions,
      emit: event => this.emit(event),
      logger: this.logger,
      record: this.record,
      notify: (text, def) => this.notifyDefault(text, `watcher ${def.id}`),
      onDone: id => this.watcherDone(id),
    })
    this.supervisor.set(this.watcherDefinitions())
  }

  /** Every watcher that should run: config ones first, then stored ones whose id is free. */
  watcherDefinitions() {
    const defs = [...this.configWatchers]
    for (const [, stored] of this.history?.watchers?.entries() ?? []) {
      if (defs.some(def => def.id === stored.id)) continue
      defs.push({ id: stored.id, channel: stored.channel, command: stored.command, ...(stored.cwd ? { cwd: stored.cwd } : {}), ...(stored.once ? { once: true } : {}), source: 'tool' })
    }
    return defs
  }

  /** Send a note to the plugin's default delivery target, if there is one. */
  async notifyDefault(text, from) {
    const target = resolveDelivery({}, this.defaults.deliver)
    if (target === undefined || this.deps.send === undefined) {
      this.logger.warn('%s: %s (no delivery target)', from, text)
      return
    }
    const sent = await this.deps.send(target, { text, files: [] }, { job: from }, {})
    if (sent.status !== 'sent') this.logger.warn('%s: note not delivered: %s', from, sent.error)
  }

  /** A once watcher finished: forget its stored definition. */
  async watcherDone(id) {
    const table = this.history?.watchers
    if (table?.get(id) === undefined) return
    await table.delete(id)
    this.supervisor?.set(this.watcherDefinitions())
  }

  /**
   * Create a stored watcher and start it.
   * @param {{ id: string, channel: string, command: string, cwd?: string, once?: boolean, createdBy?: string }} input
   */
  async createWatcher(input) {
    const table = this.history?.watchers
    if (table === undefined) throw new JobInputError('invalid_state', 'watcher storage is not available')
    const def = checkWatcher(input)
    if (this.configWatchers.some(other => other.id === def.id) || table.get(def.id) !== undefined) throw new WatcherInputError(`a watcher with id ${def.id} already exists`)
    await table.put(def.id, { ...def, createdAt: this.now().toISOString(), ...(input.createdBy ? { createdBy: input.createdBy } : {}) })
    this.supervisor?.set(this.watcherDefinitions())
    return this.watcherView(def.id)
  }

  /** Stop and delete a stored watcher. */
  async removeWatcher(id) {
    const table = this.history?.watchers
    if (this.configWatchers.some(other => other.id === id)) throw new JobInputError('read_only', `watcher ${JSON.stringify(id)} is defined in the plugin config; change it there`)
    if (table?.get(id) === undefined) throw new JobInputError('not_found', `no watcher with id ${JSON.stringify(id)}`)
    await table.delete(id)
    this.supervisor?.set(this.watcherDefinitions())
    return { id, deleted: true }
  }

  /** Watchers with their status. */
  listWatchers() {
    const running = new Map((this.supervisor?.list() ?? []).map(view => [view.id, view]))
    return this.watcherDefinitions().map(def => running.get(def.id) ?? { id: def.id, channel: def.channel, command: def.command, cwd: def.cwd ?? null, once: def.once === true, source: def.source, state: 'stopped' })
  }

  watcherView(id) {
    return this.listWatchers().find(view => view.id === id)
  }

  /**
   * Find jobs whose next run is well in the past although nothing paused
   * them: their timer was lost. Each such tick is written to the run log as
   * `overdue` and run now, late, instead of being skipped silently.
   * @returns {string[]} Names of the jobs found overdue.
   */
  checkOverdue() {
    if (this.stopped) return []
    const now = this.now().getTime()
    const found = []
    for (const entry of this.entries.values()) {
      if (entry.timer === undefined || this.pausedEntry(entry)) continue
      const due = this.nextRun(entry)
      if (due === null || now - due.getTime() <= this.overdueMs) continue
      // Report each lost occurrence once, even if re-arming does not help.
      if (entry.overdueAt === due.getTime()) continue
      entry.overdueAt = due.getTime()
      found.push(entry.job.name)
      this.logger.warn('[%s] tick due at %s did not run; running it now', entry.job.name, due.toISOString())
      this.record({ time: new Date(now).toISOString(), job: entry.job.name, event: 'overdue', dueAt: due.toISOString(), lateMs: now - due.getTime() })
      entry.timer.arm?.()
    }
    return found
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
    if (job.onError) {
      entry.error = job.onError
      this.logger.error('[%s] not scheduled: %s', job.name, entry.error)
      return
    }
    if (record ? record.status === 'ended' : job.enabled === false) return
    // Runs only on events: no timer.
    if (entry.spec === undefined && !job.specError && job.on?.length > 0) {
      this.logger.info('[%s] listening on %s%s', job.name, job.on.join(', '), this.pausedEntry(entry) ? ' (paused)' : '')
      return
    }
    const paused = this.pausedEntry(entry)
    let timer
    try {
      if (!record && entry.spec?.kind === 'cron') {
        timer = new this.CronClass(job.cron, { timezone: job.timeZone || undefined, paused, now: () => this.now().getTime() }, () => this.fire(entry))
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
    this.runTracked(entry, entry.runner.tick(), { scheduled: true })
  }

  /**
   * Track a run; afterwards save a stored job's next run (for runs not
   * started by hand) and let a waiting event batch run.
   */
  runTracked(entry, tick, { scheduled = false } = {}) {
    const after = tick.finally(async () => {
      if (scheduled && entry.record) await this.saveNext(entry)
    }).finally(() => entry.batcher?.idle())
    return this.track(after, entry.job.name)
  }

  /**
   * After a scheduled or event run of a stored job: save its next run, or
   * end it (a once job, or a schedule with no more runs and no events to
   * wait for).
   */
  async saveNext(entry) {
    if (this.entries.get(entry.job.id) !== entry || this.store === undefined) return
    const current = this.store.get(entry.job.id)
    if (current === undefined) return
    const next = entry.timer?.nextRun() ?? null
    const listens = current.on?.length > 0
    const ends = current.status === 'active' && (current.once === true || (next === null && !listens))
    const status = ends ? 'ended' : current.status
    await this.saveRecord(entry, { ...current, status, scheduledAt: next?.toISOString() })
    if (status === 'ended') {
      entry.timer?.stop()
      entry.timer = undefined
      entry.batcher?.discard()
      this.logger.info('[%s] ended: %s', entry.job.name, current.once ? 'it runs once' : 'no more runs')
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
    if (this.stopped) return Promise.allSettled([...this.inflight])
    this.stopped = true
    clearInterval(this.watchdog)
    for (const entry of this.entries.values()) {
      entry.timer?.stop()
      entry.batcher?.stop()
    }
    const watchers = this.supervisor?.stop()
    const stopping = this.record({ time: this.now().toISOString(), job: null, event: 'scheduler-stop' })
    await Promise.allSettled([...this.inflight, stopping, watchers])
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
    this.runTracked(entry, entry.runner.tick({ trigger: 'manual' }))
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
    if (paused) entry.batcher?.discard()
    if (entry.record) {
      if (entry.record.status === 'ended') return { ok: false, code: 'ended' }
      let status = paused ? 'paused' : 'active'
      if (paused) entry.timer?.pause?.()
      else entry.timer?.resume?.()
      const next = entry.timer?.nextRun() ?? null
      if (!paused && entry.timer && next === null && !(entry.record.on?.length > 0)) status = 'ended'
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
   * @param {{ via: string, to: string } | false} [input.deliver] - Where results go; the plugin default when omitted.
   * @param {{ provider: string, model: string, reasoningEffort?: string }} [input.model] - Model of the sessions it opens; the preset or host default when omitted.
   * @param {string} [input.createdBy]
   * @returns {Promise<object>} The job's view.
   * @throws {JobInputError | ScheduleError}
   */
  async create(input) {
    const store = this.requireStore()
    const now = this.now()
    const on = input.on === undefined ? [] : patterns(input.on)
    const spec = hasSchedule(input.schedule) || on.length === 0 ? scheduleFromInput(input.schedule ?? {}) : undefined
    const draft = {
      id: '',
      title: title(input.title),
      ...text('prompt', input.prompt),
      ...text('command', input.command),
      ...text('answerCheck', input.answerCheck),
      ...(spec ? { schedule: spec } : {}),
      ...(on.length > 0 ? { on } : {}),
      ...(input.once === true ? { once: true } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.preset ? { preset: input.preset } : {}),
      target: input.target ?? { kind: 'new' },
      ...(deliveryTarget(input.deliver) !== undefined ? { deliver: deliveryTarget(input.deliver) } : {}),
      ...(input.model !== undefined ? { model: storedModel(input.model) } : {}),
      status: 'active',
      ...(spec ? { scheduledAt: firstRun(spec, now) } : {}),
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
   * @param {{ title?: string, prompt?: string, command?: string, schedule?: { cron?: string, rrule?: string, at?: string, timeZone?: string }, cwd?: string, preset?: string, target?: object, deliver?: object | false | null, model?: object | null }} patch - `deliver: null` goes back to the plugin default; `model: null` to the preset or host default.
   * @returns {Promise<object>} The job's view.
   */
  async update(id, patch) {
    const entry = this.storedEntry(id)
    const now = this.now()
    const current = entry.record
    const next = { ...current, updatedAt: now.toISOString() }
    if (patch.title !== undefined) next.title = title(patch.title)
    for (const field of ['prompt', 'command', 'answerCheck']) {
      if (patch[field] === undefined) continue
      delete next[field]
      Object.assign(next, text(field, patch[field]))
    }
    if (patch.cwd !== undefined) next.cwd = patch.cwd || undefined
    if (patch.preset !== undefined) next.preset = patch.preset || undefined
    if (patch.target !== undefined) next.target = patch.target
    if (patch.deliver !== undefined) next.deliver = deliveryTarget(patch.deliver)
    if (patch.model !== undefined) next.model = patch.model === null ? undefined : storedModel(patch.model)
    if (patch.on !== undefined) {
      const on = patterns(patch.on)
      if (on.length > 0) next.on = on
      else delete next.on
    }
    if (patch.once !== undefined) {
      if (patch.once) next.once = true
      else delete next.once
    }
    if (patch.schedule !== undefined) {
      const schedule = changedSchedule(current.schedule, patch.schedule)
      if (schedule === null) {
        delete next.schedule
        delete next.scheduledAt
      } else {
        next.schedule = schedule
        next.scheduledAt = firstRun(next.schedule, now)
      }
    }
    // A new schedule or new subscriptions bring an ended job back.
    if (next.status === 'ended' && (patch.schedule !== undefined || (patch.on !== undefined && next.on))) next.status = 'active'
    requireWork(next)
    await this.saveRecord(entry, next)
    entry.job = fromStored(entry.record)
    entry.spec = entry.job.spec
    entry.runner.job = entry.job
    this.subscribe(entry)
    if (!this.stopped) this.arm(entry)
    this.logger.info('[%s] updated stored job %s', entry.job.name, id)
    return this.view(entry)
  }

  /** Delete a stored job and its run history. A run in progress finishes. */
  async remove(id) {
    const entry = this.storedEntry(id)
    entry.timer?.stop()
    entry.timer = undefined
    entry.batcher?.discard()
    entry.batcher?.stop()
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
    else if (spec?.kind !== 'cron' && timer && this.nextRun(entry) === null && !(job.on?.length > 0)) state = 'ended'
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
      on: job.on?.length > 0 ? job.on : null,
      once: job.once === true,
      pendingEvents: entry.batcher?.size > 0 ? { count: entry.batcher.size, dueAt: new Date(entry.batcher.dueAt).toISOString() } : null,
      cron: spec?.kind === 'cron' ? spec.expression : null,
      timeZone: scheduleZone(spec) ?? null,
      command: job.command || null,
      cwd: job.cwd || null,
      timeoutSeconds: job.timeoutSeconds ?? 0,
      gated,
      agent: gated ? agentView(job, this.defaults) : null,
      target: gated ? targetView(job) : null,
      deliver: deliverView(job, entry.runner.deliveryTarget(), this.defaults),
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
  let on
  let onError
  try {
    on = checkPatterns(job.on ?? [])
  } catch (error) {
    onError = error.message
  }
  let spec
  let specError
  if (given.length === 0 && on?.length > 0) {
    // Runs only on events.
  } else if (given.length !== 1) {
    specError = on?.length > 0 ? 'set at most one of cron, rrule or at' : 'set exactly one of cron, rrule or at, or on'
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
    on: on ?? [],
    ...(onError ? { onError } : {}),
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
    ...(record.prompt ? { agent: { prompt: record.prompt, ...(record.preset ? { preset: record.preset } : {}), ...(record.cwd ? { cwd: record.cwd } : {}), ...(record.model ? { model: record.model } : {}), ...(record.answerCheck ? { answerCheck: record.answerCheck } : {}) } } : {}),
    target: record.target,
    ...(record.deliver !== undefined ? { deliver: record.deliver } : {}),
    spec: record.schedule,
    on: record.on ?? [],
    ...(record.once ? { once: true } : {}),
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

/** The edited schedule, or null when an empty cron, rrule or at removes it. */
function changedSchedule(current, input) {
  const { cron, rrule, at, timeZone } = input
  if ([cron, rrule, at].some(value => value !== undefined && value !== '')) return scheduleFromInput(input)
  if ([cron, rrule, at].some(value => value === '')) return null
  if (timeZone !== undefined && current?.kind === 'cron') return scheduleFromInput({ cron: current.expression, timeZone })
  throw new ScheduleError('invalid_rule', 'give cron, rrule or at for the new schedule (timeZone alone changes only a cron schedule)')
}

function hasSchedule(input) {
  return input !== undefined && ['cron', 'rrule', 'at'].some(key => typeof input[key] === 'string' && input[key].trim() !== '')
}

function patterns(list) {
  try {
    return checkPatterns(list)
  } catch (error) {
    throw new JobInputError('invalid_job', error.message)
  }
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

/** A stored job's model: provider and model required, effort optional. */
function storedModel(value) {
  const model = agentModel({ agent: { model: value ?? {} } })
  if (model === undefined) throw new JobInputError('invalid_job', 'model needs both provider and model')
  return model
}

function requireWork(record) {
  if (!record.prompt && !record.command) throw new JobInputError('invalid_job', 'a job needs a prompt, a command, or both')
  if (record.schedule === undefined && !(record.on?.length > 0)) throw new JobInputError('invalid_job', 'a job needs a schedule, on (event channels), or both')
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
    answerCheck: job.agent.answerCheck || null,
    // An explicit session is never archived or swapped for another one.
    autoArchive: target === 'session' ? false : settings.autoArchive,
    reuseWithinHours: target === 'new' ? settings.reuseWithinHours : 0,
  }
}

/**
 * Where a job's results go, for the page and the tools: the target and where
 * it came from (`job` or the plugin `default`), or why nothing is sent
 * (`off`: the job turns it off; `session`: it posts into an existing session;
 * `unset`: no target anywhere).
 */
function deliverView(job, target, defaults) {
  if (target !== undefined) return { via: target.via, to: target.to, source: deliveryTarget(job.deliver) ? 'job' : 'default' }
  if (job.deliver === false) return { via: null, to: null, source: 'off' }
  if (job.target?.kind === 'session' && resolveDelivery({}, defaults.deliver)) return { via: null, to: null, source: 'session' }
  return { via: null, to: null, source: 'unset' }
}

function targetView(job) {
  const target = job.target ?? { kind: 'new' }
  return { kind: target.kind, sessionId: target.sessionId ?? null }
}
