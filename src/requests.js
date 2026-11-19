/**
 * Requests to the running plugin from the command line, through a file spool
 * like the event inbox (spool.js): `dsh-cron-apply` drops a declared set
 * there and `dsh-cron-run` a job to run now, and each waits for the result. No port or token; the directory is the
 * owner's (0700).
 */
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { enqueueEvent, waitForEventResult } from './spool.js'

/** A request older than this is not applied: the file it came from may have changed since. */
export const REQUEST_MAX_AGE_MS = 10 * 60_000

export function defaultRequestDir(env = process.env) {
  return env.DSH_CRON_REQUESTS_DIR || join(env.DSH_HOME || join(homedir(), '.dsh'), 'cron-jobs', 'requests')
}

/**
 * CLI side: drop one request and wait for its result. A request DSH does not
 * take in time is withdrawn, so a later start never carries out an old one.
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string } | { timeout: 'withdrawn' | 'taken' }>}
 */
export async function sendRequest(request, { dir = defaultRequestDir(), timeoutMs }) {
  const id = await enqueueEvent(request, { dir, wait: true })
  const result = await waitForEventResult(id, { dir, timeoutMs })
  if (result !== undefined) return result
  try {
    await rm(join(dir, `${id}.json`))
    return { timeout: 'withdrawn' }
  } catch {
    return { timeout: 'taken' }
  }
}

/**
 * Carry out one request.
 * @param {import('./controller.js').CronJobs} jobs
 * @param {object} input - `{ type: 'declared', set, jobs, dryRun?, prune?, at }`, `{ type: 'release', set, dryRun?, at }` or `{ type: 'run', id, at }`.
 * @param {{ now?: () => number, checkDeliver?: (target: { via: string, to: string }) => string | undefined }} [options]
 */
export async function handleRequest(jobs, input, { now = Date.now, checkDeliver } = {}) {
  if (!['declared', 'release', 'run'].includes(input?.type)) throw new Error(`unknown request type ${JSON.stringify(input?.type)}`)
  const age = now() - Date.parse(input.at ?? '')
  if (!(age < REQUEST_MAX_AGE_MS)) throw new Error(`request from ${input.at} expired before DSH took it; nothing was changed. Send it again.`)
  if (input.type === 'run') return { result: runNow(jobs, input.id) }
  if (input.type === 'release') return { result: await jobs.releaseDeclared({ set: input.set, dryRun: input.dryRun === true }) }
  return { result: await jobs.applyDeclared({ set: input.set, jobs: input.jobs, dryRun: input.dryRun === true, prune: input.prune !== false, checkDeliver }) }
}

/** The page's Run now, from the command line: same call, same refusals. */
function runNow(jobs, id) {
  if (typeof id !== 'string' || id === '') throw new Error('give the id of the job to run')
  const outcome = jobs.runNow(id)
  if (outcome.ok) return { id, startedAt: outcome.startedAt }
  if (outcome.code === 'busy') throw new Error(`job ${id} is already running; nothing was started`)
  if (outcome.code === 'stopped') throw Object.assign(new Error('the scheduler is stopping'), { code: 'unavailable' })
  throw new Error(`no job with id ${JSON.stringify(id)} (a config job's id is its name)`)
}
