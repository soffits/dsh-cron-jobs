import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronJobs } from '../src/controller.js'
import { CronTimer } from '../src/schedule.js'
import { HistoryStore, memoryTable } from '../src/history.js'
import { createRpcHandler } from '../src/rpc.js'

const quiet = { info() {}, warn() {}, error() {} }

/** Cron stand-in: records pause state and lets the test fire ticks. */
function fakeCron() {
  const timers = new Map()
  class FakeCron {
    constructor(pattern, options, callback) {
      if (pattern === 'bad') throw new Error('invalid cron')
      this.fire = callback
      this.paused = false
      this.stopped = false
      timers.set(pattern, this)
    }
    nextRun() { return new Date('2030-01-01T00:00:00Z') }
    pause() { this.paused = true; return true }
    resume() { this.paused = false; return true }
    stop() { this.stopped = true }
  }
  return { FakeCron, timers }
}

const okResult = { ok: true, exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: 'hello\n', stderr: '', stdoutDropped: 0, durationMs: 7 }

/** A command runner whose runs finish only when the test says so. */
function controllableRun() {
  const pending = []
  return {
    pending,
    run: () => new Promise(resolve => pending.push(resolve)),
    finishAll(result = okResult) { while (pending.length) pending.shift()(result) },
  }
}

function setup(jobs, { history = new HistoryStore({ table: memoryTable(), logger: quiet }), run, wake } = {}) {
  const { FakeCron, timers } = fakeCron()
  const commands = run ?? controllableRun()
  const controller = new CronJobs({
    jobs,
    logger: quiet,
    run: commands.run,
    wake: wake ?? (async () => 'session-9'),
    history,
    CronClass: FakeCron,
  }).start()
  return { controller, timers, commands, history }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('list shows each job with its state, schedule and next run', () => {
  const { controller } = setup([
    { name: 'a', cron: '*/5 * * * *', command: 'true' },
    { name: 'b', cron: '0 9 * * *', command: 'true', enabled: false },
    { name: 'c', cron: 'bad', command: 'true' },
    { name: 'g', cron: '0 * * * *', command: './gate', agent: { prompt: 'look', preset: 'p' }, cwd: '/w' },
    { name: 'a', cron: '* * * * *', command: 'dup' },
    { name: 'm', cron: '0 * * * *', command: './gate', agent: { prompt: 'look', model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } } },
  ])
  const jobs = controller.list()
  assert.deepEqual(jobs.map(job => [job.name, job.state]), [['a', 'active'], ['b', 'disabled'], ['c', 'invalid'], ['g', 'active'], ['m', 'active']])
  assert.equal(jobs[0].nextRunAt, '2030-01-01T00:00:00.000Z')
  assert.equal(jobs[1].nextRunAt, null)
  assert.equal(jobs[2].error, 'invalid cron')
  assert.deepEqual(jobs[3].agent, { prompt: 'look', preset: 'p', cwd: '/w', cwdSource: 'command', model: null, autoArchive: false, reuseWithinHours: 0 })
  assert.deepEqual(jobs[4].agent.model, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
  assert.equal(jobs[0].command, 'true', 'the first copy of a duplicate name wins')
})

test('a scheduled tick is saved as a run with its outcome', async () => {
  const { controller, timers, commands } = setup([{ name: 'a', cron: '* * * * *', command: 'echo hello' }])
  timers.get('* * * * *').fire()
  await settle()
  let [view] = controller.list()
  assert.equal(view.running.trigger, 'schedule')
  assert.equal(view.lastRun.status, 'running')
  commands.finishAll()
  await controller.stop()
  ;[view] = controller.list()
  assert.equal(view.running, null)
  assert.equal(view.lastRun.status, 'done')
  assert.equal(view.lastRun.exitCode, 0)
  assert.equal(view.lastRun.durationMs, 7)
  assert.equal(view.lastRun.stdoutTail, 'hello')
  assert.equal(view.lastRun.trigger, 'schedule')
})

test('run now starts a manual run, refuses a second one while busy, and records a woken session', async () => {
  const { controller, commands } = setup([{ name: 'g', cron: '0 * * * *', command: './gate', agent: { prompt: 'look' } }])
  const started = controller.runNow('g')
  assert.equal(started.ok, true)
  assert.ok(started.startedAt)
  assert.deepEqual(controller.runNow('g'), { ok: false, code: 'busy' })
  assert.deepEqual(controller.runNow('nope'), { ok: false, code: 'not-found' })
  await settle()
  commands.finishAll()
  await controller.stop()
  const [run] = controller.runs('g')
  assert.equal(run.trigger, 'manual')
  assert.equal(run.status, 'woke')
  assert.equal(run.sessionId, 'session-9')
  assert.deepEqual(controller.runNow('g'), { ok: false, code: 'stopped' })
})

test('run now works for paused, disabled and invalid jobs', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  await history.setPaused('p', true)
  const { controller, commands } = setup([
    { name: 'p', cron: '* * * * *', command: 'true' },
    { name: 'd', cron: '* * * * *', command: 'true', enabled: false },
    { name: 'i', cron: 'bad', command: 'true' },
  ], { history })
  for (const name of ['p', 'd', 'i']) assert.equal(controller.runNow(name).ok, true)
  await settle()
  commands.finishAll()
  await controller.stop()
  for (const name of ['p', 'd', 'i']) assert.equal(controller.runs(name)[0].status, 'done')
})

