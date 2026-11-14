import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/**
 * Jobs created from a conversation with the model-facing tools. They live in
 * the `tasks` table of the plugin's storage domain (see history.js), next to
 * run history, and survive restarts. Jobs from the plugin config are never
 * stored here.
 */

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expression: z.string().min(1), timeZone: z.string().optional() }),
  z.object({ kind: z.literal('rrule'), rrule: z.string().min(1) }),
  // A UTC instant; timeZone is the zone it was given in, for display.
  z.object({ kind: z.literal('at'), at: z.string().min(1), timeZone: z.string().optional() }),
])

const targetSchema = z.discriminatedUnion('kind', [
  // A new session for every run (session reuse and auto-archive apply).
  z.object({ kind: z.literal('new') }),
  // One new session, opened by the first run; later runs go to it.
  z.object({ kind: z.literal('new_once'), sessionId: z.string().min(1).optional() }),
  // An existing session.
  z.object({ kind: z.literal('session'), sessionId: z.string().min(1) }),
])

// Where results go; false sends nothing; omitted uses the plugin default.
const deliverSchema = z.union([z.literal(false), z.object({ via: z.string().min(1), to: z.string() })])

export const storedJobSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().optional(),
  command: z.string().optional(),
  // Command that checks the agent's final answer before its turn closes (answer-check.js).
  answerCheck: z.string().optional(),
  schedule: scheduleSchema,
  // Directory of the command and of new sessions.
  cwd: z.string().optional(),
  preset: z.string().optional(),
  target: targetSchema,
  timeoutSeconds: z.number().int().min(0).optional(),
  deliver: deliverSchema.optional(),
  // Model of the sessions the job opens; omitted uses the preset or host default.
  model: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() }).optional(),
  status: z.enum(['active', 'paused', 'ended']),
  // Next run; kept so a run missed while DSH was down happens once at startup.
  scheduledAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Session that created the job.
  createdBy: z.string().optional(),
})

/** @typedef {z.infer<typeof storedJobSchema>} StoredJob */

/** Stored jobs, read synchronously; writes are durable before they resolve. */
export class JobStore {
  /**
   * @param {{ get(key: string): any, entries(): Iterable<[string, any]>, put(key: string, value: any): Promise<void>, delete?(key: string): Promise<any> }} table
   */
  constructor(table) {
    this.table = table
  }

  /** @returns {StoredJob[]} oldest first */
  all() {
    return [...this.table.entries()].map(([, job]) => job).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** @returns {StoredJob | undefined} */
  get(id) {
    return this.table.get(id)
  }

  /** @param {StoredJob} job */
  async put(job) {
    await this.table.put(job.id, storedJobSchema.parse(job))
  }

  async delete(id) {
    await this.table.delete(id)
  }

  /** A fresh short id that no stored job and no other name uses. */
  newId(taken = () => false) {
    for (;;) {
      const id = `job-${randomUUID().slice(0, 8)}`
      if (this.get(id) === undefined && !taken(id)) return id
    }
  }
}
