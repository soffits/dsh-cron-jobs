import { randomUUID } from 'node:crypto'
import { decideWake } from './wake.js'
import { commandResultText, cutOff, deliveryTarget, describeTarget, messageFromText, resolveDelivery } from './deliver.js'
import { buildAgentPrompt, buildRerunPrompt, formatLocalTime, sessionTitle } from './prompt.js'
import { HISTORY_TAIL_CHARS } from './history.js'
import { batchSummary, eventInput } from './events.js'

/** Characters of stdout/stderr shown in the log after each run. */
export const LOG_TAIL_CHARS = 400

/** Stand-in history used when a runner has none. */
const NO_HISTORY = {
  begin: async () => undefined,
  finish: async () => {},
  update: async () => {},
  runs: () => [],
}

const HOUR_MS = 3600 * 1000

/**
 * Whether a job wakes an agent: it has an `agent` block with a prompt.
 * @param {Job} job
 */
export function isGated(job) {
  return typeof job.agent?.prompt === 'string' && job.agent.prompt.trim() !== ''
}

/** Whether a job runs a command. */
export function hasCommand(job) {
  return typeof job.command === 'string' && job.command.trim() !== ''
}

/**
 * What a job does: `command` (a plain command), `gate` (a command that wakes
 * an agent when its output asks), or `agent` (no command: every run wakes).
 * Undefined for a job with neither a command nor a prompt.
 * @param {Job} job
 * @returns {'command' | 'gate' | 'agent' | undefined}
 */
export function jobKind(job) {
  if (hasCommand(job)) return isGated(job) ? 'gate' : 'command'
  return isGated(job) ? 'agent' : undefined
}

/** Key of a job's history and pause state: its id, which for config jobs is the name. */
export function jobKey(job) {
  return job.id ?? job.name
}

/**
 * The model chosen for a job's woken sessions, or undefined to use the preset
 * or host default. Needs both a provider and a model.
 * @param {Job} job
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function agentModel(job) {
  const provider = job.agent?.model?.provider?.trim()
  const model = job.agent?.model?.model?.trim()
  if (!provider || !model) return undefined
  const reasoningEffort = job.agent.model.reasoningEffort?.trim()
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

/**
 * Where and how a gated job's agent runs, after plugin defaults.
 * @param {Job} job
 * @param {{ agentCwd?: string, autoArchive?: boolean, reuseWithinHours?: number }} [defaults] - Plugin-level settings.
 * @returns {{ cwd?: string, autoArchive: boolean, reuseWithinHours: number }}
 */
export function agentSettings(job, defaults = {}) {
  const cwd = job.agent?.cwd || defaults.agentCwd || job.cwd || undefined
  return {
    ...(cwd ? { cwd } : {}),
    autoArchive: job.agent?.autoArchive ?? defaults.autoArchive ?? false,
    reuseWithinHours: job.agent?.reuseWithinHours ?? defaults.reuseWithinHours ?? 0,
  }
}

/**
 * Runs one job per tick. A tick that arrives while the previous run of the
 * same job is still going is skipped.
 *
 * @typedef {object} Job
 * @property {string} [id] - Stored jobs: their id. Config jobs: the name (the default).
 * @property {string} name
 * @property {'config' | 'tool'} [source]
 * @property {string} [cron]
 * @property {string} [timeZone]
 * @property {string} [command] - Missing for an agent-only job.
 * @property {string} [cwd]
 * @property {number} [timeoutSeconds]
 * @property {{ prompt?: string, preset?: string, cwd?: string, sessionId?: string, model?: { provider?: string, model?: string, reasoningEffort?: string }, autoArchive?: boolean, reuseWithinHours?: number }} [agent]
 * @property {{ kind: 'new' } | { kind: 'new_once', sessionId?: string } | { kind: 'session', sessionId: string }} [target] - Where the prompt goes; a new session when omitted.
 * @property {{ via: string, to?: string } | false} [deliver] - Where the result goes (see deliver.js); the plugin default when omitted, nothing when false.
 */