test('pause holds the timer and survives a restart; config disabled wins over it', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const first = setup([{ name: 'a', cron: '* * * * *', command: 'true' }], { history })
  const paused = await first.controller.setPaused('a', true)
  assert.equal(paused.ok, true)
  assert.equal(paused.job.state, 'paused')
  assert.equal(paused.job.nextRunAt, null)
  assert.equal(first.timers.get('* * * * *').paused, true)
  // A tick that still arrives while paused does nothing.
  first.timers.get('* * * * *').fire()
  await settle()
  assert.equal(first.commands.pending.length, 0)
  await first.controller.stop()

  // Restart with the same store: the timer starts held.
  const second = setup([{ name: 'a', cron: '* * * * *', command: 'true' }], { history })
  assert.equal(second.timers.get('* * * * *').paused, true)
  assert.equal(second.controller.list()[0].state, 'paused')
  await second.controller.setPaused('a', false)
  assert.equal(second.timers.get('* * * * *').paused, false)
  assert.equal(second.controller.list()[0].state, 'active')
  await second.controller.setPaused('a', true)
  await second.controller.stop()

  const third = setup([{ name: 'a', cron: '* * * * *', command: 'true', enabled: false }], { history })
  const [view] = third.controller.list()
  assert.equal(view.state, 'disabled')
  assert.equal(view.paused, true)
  assert.deepEqual(await third.controller.setPaused('x', true), { ok: false, code: 'not-found' })
})

test('stop waits for runs in progress so their outcome is saved', async () => {
  const { controller, commands } = setup([{ name: 'a', cron: '* * * * *', command: 'true' }])
  controller.runNow('a')
  await settle()
  let stopped = false
  const stopping = controller.stop().then(() => { stopped = true })
  await settle()
  assert.equal(stopped, false)
  commands.finishAll({ ...okResult, ok: false, exitCode: null, aborted: true })
  await stopping
  assert.equal(controller.runs('a')[0].outcome, 'stopped')
})

test('the page channel serves only the owner and maps controller answers', async () => {
  const { controller, commands } = setup([{ name: 'a', cron: '* * * * *', command: 'true' }])
  const handler = createRpcHandler(() => controller)
  const owner = { principal: { kind: 'owner' } }

  const guest = await handler('list', {}, undefined, { principal: { kind: 'guest' } })
  assert.equal(guest.error.code, 'cron-jobs/forbidden')
  assert.equal((await handler('list', {}, undefined, undefined)).error.code, 'cron-jobs/forbidden')

  const list = await handler('list', {}, undefined, owner)
  assert.equal(list.value.jobs[0].name, 'a')

  assert.equal((await handler('run', { name: 'a' }, undefined, owner)).ok, true)
  assert.equal((await handler('run', { name: 'a' }, undefined, owner)).error.code, 'cron-jobs/busy')
  assert.equal((await handler('run', { name: 'zz' }, undefined, owner)).error.code, 'cron-jobs/not-found')
  await settle()
  commands.finishAll()

  assert.equal((await handler('pause', { name: 'a' }, undefined, owner)).error.code, 'cron-jobs/bad-request')
  const paused = await handler('pause', { name: 'a', paused: true }, undefined, owner)
  assert.equal(paused.value.job.state, 'paused')

  await controller.stop()
  const runs = await handler('runs', { name: 'a' }, undefined, owner)
  assert.equal(runs.value.runs.length, 1)
  assert.equal((await handler('runs', { name: 'zz' }, undefined, owner)).error.code, 'cron-jobs/not-found')
  assert.equal((await handler('nope', {}, undefined, owner)).error.code, 'cron-jobs/not-found')
  assert.equal((await createRpcHandler(() => undefined)('list', {}, undefined, owner)).error.code, 'cron-jobs/unavailable')
})

