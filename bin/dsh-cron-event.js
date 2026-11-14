#!/usr/bin/env node
/**
 * Emit an event for dsh-cron-jobs: every job whose `on` matches the channel
 * runs. The event goes through the plugin's inbox directory under
 * $DSH_HOME/cron-jobs/events, so it needs no port or token, and it waits
 * there while DSH is not running.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { defaultEventDir, isChannel } from '../src/events.js'
import { enqueueEvent, waitForEventResult } from '../src/spool.js'

const usage = `Usage: dsh-cron-event <channel> [--data <json> | --data - | --text <text>]
                      [--id <dedupe key>] [--source <label>] [--no-wait] [--timeout <seconds>]

Emits one event on <channel> (dot-separated names, such as mail.sakina or
ci.run.123). Jobs whose on patterns match it run once the events around it are
gathered (about 30 s). The event is a hint: jobs check the source themselves.

  --data <json>     JSON data for the event; "-" reads it from stdin (JSON, or
                    plain text when it does not parse)
  --text <text>     plain text instead of data
  --id <key>        dedupe key: a second event with the same channel and key
                    within an hour is dropped
  --source <label>  who sent it, shown to the job
  --no-wait         return at once instead of waiting for DSH to take it
  --timeout <s>     how long to wait (default 10)

Prints {"matched": [job ids]} when DSH took the event.
Exit codes: 0 taken (or queued with --no-wait), 1 refused, 2 bad arguments,
3 still queued after the timeout (DSH takes it once it runs).`

let options
try {
  options = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: 'string', short: 'd' },
      text: { type: 'string', short: 't' },
      id: { type: 'string' },
      source: { type: 'string', short: 's' },
      'no-wait': { type: 'boolean' },
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
const fail = (message) => {
  process.stderr.write(`${message}\n\n${usage}\n`)
  process.exit(2)
}
if (positionals.length !== 1) fail('Give exactly one channel.')
const channel = positionals[0].trim()
if (!isChannel(channel)) fail(`${JSON.stringify(channel)} is not a channel name: dot-separated names of letters, digits, _ : -`)
if (values.data !== undefined && values.text !== undefined) fail('Give --data or --text, not both.')

const event = { channel }
if (values.data === '-') {
  const raw = readFileSync(0, 'utf8')
  try {
    event.data = JSON.parse(raw)
  } catch {
    event.text = raw
  }
} else if (values.data !== undefined) {
  try {
    event.data = JSON.parse(values.data)
  } catch (error) {
    fail(`--data is not JSON: ${error.message}`)
  }
}
if (values.text !== undefined) event.text = values.text
if (values.id !== undefined && values.id.trim() !== '') event.key = values.id.trim()
event.source = values.source?.trim() || 'dsh-cron-event'

const dir = defaultEventDir()
const wait = !values['no-wait']
const id = await enqueueEvent(event, { dir, wait })
if (!wait) {
  process.stdout.write(`${JSON.stringify({ queued: id })}\n`)
  process.exit(0)
}
const seconds = Number(values.timeout ?? 10)
const result = await waitForEventResult(id, { dir, timeoutMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 10) * 1000 })
if (result === undefined) {
  process.stderr.write(`Still queued as ${id}: DSH did not take it in time. It is taken once DSH runs.\n`)
  process.exit(3)
}
if (!result.ok) {
  process.stderr.write(`${result.error}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify({ matched: result.matched ?? [], ...(result.duplicate ? { duplicate: true } : {}) })}\n`)