export class JobRunner {
  /**
   * @param {Job} job
   * @param {object} deps
   * @param {(options: object) => Promise<import('./command.js').CommandResult>} deps.run - Runs a command.
   * @param {(request: { text: string, title: string, agentPreset?: string, cwd?: string, model?: object }) => Promise<string>} deps.wake - Opens an agent session; resolves to its id.
   * @param {(request: { sessionId: string, text: string, mayUnarchive: boolean, ignoreHold?: boolean }) => Promise<{ queued?: boolean }>} [deps.reuse] - Sends the prompt into an existing session (see session.js deliverToSession); without it every wake opens a new session.
   * @param {(sessionId: string) => Promise<void>} [deps.keepSession] - Saves the session a new_once job opened, so later runs go to it.
   * @param {(sessionId: string, options: { signal?: AbortSignal, isLatest: () => boolean, lock: Function }) => Promise<{ archive: string, note?: string }>} [deps.settle] - Archives a session after its turn (see session.js archiveWhenIdle); without it nothing is archived.
   * @param {(target: { via: string, to: string }, message: { text: string, files: string[] }, from: { job: string, jobId: string, sessionId?: string, runId?: string }, options: { cwd?: string, waitMs?: number, onWait?: Function }) => Promise<{ status: 'sent' | 'failed' | 'unavailable' | 'stopped', attempts: number, error?: string }>} [deps.send] - Hands a result to its delivery service (see deliver.js sendMessage); without it nothing is delivered.
   * @param {(sessionId: string, messageId: string, options: { signal?: AbortSignal }) => Promise<{ pending: true } | { text: string, reason?: string } | { error: string }>} [deps.answer] - Waits for the final answer to a prompt (see session.js waitForAnswer).
   * @param {{ agentCwd?: string, autoArchive?: boolean, reuseWithinHours?: number, deliver?: object, problems?: { deliver?: object | false } }} [deps.defaults] - Plugin-level agent settings, the default delivery target, and where problem notes go.
   * @param {(problem: object, triggers: string[]) => boolean} [deps.reportProblem] - Emits a problem note as an event (see CronJobs.reportProblem); true when a job took it.
   * @param {{ info: Function, warn: Function }} deps.logger
   * @param {AbortSignal} [deps.signal] - Stops a running command when aborted.
   * @param {(entry: object) => Promise<void>} [deps.record] - Appends a run record (see runlog.js).
   * @param {{ begin: Function, finish: Function }} [deps.history] - Saved run history (see history.js).
   * @param {() => Date} [deps.now]
   */
  constructor(job, { run, wake, reuse, keepSession, settle, send, answer, reportProblem, defaults = {}, logger, signal, record = async () => {}, history = NO_HISTORY, now = () => new Date() }) {
    this.job = job
    this.send = send
    this.answer = answer
    this.reuse = reuse
    this.keepSession = keepSession
    this.settle = settle
    this.defaults = defaults
    this.reportProblem = reportProblem
    /** Latest run that sent a prompt to each session; only that run archives it. */
    this.latestRun = new Map()
    /** Per-session queue that keeps a delivery and an archive from overlapping. */
    this.locks = new Map()
    /** Archive and delivery waits in progress, for tests and shutdown. */
    this.settling = new Set()
    this.record = record
    this.history = history
    this.run = run
    this.wake = wake
    this.logger = logger
    this.signal = signal
    this.now = now
    this.running = false
    /** The run in progress: when it started and what started it; null when idle. */
    this.current = null
  }