test('config cron jobs run on CronTimer by default', async () => {
  const controller = new CronJobs({
    jobs: [{ name: 'a', cron: '23 * * * *', timeZone: 'America/Toronto', command: 'true' }],
    logger: quiet, run: async () => okResult, wake: async () => '', watchdogMs: 0,
  }).start()
  try {
    assert.ok(controller.entries.get('a').timer instanceof CronTimer)
    assert.equal(controller.get('a').scheduled, true)
    assert.equal(new Date(controller.get('a').nextRunAt).getUTCMinutes(), 23)
  } finally {
    await controller.stop()
  }
})

test('the watchdog runs a tick whose timer was lost, logs it once, and skips paused jobs', async () => {
  const lines = []
  let clock = new Date('2026-11-08T19:30:00Z')
  const armed = []
  class LostCron {
    constructor(pattern) { this.pattern = pattern }
    // The timer never fired: its due time stays in the past.
    nextRun() { return new Date('2026-11-08T19:23:00Z') }
    arm() { armed.push(this.pattern) }
    pause() {}
    stop() {}
  }
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  await history.setPaused('held', true)
  const controller = new CronJobs({
    jobs: [
      { name: 'lost', cron: 'p1', command: 'true' },
      { name: 'held', cron: 'p2', command: 'true' },
    ],
    logger: quiet, run: async () => okResult, wake: async () => '', history,
    record: async line => { lines.push(line) }, CronClass: LostCron, now: () => clock, watchdogMs: 0,
  }).start()
  assert.deepEqual(controller.checkOverdue(), ['lost'])
  assert.deepEqual(armed, ['p1'], 'the lost timer is re-armed so the tick runs now')
  clock = new Date('2026-11-08T19:31:00Z')
  assert.deepEqual(controller.checkOverdue(), [], 'the same lost tick is reported once')
  const overdue = lines.filter(line => line.event === 'overdue')
  assert.deepEqual(overdue, [{ time: '2026-11-08T19:30:00.000Z', job: 'lost', event: 'overdue', dueAt: '2026-11-08T19:23:00.000Z', lateMs: 420000 }])
  await controller.stop()
})

test('a tick within the grace period is not overdue', async () => {
  const controller = new CronJobs({
    jobs: [{ name: 'a', cron: 'p', command: 'true' }],
    logger: quiet, run: async () => okResult, wake: async () => '',
    CronClass: class { nextRun() { return new Date('2026-11-08T19:23:00Z') } stop() {} },
    now: () => new Date('2026-11-08T19:23:30Z'), watchdogMs: 0,
  }).start()
  assert.deepEqual(controller.checkOverdue(), [])
  await controller.stop()
})

test('the run log gets a line when the scheduler starts and stops', async () => {
  const lines = []
  const controller = new CronJobs({
    jobs: [{ name: 'a', cron: '* * * * *', timeZone: 'UTC', command: 'true' }, { name: 'b', cron: '* * * * *', command: 'true', enabled: false }],
    logger: quiet, run: async () => okResult, wake: async () => '', watchdogMs: 0,
    record: async line => { lines.push(line) }, now: () => new Date('2026-11-08T19:40:02Z'),
  }).start()
  await controller.stop()
  await controller.stop()
  assert.deepEqual(lines, [
    { time: '2026-11-08T19:40:02.000Z', job: null, event: 'scheduler-start', jobs: 2, scheduled: 1 },
    { time: '2026-11-08T19:40:02.000Z', job: null, event: 'scheduler-stop' },
  ])
})
