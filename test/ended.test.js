import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronJobs } from '../src/controller.js'
import { Config } from '../src/config.js'
import { HistoryStore, memoryTable } from '../src/history.js'
import { modelJob } from '../tools.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
const HOUR = 3600_000
const START = new Date('2026-11-08T12:00:00.000Z')

/** Schedule-timer stand-in: fires only when the test says so. */
function fakeTimers() {
  const timers = []
  class FakeTimer {
    constructor(schedule, options) {
      this.schedule = schedule
      this.options = options
      this.paused = options.paused
      this.due = options.first ?? schedule.next(options.now())
      timers.push(this)
    }
    nextRun() { return this.due ?? null }
    pause() { this.paused = true }
    resume() { this.paused = false; if (this.due && this.due.getTime() <= this.options.now()) this.due = this.schedule.next(this.options.now()) }
    stop() {}
    fire() {
      const occurrence = this.due
      this.due = this.schedule.next(Math.max(this.options.now(), occurrence.getTime()))
      this.options.onFire(occurrence)
    }
  }
  return { FakeTimer, timers }
}

/** A scheduler on a clock the test moves; `lines` collects info logs and `records` the run log. */
function setup({ jobs = [], history = new HistoryStore({ table: memoryTable(), logger: quietLogger() }), retention, sweepMs = 0, wake, run } = {}) {
  const clock = { time: START.getTime() }
  const lines = []
  const records = []
  const { FakeTimer, timers } = fakeTimers()
  const controller = new CronJobs({
    jobs,
    logger: { info: (...args) => lines.push(args), warn() {}, error() {} },
    history,
    now: () => new Date(clock.time),
    TimerClass: FakeTimer,
    CronClass: class { constructor() {} nextRun() { return null } stop() {} },
    run: run ?? (async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', stdoutDropped: 0, durationMs: 1 })),
    wake: wake ?? (async () => 'session-woken'),
    reuse: async () => ({ queued: false }),
    record: async entry => { records.push(entry) },
    sweepMs,
    ...(retention === undefined ? {} : { endedRetentionHours: retention }),
  }).start()
  return { controller, history, timers, clock, lines, records }
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} }
}

const oneShot = { title: 'Check the parcel', command: 'true', schedule: { at: '2026-11-08T13:00:00Z' }, target: { kind: 'new' } }

/** Create a one-time job and let it run, so it ends. */
async function endOneShot(env, input = oneShot) {
  const job = await env.controller.create(input)
  env.timers.at(-1).fire()
  await settle()
  await settle()
  assert.equal(env.controller.get(job.id).state, 'ended')
  return job
}

test('a job that ends is stamped, kept for the retention and then removed with its history', async () => {
  const env = setup()
  const job = await endOneShot(env)
  const endedAt = env.history.tasks.get(job.id).endedAt
  assert.equal(endedAt, START.toISOString())
  assert.ok(env.controller.runs(job.id).length > 0, 'it has run history')
  assert.equal(env.controller.get(job.id).removesAt, new Date(START.getTime() + 24 * HOUR).toISOString(), 'default retention is 24 hours')

  env.clock.time += 24 * HOUR - 1000
  assert.deepEqual(await env.controller.sweepEnded(), [], 'not yet')
  assert.ok(env.controller.get(job.id))

  env.clock.time += 1000
  assert.deepEqual(await env.controller.sweepEnded(), [job.id])
  assert.equal(env.controller.get(job.id), undefined)
  assert.equal(env.history.tasks.get(job.id), undefined)
  assert.deepEqual(env.history.runs(job.id), [], 'its run history goes with it')
  const line = env.lines.find(args => /deleted stored job/.test(args[0]))
  assert.ok(line, 'the removal is logged at info level')
  assert.equal(line[1], 'Check the parcel')
  assert.equal(line[2], job.id)
  const removed = env.records.find(entry => entry.event === 'removed')
  assert.equal(removed.jobId, job.id)
  assert.equal(removed.job, 'Check the parcel')
  assert.equal(removed.endedAt, endedAt)
  await env.controller.stop()
})

test('retention is counted in hours and may be a fraction', async () => {
  const env = setup({ retention: 0.5 })
  const job = await endOneShot(env)
  env.clock.time += 29 * 60_000
  assert.deepEqual(await env.controller.sweepEnded(), [])
  env.clock.time += 60_000
  assert.deepEqual(await env.controller.sweepEnded(), [job.id])
  await env.controller.stop()
})

