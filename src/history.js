import { randomUUID } from 'node:crypto'
import { z } from 'zod'

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
 * Storage domain for the plugin's own state, one record per job name.
 * The `single` layout keeps every job in one unit, so job names need no
 * escaping; a record that fails validation is backed up and skipped instead
 * of blocking the whole domain.
 */
export const historyDomain = Object.freeze({
  name: 'cron_jobs',
  version: 1,
  layout: 'single',
  invalidRecords: 'backup-and-skip',
  tables: { jobs: { valueSchema: jobStateSchema } },
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
   */
  constructor({ table, limit = DEFAULT_HISTORY_RECORDS, logger, close = async () => {}, durable = false }) {
    this.table = table
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
        table: domain.table('jobs'), limit, logger, durable: true, close: () => domain.close(),
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
