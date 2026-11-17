/**
 * Requests to the running plugin from the command line, through a file spool
 * like the event inbox (spool.js): `dsh-cron-apply` drops a declared set
 * there and waits for the result. No port or token; the directory is the
 * owner's (0700).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A request older than this is not applied: the file it came from may have changed since. */
export const REQUEST_MAX_AGE_MS = 10 * 60_000

export function defaultRequestDir(env = process.env) {
  return env.DSH_CRON_REQUESTS_DIR || join(env.DSH_HOME || join(homedir(), '.dsh'), 'cron-jobs', 'requests')
}

/**
 * Carry out one request.
 * @param {import('./controller.js').CronJobs} jobs
 * @param {object} input - `{ type: 'declared', set, jobs, dryRun?, prune?, at }`.
 * @param {{ now?: () => number, checkDeliver?: (target: { via: string, to: string }) => string | undefined }} [options]
 */
export async function handleRequest(jobs, input, { now = Date.now, checkDeliver } = {}) {
  if (input?.type !== 'declared') throw new Error(`unknown request type ${JSON.stringify(input?.type)}`)
  const age = now() - Date.parse(input.at ?? '')
  if (!(age < REQUEST_MAX_AGE_MS)) throw new Error(`request from ${input.at} expired before DSH took it; nothing was changed. Send it again.`)
  return { result: await jobs.applyDeclared({ set: input.set, jobs: input.jobs, dryRun: input.dryRun === true, prune: input.prune !== false, checkDeliver }) }
}