test('retention 0 keeps ended jobs for ever and starts no sweep', async () => {
  const env = setup({ retention: 0, sweepMs: 5 })
  const job = await endOneShot(env)
  env.clock.time += 1000 * HOUR
  assert.deepEqual(await env.controller.sweepEnded(), [])
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(env.controller.get(job.id).state, 'ended')
  assert.equal(env.controller.get(job.id).removesAt, undefined)
  assert.equal(env.controller.sweep, undefined)
  await env.controller.stop()
})

test('config jobs, paused jobs and active jobs are never removed', async () => {
  const env = setup({ jobs: [{ name: 'cfg-once', at: '2026-11-08T12:30:00Z', command: 'true' }] })
  env.timers[0].fire()
  await settle()
  await settle()
  const paused = await env.controller.create({ ...oneShot, title: 'Paused', schedule: { at: '2026-11-20T13:00:00Z' } })
  await env.controller.setPaused(paused.id, true)
  const active = await env.controller.create({ ...oneShot, title: 'Active', schedule: { cron: '0 9 * * *', timeZone: 'UTC' } })
  env.clock.time += 30 * 24 * HOUR
  assert.equal(env.controller.get('cfg-once').state, 'ended', 'the config job is ended')
  assert.deepEqual(await env.controller.sweepEnded(), [])
  assert.ok(env.controller.get('cfg-once'))
  assert.equal(env.controller.get(paused.id).state, 'paused')
  assert.equal(env.controller.get(active.id).state, 'active')
  await env.controller.stop()
})

test('an ended job without a time (made by an older version) gets one and is removed a retention later', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quietLogger() })
  const first = setup({ history })
  const job = await endOneShot(first)
  await first.controller.stop()
  const { endedAt, ...legacy } = history.tasks.get(job.id)
  await history.tasks.put(job.id, legacy)

  const env = setup({ history })
  env.clock.time += 100 * HOUR
  assert.deepEqual(await env.controller.sweepEnded(), [], 'an upgrade does not remove old ended jobs at once')
  assert.equal(history.tasks.get(job.id).endedAt, new Date(env.clock.time).toISOString())
  env.clock.time += 24 * HOUR
  assert.deepEqual(await env.controller.sweepEnded(), [job.id])
  await env.controller.stop()
})

test('a job that expired while DSH was down is removed at startup', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quietLogger() })
  const first = setup({ history })
  const job = await endOneShot(first)
  await first.controller.stop()

  const clock = START.getTime() + 48 * HOUR
  const second = new CronJobs({
    jobs: [], logger: quietLogger(), history, now: () => new Date(clock),
    TimerClass: fakeTimers().FakeTimer, run: async () => ({}), wake: async () => 's',
  }).start()
  await settle()
  await settle()
  assert.equal(second.get(job.id), undefined)
  assert.equal(history.tasks.get(job.id), undefined)
  await second.stop()
})

