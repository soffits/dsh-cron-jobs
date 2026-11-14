import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { storedJobSchema } from './store.js'

/** Default number of runs kept per job. */
export const DEFAULT_HISTORY_RECORDS = 50

/** Characters of stdout and of stderr kept with each saved run. */
export const HISTORY_TAIL_CHARS = 1000

const runSchema = z.object({
  id: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  startedAt: z.string(),
  // 'running' while the command runs; afterwards the run's outcome:
  // done, idle, woke, failed, wake-failed, or interrupted (DSH stopped mid-run).
  status: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
  outcome: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  sessionId: z.string().optional(),
  // When the woken session was first opened; reused sessions keep the first run's time.
  sessionOpenedAt: z.string().optional(),
  // The prompt went into the job's previous session instead of a new one.
  reused: z.boolean().optional(),
  // The reused session was busy; the prompt waited for its next turn.
  queued: z.boolean().optional(),
  // Why a reuse candidate was not used and a new session was opened.
  reuseNote: z.string().optional(),
  // The prompt went to the job's target session (an existing session, or the one a new_once job opened).
  targeted: z.boolean().optional(),
  // Auto-archive of the woken session: pending until its turn ends, then
  // archived, kept (see archiveNote), or superseded (a later run reused it).
  archive: z.enum(['pending', 'archived', 'kept', 'superseded']).optional(),
  archiveNote: z.string().optional(),
  // Result delivery: pending until the woken agent's turn ends or the
  // delivery service is running, then sent, silent (nothing to send) or
  // failed (see error).
  delivery: z.object({
    status: z.enum(['pending', 'sent', 'silent', 'failed']),
    via: z.string(),
    to: z.string(),
    // The prompt whose answer is delivered; kept while pending, for a restart.
    messageId: z.string().optional(),
    // A result ready before its service was running (a command's output, a
    // failure note); kept while pending, for a restart.
    message: z.object({ text: z.string(), files: z.array(z.string()) }).optional(),
    attempts: z.number().optional(),
    at: z.string().optional(),
    error: z.string().optional(),
  }).optional(),
  stdoutTail: z.string().optional(),
  stderrTail: z.string().optional(),
  error: z.string().optional(),
})

const jobStateSchema = z.object({
  paused: z.boolean().default(false),
  pausedAt: z.string().optional(),
  runs: z.array(runSchema).default([]),
})

/**
 * Storage domain for the plugin's own state: `jobs` holds run history and
 * pause state, one record per job (config jobs by name, stored jobs by id);
 * `tasks` holds the jobs created with the model-facing tools (see store.js).
 * The `single` layout keeps everything in one unit, so keys need no
 * escaping; a record that fails validation is backed up and skipped instead
 * of blocking the whole domain. A table missing from an older file loads as
 * empty, so adding `tasks` needed no version change.
 */
export const historyDomain = Object.freeze({
  name: 'cron_jobs',
  version: 1,
  layout: 'single',
  invalidRecords: 'backup-and-skip',
  tables: { jobs: { valueSchema: jobStateSchema }, tasks: { valueSchema: storedJobSchema } },
})

/** @typedef {z.infer<typeof runSchema>} Run */
/** @typedef {z.infer<typeof jobStateSchema>} JobState */

const EMPTY = Object.freeze({ paused: false, runs: Object.freeze([]) })

/**
 * Per-job run history and pause state. Reads are synchronous; writes go
 * through one queue so a start, an end and a pause on the same job never
 * overwrite each other. A failed write is logged and does not break the run
 * it describes.
 */
export class HistoryStore {
  /**
   * @param {object} options
   * @param {{ get(key: string): JobState | undefined, entries(): Iterable<[string, JobState]>, put(key: string, value: JobState): Promise<void> }} options.table
   * @param {number} [options.limit] - Runs kept per job; older runs are dropped when a run starts.
   * @param {{ warn: Function }} options.logger
   * @param {() => Promise<void>} [options.close] - Releases the backing storage.
   * @param {boolean} [options.durable] - Whether the table survives a restart.
   * @param {object} [options.tasks] - Table of stored jobs, see store.js; in memory when omitted.
   */
  constructor({ table, limit = DEFAULT_HISTORY_RECORDS, logger, close = async () => {}, durable = false, tasks = memoryTable() }) {
    this.table = table
    this.tasks = tasks
    this.limit = limit
    this.logger = logger
    this.closeTable = close
    this.durable = durable
    this.queue = Promise.resolve()
  }

  /** @param {string} name @returns {JobState} */
  state(name) {
    return this.table.get(name) ?? EMPTY
  }

  /** Runs of one job, newest first. */
  runs(name) {
    return [...this.state(name).runs].reverse()
  }

