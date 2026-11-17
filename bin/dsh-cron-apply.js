#!/usr/bin/env node
/**
 * Apply a declared set of jobs to the running dsh-cron-jobs plugin (or plan
 * it with --dry-run), through its request inbox under
 * $DSH_HOME/cron-jobs/requests. See "Declared sets" in the README.
 */
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultRequestDir } from '../src/requests.js'
import { enqueueEvent, waitForEventResult } from '../src/spool.js'

const usage = `Usage: dsh-cron-apply --set <name> --file <path | -> [--dry-run] [--no-prune] [--timeout <seconds>]

Makes the jobs of declared set <name> match the list given as JSON (a list of
jobs, or {"jobs": [...]}) in --file ("-" reads stdin): new keys are created, jobs
whose fields differ are changed, members of the set that left the list are
removed. Jobs made with the tools and other sets are never touched.

Each job: key (stable name in the set), title, prompt and/or command, cron +
timeZone | rrule | at, on, once, coalesceSeconds, cwd, preset, target
(new | new_once) or sessionId, deliver ("<service>:<address>", "none", or
"default"), model {provider, model, reasoningEffort}, timeoutSeconds, paused,
and adopt (the id of a tool-made job to take over, keeping its history).

  --dry-run         print what would change, change nothing
  --no-prune        keep members that are not in the list
  --timeout <s>     how long to wait for DSH (default 30)

Prints the plan or result as JSON: create, update (with changes), adopt,
remove, unchanged.
Exit codes: 0 done, 1 refused (nothing changed), 2 bad arguments, 3 DSH did
not take the request in time (it is withdrawn and never applied later).`

let options
try {
  options = parseArgs({
    options: {
      set: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-prune': { type: 'boolean' },
      file: { type: 'string', short: 'f' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage}\n`)
  process.exit(2)
}
const { values } = options
if (values.help) {
  process.stdout.write(`${usage}\n`)
  process.exit(0)
}
const fail = (message) => {
  process.stderr.write(`${message}\n\n${usage}\n`)
  process.exit(2)
}
if (!values.set) fail('Give --set <name>.')
if (!values.file) fail('Give --file <path>, or --file - to read the list from stdin.')
let jobs
try {
  const parsed = JSON.parse(readFileSync(values.file === '-' ? 0 : values.file, 'utf8'))
  jobs = Array.isArray(parsed) ? parsed : parsed?.jobs
} catch (error) {
  fail(`The job list is not JSON: ${error.message}`)
}
if (!Array.isArray(jobs)) fail('Give a list of jobs, or an object with a "jobs" list.')

const dir = defaultRequestDir()
const id = await enqueueEvent({ type: 'declared', set: values.set, jobs, dryRun: values['dry-run'] === true, prune: values['no-prune'] !== true }, { dir, wait: true })
const seconds = Number(values.timeout ?? 30)
const result = await waitForEventResult(id, { dir, timeoutMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000 })
if (result === undefined) {
  // Withdraw it, so a later DSH start never applies an old list.
  let withdrawn = true
  try {
    await rm(join(dir, `${id}.json`))
  } catch {
    withdrawn = false
  }
  process.stderr.write(withdrawn
    ? 'DSH did not take the request in time (is it running?); it was withdrawn and nothing changed.\n'
    : 'DSH took the request but did not answer in time; check the jobs before sending it again.\n')
  process.exit(3)
}
if (!result.ok) {
  process.stderr.write(`${result.error}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`)