test('the periodic sweep removes an expired job without being asked', async () => {
  const env = setup({ sweepMs: 5 })
  const job = await endOneShot(env)
  env.clock.time += 25 * HOUR
  for (let waited = 0; env.controller.get(job.id) && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(env.controller.get(job.id), undefined)
  await env.controller.stop()
})

test('a once job ended by an event is stamped and removed like a one-time schedule', async () => {
  const env = setup()
  const job = await env.controller.create({ title: 'On mail', command: 'true', on: ['mail.inbox'], once: true, coalesceSeconds: 0, target: { kind: 'new' } })
  env.controller.emit({ channel: 'mail.inbox', source: 'test', data: {} })
  for (let waited = 0; env.controller.get(job.id).state !== 'ended' && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(env.controller.get(job.id).state, 'ended')
  assert.equal(env.history.tasks.get(job.id).endedAt, START.toISOString())
  env.clock.time += 24 * HOUR
  assert.deepEqual(await env.controller.sweepEnded(), [job.id])
  await env.controller.stop()
})

test('giving an ended job a new schedule clears its end time, so it is not removed', async () => {
  const env = setup()
  const job = await endOneShot(env)
  env.clock.time += 20 * HOUR
  const again = await env.controller.update(job.id, { schedule: { at: '2026-11-20T09:00:00Z' } })
  assert.equal(again.state, 'active')
  assert.equal(env.history.tasks.get(job.id).endedAt, undefined)
  env.clock.time += 30 * HOUR
  assert.deepEqual(await env.controller.sweepEnded(), [])
  assert.equal(env.controller.get(job.id).state, 'active')
  await env.controller.stop()
})

test('resuming a paused job that has no more runs ends it and stamps the time', async () => {
  const env = setup()
  const job = await env.controller.create({ ...oneShot, schedule: { at: '2026-11-08T14:00:00Z' } })
  await env.controller.setPaused(job.id, true)
  env.clock.time += 5 * HOUR
  const resumed = await env.controller.setPaused(job.id, false)
  assert.equal(resumed.job.state, 'ended')
  assert.equal(env.history.tasks.get(job.id).endedAt, new Date(env.clock.time).toISOString())
  await env.controller.stop()
})

test('an ended job that is run by hand stays until that run finishes', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  const env = setup({
    retention: 1,
    run: async () => {
      if (++calls > 1) await gate
      return { ok: true, exitCode: 0, stdout: '', stderr: '', stdoutDropped: 0, durationMs: 1 }
    },
  })
  const job = await endOneShot(env)
  assert.equal(env.controller.runNow(job.id).ok, true)
  env.clock.time += 2 * HOUR
  assert.deepEqual(await env.controller.sweepEnded(), [], 'the run is going')
  release()
  for (let waited = 0; env.controller.entries.get(job.id).runner.running && waited < 1000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(await env.controller.sweepEnded(), [job.id])
  await env.controller.stop()
})

test('a recent run that waits for its delivery holds the removal, a stale one does not', async () => {
  const env = setup({ retention: 1 })
  const job = await endOneShot(env)
  const [run] = env.controller.runs(job.id)
  await env.history.update(job.id, run.id, { delivery: { status: 'pending', via: 'chat', to: 'x' } })
  env.clock.time += 2 * HOUR
  assert.deepEqual(await env.controller.sweepEnded(), [], 'waiting for the delivery')
  env.clock.time += 25 * HOUR
  assert.deepEqual(await env.controller.sweepEnded(), [job.id], 'a day-old wait is stale')
  await env.controller.stop()
})

test('the config takes endedRetentionHours: 24 by default, 0 and fractions allowed, negatives refused', () => {
  assert.equal(Config({}).endedRetentionHours, 24)
  assert.equal(Config({ endedRetentionHours: 0 }).endedRetentionHours, 0)
  assert.equal(Config({ endedRetentionHours: 0.25 }).endedRetentionHours, 0.25)
  assert.throws(() => Config({ endedRetentionHours: -1 }))
})

test('the model sees when an ended job will be removed', async () => {
  const env = setup()
  const job = await endOneShot(env)
  const shown = modelJob(env.controller.get(job.id))
  assert.equal(shown.state, 'ended')
  assert.equal(shown.removesAt, new Date(START.getTime() + 24 * HOUR).toISOString())
  await env.controller.stop()
})

test('the plugin passes the row setting through: an expired job goes at startup, a retention of 0 keeps it', async () => {
  const { apply } = await import('../index.js')
  const ended = id => ({
    id, title: `Ended ${id}`, command: 'true', schedule: { kind: 'at', at: '2026-01-01T00:00:00.000Z' }, target: { kind: 'new' },
    status: 'ended', endedAt: '2026-01-01T00:00:01.000Z', createdAt: '2025-12-31T00:00:00.000Z', updatedAt: '2025-12-31T00:00:00.000Z',
  })
  async function run(retention) {
    const tables = {}
    const effects = []
    const lines = []
    const ctx = {
      logger: () => ({ info: (...args) => lines.push(args), warn() {}, error() {} }),
      storageDomain: {
        async open() {
          return { table: name => (tables[name] ??= memoryTable()), close: async () => {} }
        },
      },
      effect: fn => { effects.push(fn()) },
      get: () => undefined,
      inject: () => {},
    }
    // The stored job has to be in the table before the scheduler reads it.
    tables.tasks = memoryTable()
    await tables.tasks.put('job-old00001', ended('job-old00001'))
    apply(ctx, Config(retention === undefined ? {} : { endedRetentionHours: retention }))
    for (let waited = 0; tables.tasks.get('job-old00001') && waited < 300; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
    const kept = tables.tasks.get('job-old00001') !== undefined
    await effects[0]()
    return { kept, lines }
  }
  const byDefault = await run()
  assert.equal(byDefault.kept, false)
  assert.ok(byDefault.lines.some(args => /deleted stored job/.test(args[0]) && args[1] === 'Ended job-old00001' && args[2] === 'job-old00001'))
  assert.equal((await run(0)).kept, true)
})
