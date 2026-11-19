#!/usr/bin/env node
/**
 * Run one job now, outside its schedule: the same call as Run now on the Cron
 * tasks page, so the run lands in the job's history and run log. It goes
 * through the plugin's request inbox under $DSH_HOME/cron-jobs/requests.
 */
import { parseArgs } from 'node:util'
import { sendRequest } from '../src/requests.js'

const usage = `Usage: dsh-cron-run <job id> [--timeout <seconds>]

Starts one run of the job now, the same as Run now on the Cron tasks page: it
does not move the schedule, works for paused and ended jobs, and is refused
while a run of the job is going. A config job's id is its name.

  --timeout <s>     how long to wait for DSH to take it (default 30)

Prints {"id", "startedAt"} once the run has started; it does not wait for the
run to end (its outcome is in the job's history).
Exit codes: 0 started, 1 refused (unknown job, or already running), 2 bad
arguments, 3 DSH did not take it in time (it is withdrawn and never run later).`

let options
try {
  options = parseArgs({
    allowPositionals: true,
    options: {
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage}\n`)
  process.exit(2)
}
const { values, positionals } = options
if (values.help) {
  process.stdout.write(`${usage}\n`)
  process.exit(0)
}
const id = positionals[0]?.trim()
if (positionals.length !== 1 || !id) {
  process.stderr.write(`Give exactly one job id.\n\n${usage}\n`)
  process.exit(2)
}

const seconds = Number(values.timeout ?? 30)
const result = await sendRequest({ type: 'run', id }, { timeoutMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000 })
if (result.timeout !== undefined) {
  process.stderr.write(result.timeout === 'withdrawn'
    ? 'DSH did not take the request in time (is it running?); it was withdrawn and nothing was run.\n'
    : 'DSH took the request but did not answer in time; check the job\'s runs before sending it again.\n')
  process.exit(3)
}
if (!result.ok) {
  process.stderr.write(`${result.error}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify(result.result)}\n`)