  /**
   * Run the job once. `running` and `current` are set before the first await,
   * so a caller can read them as soon as this returns its promise.
   * @param {{ trigger?: 'schedule' | 'manual' | 'event', events?: { events: object[], dropped: number }, rerunOf?: object }} [options] - What started the run; an event run carries its batch of events; a rerun carries the saved run it reruns (see continueRun).
   * @returns {Promise<{ status: 'skipped' | 'done' | 'failed' | 'idle' | 'woke' | 'wake-failed', sessionId?: string }>}
   */
  async tick({ trigger = 'schedule', events, rerunOf } = {}) {
    const { job, logger } = this
    if (this.running) {
      logger.warn('[%s] previous run still going; skipping this tick', job.name)
      await this.record({ time: this.now().toISOString(), job: job.name, event: 'skipped' })
      return { status: 'skipped' }
    }
    this.running = true
    const firedAt = this.now()
    const summary = events ? batchSummary(events) : undefined
    this.current = { startedAt: firedAt.toISOString(), trigger, ...(summary ? { events: summary } : {}), ...(rerunOf ? { rerunOf: rerunOf.id } : {}) }
    let result
    let outcome = { status: 'failed' }
    let thrown
    let runId
    try {
      logger.info('[%s] start%s', job.name, rerunOf ? ` (rerun of the run started ${rerunOf.startedAt})` : trigger === 'manual' ? ' (run now)' : summary ? ` (${summary.count} event(s) on ${summary.channels.join(', ')})` : '')
      // A start line on its own shows a run that never finished (DSH stopped mid-run).
      await this.record({ time: firedAt.toISOString(), job: job.name, event: 'start', ...(trigger !== 'schedule' ? { trigger } : {}), ...(summary ? { events: summary } : {}), ...(rerunOf ? { rerunOf: rerunOf.id } : {}) })
      runId = await this.history.begin(jobKey(job), { trigger, startedAt: firedAt.toISOString(), ...(summary ? { events: summary } : {}), ...(rerunOf ? { rerunOf: rerunOf.id } : {}) })
      if (rerunOf) {
        await this.history.update(jobKey(job), rerunOf.id, { rerun: { status: 'started', at: firedAt.toISOString(), runId } })
        outcome = await this.continueRun(rerunOf)
      } else {
        outcome = await this.runOnce(firedAt, r => { result = r }, { trigger, events })
      }
      // The woken turn is watched until it ends: its answer is delivered, and a cut-off turn runs again.
      if (outcome.status === 'woke' && outcome.messageId && outcome.sessionId && this.answer !== undefined) {
        outcome = { ...outcome, turn: { status: 'pending', messageId: outcome.messageId } }
      }
      outcome = await this.deliverResult(outcome, result, { rerun: rerunOf !== undefined, runId })
      return outcome
    } catch (error) {
      thrown = describeError(error)
      throw error
    } finally {
      const endedAt = this.now()
      await this.record({
        time: endedAt.toISOString(),
        job: job.name,
        event: 'end',
        status: outcome.status,
        ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
        ...(outcome.delivery ? { delivery: outcome.delivery.status } : {}),
        ...(thrown ? { error: thrown } : {}),
        ...(result ? {
          outcome: describeOutcome(result, job),
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs,
          stdoutTail: tail(result.stdout ?? ''),
          stderrTail: tail(result.stderr ?? ''),
        } : {}),
      })
      if (runId !== undefined) {
        await this.history.finish(jobKey(job), runId, {
          status: outcome.status,
          endedAt: endedAt.toISOString(),
          durationMs: result?.durationMs ?? (endedAt.getTime() - firedAt.getTime()),
          sessionId: outcome.sessionId,
          sessionOpenedAt: outcome.sessionOpenedAt,
          reused: outcome.reused,
          queued: outcome.queued,
          reuseNote: outcome.reuseNote,
          targeted: outcome.targeted,
          turn: outcome.turn,
          archive: outcome.archive,
          delivery: outcome.delivery,
          error: thrown ?? outcome.error ?? result?.error,
          ...(result ? {
            outcome: describeOutcome(result, job),
            exitCode: result.exitCode ?? null,
            stdoutTail: tail(result.stdout ?? '', HISTORY_TAIL_CHARS),
            stderrTail: tail(result.stderr ?? '', HISTORY_TAIL_CHARS),
          } : {}),
        })
      }
      this.running = false
      this.current = null
      if (outcome.archive === 'pending' && runId !== undefined) this.watchArchive(outcome.sessionId, runId)
      if (runId !== undefined) {
        const delivery = outcome.delivery?.status === 'pending' ? outcome.delivery : undefined
        if (outcome.turn?.status === 'pending') this.watchTurn(outcome.sessionId, runId, outcome.turn.messageId, delivery)
        else if (delivery?.message !== undefined) this.watchDelivery(outcome.sessionId, runId, delivery)
      }
    }
  }

  /** Where this job's results go, or undefined. */
  deliveryTarget() {
    if (this.send === undefined) return undefined
    return resolveDelivery(this.job, this.defaults.deliver)
  }

  /**
   * Deliver what a run produced, and add the delivery state to its outcome.
   * A command's stdout (or failure note) and a failed wake are sent now; a
   * woken agent's answer is pending until its turn ends (see watchDelivery).
   * A gate that decided not to wake, and a run stopped by an unload, send
   * nothing.
   */
  async deliverResult({ messageId, ...outcome }, result, { rerun = false, runId } = {}) {
    const { job } = this
    if (outcome.status === 'woke') {
      const target = this.deliveryTarget()
      if (target === undefined || outcome.turn?.status !== 'pending') return outcome
      return { ...outcome, delivery: { status: 'pending', via: target.via, to: target.to } }
    }
    let text
    let problem
    if (outcome.status === 'wake-failed') {
      problem = rerun ? 'rerun-failed' : 'wake-failed'
      text = rerun
        ? `⚠️ ${job.name}: the run cut off by a DSH restart could not run again: ${outcome.error}`
        : `⚠️ ${job.name}: could not wake the agent: ${outcome.error}`
    }
    else if (result !== undefined && !result.aborted && (outcome.status === 'done' || outcome.status === 'failed')) {
      text = commandResultText(job, result)
      if (!result.ok) problem = isGated(job) ? 'gate-failed' : 'command-failed'
    }
    else return outcome
    const target = problem === undefined ? this.deliveryTarget() : this.problemTarget(problem, text, outcome, result)
    if (target === undefined) return outcome
    const where = { via: target.via, to: target.to }
    const message = messageFromText(text, job.cwd || undefined)
    if (message === undefined) return { ...outcome, delivery: { status: 'silent', ...where } }
    // No waiting inside the run: a missing service is waited for in the
    // background (see watchDelivery), with the message kept for a restart.
    const delivery = await this.deliverMessage(target, message, { runId, waitMs: 0 })
    return { ...outcome, delivery: delivery.status === 'pending' ? { ...delivery, message } : delivery }
  }

