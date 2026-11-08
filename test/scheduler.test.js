import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startJobs } from '../src/scheduler.js'
import { Config } from '../src/config.js'

function makeLogger() {
  const lines = []
  const record = level => (format, ...args) => {
    let i = 0
    lines.push(`${level} ${String(format).replace(/%s/g, () => String(args[i++]))}`)
  }
  return { lines, info: record('info'), warn: record('warn'), error: record('error') }
}

test('schedules enabled jobs, skips disabled, invalid and duplicate ones', () => {
  const logger = makeLogger()
  const config = Config({
    jobs: [
      { name: 'a', cron: '*/5 * * * *', command: 'true' },
      { name: 'b', cron: '0 9 * * *', timeZone: 'Europe/Berlin', command: 'true', enabled: false },
      { name: 'c', cron: 'not a cron', command: 'true' },
      { name: 'd', cron: '* * * * *', timeZone: 'Not/AZone', command: 'true' },
      { name: 'a', cron: '* * * * *', command: 'true' },
    ],
  })
  const scheduled = startJobs({ jobs: config.jobs, logger, run: async () => ({}), wake: async () => '' })
  try {
    assert.deepEqual([...scheduled.runners.keys()], ['a'])
    assert.ok(logger.lines.some(line => line.startsWith('info [a] scheduled "*/5 * * * *", next run ')))
    assert.ok(logger.lines.some(line => line.startsWith('error [c] not scheduled')))
    assert.ok(logger.lines.some(line => line.startsWith('error [d] not scheduled')))
    assert.ok(logger.lines.some(line => line.startsWith('error [a] duplicate job name')))
  } finally {
    scheduled.stop()
  }
})

test('a cron tick runs the job, and stop() stops the timers', async () => {
  const logger = makeLogger()
  let fire
  let stopped = 0
  class FakeCron {
    constructor(pattern, options, callback) {
      this.options = options
      fire = callback
    }
    nextRun() { return new Date(0) }
    stop() { stopped++ }
  }
  const runs = []
  const scheduled = startJobs({
    jobs: [{ name: 'x', cron: '* * * * *', timeZone: 'UTC', command: 'echo', enabled: true }],
    logger,
    CronClass: FakeCron,
    run: async (options) => {
      runs.push(options)
      return { ok: true, exitCode: 0, signal: null, stdout: '', stderr: '', stdoutDropped: 0, durationMs: 1 }
    },
    wake: async () => '',
  })
  fire()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs.length, 1)
  scheduled.stop()
  assert.equal(stopped, 1)
})

test('config defaults', () => {
  const config = Config({ jobs: [{ name: 'a', cron: '* * * * *', command: 'true' }] })
  assert.equal(config.jobs[0].enabled, true)
  assert.equal(config.jobs[0].timeoutSeconds, 3600)
  assert.deepEqual(Config({}), { jobs: [], historyRecords: 50 })
  assert.throws(() => Config({ jobs: [{ name: 'a', command: 'true' }] }), /cron/)
})