  /** Latest run of one job, or undefined. */
  lastRun(name) {
    const { runs } = this.state(name)
    return runs[runs.length - 1]
  }

  paused(name) {
    return this.state(name).paused === true
  }

  /**
   * Save a started run and drop the oldest ones beyond the limit.
   * @returns {Promise<string>} The run id.
   */
  async begin(name, { trigger, startedAt }) {
    const id = randomUUID()
    await this.change(name, state => ({
      ...state,
      runs: [...state.runs, { id, trigger, startedAt, status: 'running' }].slice(-this.limit),
    }))
    return id
  }

  /** Complete a saved run with its outcome. */
  async finish(name, id, fields) {
    await this.update(name, id, fields)
  }

  /** Merge fields into a saved run; a run already dropped, or a deleted job, is left alone. */
  async update(name, id, fields) {
    if (this.table.get(name) === undefined) return
    await this.change(name, state => ({
      ...state,
      runs: state.runs.map(run => (run.id === id ? { ...run, ...clean(fields) } : run)),
    }))
  }

  /** Pause or resume a job. */
  async setPaused(name, paused, now = new Date()) {
    await this.change(name, ({ pausedAt, ...state }) => ({
      ...state,
      paused,
      ...(paused ? { pausedAt: now.toISOString() } : {}),
    }))
  }

  /**
   * Mark runs left as running by an earlier process as interrupted: their
   * process is gone, so they will never end on their own.
   */
  async markInterrupted(now = new Date()) {
    const names = []
    for (const [name, state] of this.table.entries()) {
      if (state.runs.some(run => run.status === 'running')) names.push(name)
    }
    for (const name of names) {
      await this.change(name, state => ({
        ...state,
        runs: state.runs.map(run => (run.status === 'running'
          ? { ...run, status: 'interrupted', endedAt: now.toISOString(), outcome: 'DSH stopped during the run' }
          : run)),
      }))
    }
  }

  /** Drop a deleted job's history and pause state. */
  async forget(name) {
    const write = this.queue.then(async () => {
      if (this.table.get(name) !== undefined) await this.table.delete(name)
    }).catch((error) => {
      this.logger.warn('[%s] run history not removed: %s', name, error instanceof Error ? error.message : String(error))
    })
    this.queue = write
    return write
  }

  /** Wait for queued writes, then release the backing storage. */
  async close() {
    await this.queue
    await this.closeTable()
  }

  /** Queue one read-modify-write of a job's record. Never rejects. */
  change(name, fn) {
    const write = this.queue.then(async () => {
      const next = fn(this.state(name))
      await this.table.put(name, next)
    }).catch((error) => {
      this.logger.warn('[%s] run history not saved: %s', name, error instanceof Error ? error.message : String(error))
    })
    this.queue = write
    return write
  }
}

/** A table kept only in memory, used when no storage is available and in tests. */
export function memoryTable() {
  const map = new Map()
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => { map.set(key, value) },
    delete: async (key) => map.delete(key),
  }
}

/**
 * Open the history store in DSH's storage domain service. When the domain
 * cannot be opened, the failure is logged and an in-memory store is used so
 * jobs still run.
 *
 * @param {{ open(spec: object): Promise<{ table(name: string): any, close(): Promise<void> }> } | undefined} storageDomain
 * @param {object} options
 * @param {number} [options.limit]
 * @param {{ warn: Function, error: Function }} options.logger
 * @param {AbortSignal} [options.signal] - Stops retrying.
 * @param {number} [options.retryMs] - Total time to retry while a previous copy of the plugin still holds the domain.
 * @returns {Promise<HistoryStore>}
 */
export async function openHistory(storageDomain, { limit, logger, signal, retryMs = 10_000 }) {
  if (storageDomain === undefined) {
    logger.warn('no storage service; run history is kept in memory only')
    return new HistoryStore({ table: memoryTable(), limit, logger })
  }
  const deadline = Date.now() + retryMs
  for (;;) {
    try {
      const domain = await storageDomain.open(historyDomain)
      const store = new HistoryStore({
        table: domain.table('jobs'), tasks: domain.table('tasks'), limit, logger, durable: true, close: () => domain.close(),
      })
      await store.markInterrupted()
      return store
    } catch (error) {
      // A reloading plugin can start before its previous copy has closed the domain.
      if (error?.code === 'already-open' && Date.now() < deadline && !signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, 250))
        continue
      }
      logger.error('run history storage unavailable, keeping it in memory: %s', error instanceof Error ? error.message : String(error))
      return new HistoryStore({ table: memoryTable(), limit, logger })
    }
  }
}

function clean(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}