  /**
   * Where a problem note (a failed command or gate, a failed wake or rerun)
   * goes, after handing it to the problems channel. Without a `problems`
   * setting, the job's own target. `problems.deliver` set to a target sends
   * it there instead; set to false sends nothing, but only when a job took
   * the event, so a problem nobody handles still reaches the job's target.
   */
  problemTarget(kind, text, outcome, result) {
    const { job, current } = this
    const handled = this.reportProblem?.({
      kind,
      job: job.name,
      jobId: jobKey(job),
      trigger: current?.rerunOf ? 'rerun' : current?.trigger ?? 'schedule',
      ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(result ? { exitCode: result.exitCode ?? null } : {}),
      text,
    }, current?.events?.channels ?? []) === true
    const routed = deliveryTarget(this.defaults.problems?.deliver)
    if (routed === undefined) return this.deliveryTarget()
    if (routed === false) return handled ? undefined : this.deliveryTarget()
    return this.send === undefined ? undefined : routed
  }

  /**
   * Send one message and log the result; resolves the run's delivery record.
   * Not sent because the plugin is stopping, or (with `waitMs` 0) because
   * the service is not running: `pending`. Still not running after a longer
   * wait: `failed`.
   * @param {{ via: string, to: string }} target
   * @param {{ text: string, files: string[] }} message
   * @param {{ sessionId?: string, runId?: string, waitMs?: number, onWait?: (error: string) => void }} options
   */
  async deliverMessage(target, message, { sessionId, runId, waitMs, onWait }) {
    const { job, logger } = this
    // A command channel runs where the result came from: the woken session's directory, or the command's.
    const cwd = (sessionId ? agentSettings(job, this.defaults).cwd : job.cwd) || undefined
    const from = { job: job.name, jobId: jobKey(job), ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}) }
    const sent = await this.send(target, message, from, {
      ...(cwd ? { cwd } : {}), ...(waitMs !== undefined ? { waitMs } : {}), ...(onWait ? { onWait } : {}),
    })
    const where = describeTarget(target)
    const pending = sent.status === 'stopped' || (sent.status === 'unavailable' && waitMs === 0)
    const status = sent.status === 'sent' ? 'sent' : pending ? 'pending' : 'failed'
    if (status === 'sent') logger.info('[%s] delivered the result to %s', job.name, where)
    else if (status === 'pending') logger.info('[%s] result for %s not sent yet: %s', job.name, where, sent.error)
    else logger.warn('[%s] result not delivered to %s after %s attempt(s): %s', job.name, where, sent.attempts, sent.error)
    return {
      status,
      via: target.via,
      to: target.to,
      ...(status === 'pending' ? {} : { attempts: sent.attempts, at: this.now().toISOString() }),
      ...(sent.error ? { error: sent.error } : {}),
    }
  }

  /**
   * Deliver a message kept with a pending delivery (a command's output, a
   * failure note) in the background and save the outcome in the run's
   * history. Left pending when the plugin unloads, for the next copy to
   * finish (see resumeRuns).
   */
  watchDelivery(sessionId, runId, pending) {
    return this.background(this.deliveryWork(sessionId, runId, pending, () => this.sendPending(sessionId, runId, pending, pending.message)))
  }

  /**
   * Wait in the background for the turn a woken prompt started, then save
   * how it ended and deliver its final answer when the run has a pending
   * delivery. An empty answer or exactly [SILENT] sends nothing. A turn DSH
   * cut off (a restart or reload disposed it) delivers nothing and is marked
   * for one rerun (see markCutOff). Left pending when the plugin unloads:
   * the turn may still be running, and the next copy watches it again.
   */
  watchTurn(sessionId, runId, messageId, pending) {
    const { job, logger } = this
    const work = async () => {
      const answer = await this.answer(sessionId, messageId, { signal: this.signal })
      if ('pending' in answer || this.signal?.aborted) return undefined
      const cut = 'text' in answer && cutOff(answer)
      const reason = 'error' in answer ? 'error' : answer.reason
      await this.history.update(jobKey(job), runId, { turn: { status: cut ? 'cut-off' : 'ended', messageId, ...(reason ? { reason } : {}) } })
      let delivery
      if (pending === undefined) {
        delivery = undefined
      } else if ('error' in answer) {
        delivery = { status: 'failed', via: pending.via, to: pending.to ?? '', at: this.now().toISOString(), error: answer.error }
        logger.warn('[%s] no answer to deliver from session %s: %s', job.name, sessionId, answer.error)
      } else {
        const message = cut ? undefined : messageFromText(answer.text, agentSettings(job, this.defaults).cwd)
        if (message === undefined) {
          const ended = cut ? `turn cut off: ${answer.cause}` : answer.reason && answer.reason !== 'completed' ? `turn ended: ${answer.reason}` : undefined
          delivery = { status: 'silent', via: pending.via, to: pending.to ?? '', at: this.now().toISOString(), ...(ended ? { error: ended } : {}) }
          logger.info('[%s] nothing to deliver from session %s', job.name, sessionId)
        } else {
          delivery = await this.sendPending(sessionId, runId, pending, message)
        }
      }
      if (cut) await this.markCutOff(sessionId, runId)
      return delivery
    }
    if (pending === undefined) {
      return this.background(work().catch((error) => {
        logger.warn('[%s] turn in session %s not watched: %s', job.name, sessionId, describeError(error))
      }))
    }
    return this.background(this.deliveryWork(sessionId, runId, pending, work))
  }

  /** Run a delivery, then save and log its outcome; undefined from `work` means it stays pending. */
  async deliveryWork(sessionId, runId, pending, work) {
    const { job, logger } = this
    const target = { via: pending.via, to: pending.to ?? '' }
    try {
      const delivery = await work()
      if (delivery === undefined) return
      await this.history.update(jobKey(job), runId, { delivery })
      await this.logDelivery(sessionId, target, delivery)
    } catch (error) {
      logger.warn('[%s] delivery from session %s failed: %s', job.name, sessionId, describeError(error))
      if (!this.signal?.aborted) await this.history.update(jobKey(job), runId, { delivery: { status: 'failed', ...target, at: this.now().toISOString(), error: describeError(error) } })
    }
  }

  /**
   * Send one message of a pending delivery. A service that is not running is
   * waited for (see deliver.js sendMessage), shown on the page and in the
   * run log meanwhile. Resolves undefined when the plugin unloads first.
   */
  async sendPending(sessionId, runId, pending, message) {
    const { job, logger } = this
    const target = { via: pending.via, to: pending.to ?? '' }
    const onWait = (error) => {
      logger.warn('[%s] %s; waiting for it to deliver the result', job.name, error)
      this.history.update(jobKey(job), runId, { delivery: { ...pending, error } })
        .then(() => this.logDelivery(sessionId, target, { status: 'waiting', error })).catch(() => {})
    }
    const delivery = await this.deliverMessage(target, message, { sessionId, runId, onWait })
    // Unloading: the next copy of the plugin sends it, from the kept message
    // (the turn it came from is already recorded as ended).
    if (delivery.status === 'pending') {
      await this.history.update(jobKey(job), runId, { delivery: { ...pending, message } })
      await this.logDelivery(sessionId, target, { status: 'pending', error: `${delivery.error}; left for the next start` })
      return undefined
    }
    return delivery
  }

  logDelivery(sessionId, target, delivery) {
    return this.record({
      time: this.now().toISOString(), job: this.job.name, event: 'delivery', ...(sessionId ? { sessionId } : {}),
      status: delivery.status, via: target.via, to: target.to, ...(delivery.error ? { error: delivery.error } : {}),
    })
  }

  /** Keep a background promise in `settling` until it ends. */
  background(promise) {
    const watch = promise.finally(() => this.settling.delete(watch))
    this.settling.add(watch)
    return watch
  }

  /**
   * A run's turn was cut off: save that its rerun is pending. The rerun
   * starts when dsh-restart-resume hands the cut turn back after the restart
   * (CronJobs.continueCut); a rerun the handover already started or skipped
   * keeps its record. A rerun is never rerun again, so a turn that keeps
   * getting cut off does not loop.
   */
  async markCutOff(sessionId, runId) {
    const { job, logger } = this
    const run = this.history.runs(jobKey(job)).find(saved => saved.id === runId)
    const time = this.now().toISOString()
    if (run?.rerun !== undefined) return
    if (run?.rerunOf !== undefined) {
      const note = 'a rerun is not run again'
      await this.history.update(jobKey(job), runId, { rerun: { status: 'skipped', at: time, note } })
      await this.record({ time, job: job.name, event: 'rerun-skipped', runId, sessionId, note })
      logger.warn('[%s] the rerun in session %s was cut off too; %s', job.name, sessionId, note)
      return
    }
    await this.history.update(jobKey(job), runId, { rerun: { status: 'pending' } })
    await this.record({ time, job: job.name, event: 'cut-off', runId, sessionId })
    logger.warn('[%s] the turn in session %s was cut off before it finished; it runs again once DSH is back', job.name, sessionId)
  }

  /**
   * After a restart or reload: pick up what an earlier copy of the plugin
   * left pending. Turns are watched again (they may still be running, after
   * a plugin reload or on a provider that outlives a restart), and kept
   * deliveries are sent.
   */
  async resumeRuns() {
    for (const run of this.history.runs(jobKey(this.job))) {
      const delivery = run.delivery?.status === 'pending' ? run.delivery : undefined
      // Runs saved before turns were tracked keep the prompt id on the delivery.
      const messageId = run.turn === undefined ? delivery?.messageId : run.turn.status === 'pending' ? run.turn.messageId : undefined
      if (delivery?.message !== undefined) {
        this.watchDelivery(run.sessionId, run.id, delivery)
      } else if (messageId && run.sessionId && this.answer !== undefined) {
        this.watchTurn(run.sessionId, run.id, messageId, delivery)
      }
    }
  }

  /**
   * @param {Date} firedAt
   * @param {(result: import('./command.js').CommandResult) => void} keep - Receives the command result.
   */
  async runOnce(firedAt, keep, { trigger = 'schedule', events } = {}) {
    const { job, logger } = this
    let result
    if (hasCommand(job)) {
      result = await this.run({
        command: job.command,
        cwd: job.cwd || undefined,
        timeoutMs: (job.timeoutSeconds ?? 0) * 1000,
        signal: this.signal,
        // What started the run; an event run also gets its events on stdin.
        env: { ...process.env, DSH_CRON_TRIGGER: trigger, DSH_CRON_JOB: jobKey(job) },
        ...(events ? { input: eventInput(events) } : {}),
      })
      keep(result)
      this.logResult(result)
      if (!result.ok) return { status: 'failed' }
      if (!isGated(job)) return { status: 'done' }

      const decision = decideWake(result)
      if (!decision.wake) {
        logger.info('[%s] not waking agent: %s', job.name, decision.reason)
        return { status: 'idle' }
      }
    } else if (!isGated(job)) {
      return { status: 'failed', error: 'the job has neither a command nor a prompt' }
    }
    const localTime = formatLocalTime(firedAt, job.timeZone || undefined)
    const settings = agentSettings(job, this.defaults)
    const text = buildAgentPrompt({
      jobName: job.name,
      ...(job.source === 'tool' ? { jobId: jobKey(job) } : {}),
      prompt: job.agent.prompt,
      ...(result ? { stdout: result.stdout, droppedBytes: result.stdoutDropped } : {}),
      ...(events ? { events } : {}),
      firedAt: localTime,
      delivery: this.deliveryTarget(),
    })
    const target = job.target ?? { kind: 'new' }
    // Lets the answer to this prompt be found once its turn ends.
    const messageId = randomUUID()
    const sent = await this.deliverPrompt({ job, target, text, messageId, settings, firedAt, localTime })
    return sent.status === 'woke' ? { ...sent, messageId } : sent
  }

  /**
   * Rerun a cut-off run: ask its own session to finish the job. The session
   * already holds the job's prompt (with any command output and events) and
   * whatever the cut-off turn did, so continuing there neither loses that
   * input nor repeats finished steps. A session a person has taken over is
   * left alone unless it is the job's own target.
   * @param {object} original - The saved run that was cut off.
   */
  async continueRun(original) {
    const { job } = this
    if (!original.sessionId) return { status: 'wake-failed', error: 'the cut-off run has no session' }
    const settings = agentSettings(job, this.defaults)
    const target = job.target ?? { kind: 'new' }
    const text = buildRerunPrompt({
      jobName: job.name,
      ...(job.source === 'tool' ? { jobId: jobKey(job) } : {}),
      firedAt: formatLocalTime(new Date(original.startedAt), job.timeZone || undefined),
      delivery: this.deliveryTarget(),
    })
    const messageId = randomUUID()
    const archive = target.kind !== 'session' && settings.autoArchive && this.settle !== undefined ? { archive: 'pending' } : {}
    const fresh = target.kind === 'new'
    const sent = await this.sendToTarget(original.sessionId, text, {
      mayUnarchive: true,
      ignoreHold: !fresh,
      archive,
      messageId,
      fields: fresh ? { reused: true, sessionOpenedAt: original.sessionOpenedAt ?? original.startedAt } : { targeted: true },
    })
    return sent.status === 'woke' ? { ...sent, messageId } : sent
  }

  /**
   * Who sends this run's prompt, recorded as `source.principal` on it: the
   * job, what started the run, and the event channels of an event run.
   * @returns {{ kind: 'cron-job', channel: 'cron', id: string, name: string, trigger: string, events?: string[] }}
   */
  promptPrincipal() {
    const { job, current } = this
    return {
      kind: 'cron-job',
      channel: 'cron',
      id: jobKey(job),
      name: job.name,
      trigger: current?.rerunOf ? 'rerun' : current?.trigger ?? 'schedule',
      ...(current?.events?.channels?.length ? { events: [...current.events.channels] } : {}),
    }
  }

  /** Send the prompt to the target session, a reused one, or a new one. */
  async deliverPrompt({ job, target, text, messageId, settings, firedAt, localTime }) {
    const { logger } = this
    if (target.kind === 'session') return this.sendToTarget(target.sessionId, text, { mayUnarchive: true, messageId })

    const archive = settings.autoArchive && this.settle !== undefined ? { archive: 'pending' } : {}
    let reuseNote
    if (target.kind === 'new_once' && target.sessionId) {
      const sent = await this.sendToTarget(target.sessionId, text, { mayUnarchive: settings.autoArchive, archive, messageId })
      if (sent.status === 'woke') return sent
      reuseNote = `session ${target.sessionId} not reached: ${sent.error}`
      logger.warn('[%s] %s; opening a new session', job.name, reuseNote)
    }
    const previous = target.kind === 'new' ? this.reusableRun(settings, firedAt) : undefined
    if (previous !== undefined) {
      try {
        const sent = await this.withSessionLock(previous.sessionId, async () => {
          const delivered = await this.reuse({ sessionId: previous.sessionId, text, messageId, principal: this.promptPrincipal(), mayUnarchive: settings.autoArchive })
          // Inside the lock, so an earlier run's archive wait sees it was superseded.
          this.latestRun.set(previous.sessionId, null)
          return delivered
        })
        logger.info('[%s] sent the prompt to session %s%s', job.name, previous.sessionId, sent?.queued ? ' (queued behind its current turn)' : '')
        return {
          status: 'woke',
          sessionId: previous.sessionId,
          sessionOpenedAt: previous.sessionOpenedAt ?? previous.startedAt,
          reused: true,
          ...(sent?.queued ? { queued: true } : {}),
          ...archive,
        }
      } catch (error) {
        reuseNote = `session ${previous.sessionId} not reused: ${describeError(error)}`
        logger.warn('[%s] %s; opening a new session', job.name, reuseNote)
      }
    }
    try {
      const opened = await this.wake({
        text,
        messageId,
        principal: this.promptPrincipal(),
        title: sessionTitle(job.name, localTime),
        ...(job.agent.preset ? { agentPreset: job.agent.preset } : {}),
        ...(agentModel(job) ? { model: agentModel(job) } : {}),
        ...(settings.cwd ? { cwd: settings.cwd } : {}),
      })
      const sessionId = typeof opened === 'string' ? opened : opened.sessionId
      this.latestRun.set(sessionId, null)
      logger.info('[%s] woke agent in session %s', job.name, sessionId)
      if (target.kind === 'new_once') {
        try {
          await this.keepSession?.(sessionId)
        } catch (error) {
          logger.warn('[%s] session %s not saved as the job\'s session: %s', job.name, sessionId, describeError(error))
        }
      }
      return {
        status: 'woke',
        sessionId,
        sessionOpenedAt: firedAt.toISOString(),
        ...(target.kind === 'new_once' ? { targeted: true } : {}),
        ...(reuseNote ? { reuseNote } : {}),
        ...archive,
      }
    } catch (error) {
      const reason = describeError(error)
      logger.warn('[%s] could not wake agent: %s', job.name, reason)
      return { status: 'wake-failed', error: reason, ...(reuseNote ? { reuseNote } : {}) }
    }
  }

  /**
   * Send the prompt to the job's target session: an existing session the job
   * names, or the one a new_once job opened. Delivered even when a person
   * uses the session (unless `ignoreHold` is false, as for a rerun into a
   * session the job opened for itself); that is what the target is for. An
   * archived session is unarchived first when `mayUnarchive` is set.
   * `fields` describe the run's session in its outcome.
   * @returns {Promise<object>} The run outcome; `wake-failed` with the reason when not delivered.
   */
  async sendToTarget(sessionId, text, { mayUnarchive, ignoreHold = true, archive = {}, messageId, fields = { targeted: true } }) {
    const { job, logger } = this
    if (this.reuse === undefined) return { status: 'wake-failed', error: 'this host cannot deliver to existing sessions' }
    try {
      const sent = await this.withSessionLock(sessionId, async () => {
        const delivered = await this.reuse({ sessionId, text, messageId, principal: this.promptPrincipal(), mayUnarchive, ignoreHold })
        this.latestRun.set(sessionId, null)
        return delivered
      })
      logger.info('[%s] sent the prompt to its session %s%s', job.name, sessionId, sent?.queued ? ' (queued behind its current turn)' : '')
      return { status: 'woke', sessionId, ...fields, ...(sent?.queued ? { queued: true } : {}), ...archive }
    } catch (error) {
      const reason = describeError(error)
      logger.warn('[%s] could not send the prompt to session %s: %s', job.name, sessionId, reason)
      return { status: 'wake-failed', sessionId, error: reason }
    }
  }

  /**
   * The job's previous woken run whose session may take this prompt: the
   * newest run with a session, opened (first woken) within the reuse window.
   * The window counts from the session's first wake, not its latest reuse, so
   * a frequent job still starts a fresh session every `reuseWithinHours`.
   * Only sessions this plugin opened for this job are candidates.
   */
  reusableRun(settings, firedAt) {
    if (!(settings.reuseWithinHours > 0) || this.reuse === undefined) return undefined
    const previous = this.history.runs(jobKey(this.job)).find(run => run.sessionId && run.status === 'woke' && !run.targeted)
    if (previous === undefined) return undefined
    const opened = Date.parse(previous.sessionOpenedAt ?? previous.startedAt)
    if (!Number.isFinite(opened)) return undefined
    const age = firedAt.getTime() - opened
    return age >= 0 && age < settings.reuseWithinHours * HOUR_MS ? previous : undefined
  }

  /**
   * Archive a woken session once its turn is over and save the result in the
   * run's history. Runs in the background: a tick never waits for an agent.
   * A later run that sends to the same session takes over the archive.
   */
  watchArchive(sessionId, runId) {
    const { job, logger } = this
    this.latestRun.set(sessionId, runId)
    const watch = (async () => {
      const result = await this.settle(sessionId, {
        signal: this.signal,
        isLatest: () => this.latestRun.get(sessionId) === runId,
        lock: fn => this.withSessionLock(sessionId, fn),
      })
      // Unloading: leave 'pending' for the next copy of the plugin to finish.
      if (result.archive === 'pending' || this.signal?.aborted) return
      if (this.latestRun.get(sessionId) === runId) this.latestRun.delete(sessionId)
      if (result.archive === 'archived') logger.info('[%s] archived session %s', job.name, sessionId)
      else if (result.archive === 'kept') logger.info('[%s] kept session %s: %s', job.name, sessionId, result.note)
      await this.history.update(jobKey(job), runId, { archive: result.archive, archiveNote: result.note })
    })().catch((error) => {
      logger.warn('[%s] archive of session %s failed: %s', job.name, sessionId, describeError(error))
      if (!this.signal?.aborted) return this.history.update(jobKey(job), runId, { archive: 'kept', archiveNote: describeError(error) })
    }).finally(() => this.settling.delete(watch))
    this.settling.add(watch)
    return watch
  }

  /**
   * After a restart or config reload: finish archives an earlier copy of the
   * plugin left pending. The newest pending run of each session takes it;
   * older ones on the same session are marked superseded.
   */
  async resumeArchives() {
    if (this.settle === undefined) return
    const seen = new Set()
    for (const run of this.history.runs(jobKey(this.job))) {
      if (run.archive !== 'pending' || !run.sessionId) continue
      if (seen.has(run.sessionId)) {
        await this.history.update(jobKey(this.job), run.id, { archive: 'superseded' })
        continue
      }
      seen.add(run.sessionId)
      this.watchArchive(run.sessionId, run.id)
    }
  }

  /** Run fn after any earlier delivery or archive of the same session. */
  withSessionLock(sessionId, fn) {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    const tail = next.catch(() => {})
    this.locks.set(sessionId, tail)
    tail.then(() => { if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId) })
    return next
  }

  logResult(result) {
    const { job, logger } = this
    const seconds = (result.durationMs / 1000).toFixed(1)
    const outcome = describeOutcome(result, job)
    const log = result.ok ? logger.info : logger.warn
    log.call(logger, '[%s] %s in %ss', job.name, outcome, seconds)
    const out = tail(result.stdout)
    const err = tail(result.stderr)
    if (out) log.call(logger, '[%s] stdout: %s', job.name, out)
    if (err) log.call(logger, '[%s] stderr: %s', job.name, err)
  }
}

/** One-phrase result of a command run, as used in the log and run records. */
function describeOutcome(result, job) {
  if (result.error !== undefined) return `error: ${result.error}`
  if (result.timedOut) return `timed out after ${job.timeoutSeconds}s`
  if (result.aborted) return 'stopped'
  if (result.signal) return `killed by ${result.signal}`
  return `exit ${result.exitCode}`
}

function tail(text, limit = LOG_TAIL_CHARS) {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `…${trimmed.slice(-limit)}`
}

function describeError(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
