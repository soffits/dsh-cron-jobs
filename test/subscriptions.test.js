import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronJobs, JobInputError } from '../src/controller.js'
import { HistoryStore, memoryTable } from '../src/history.js'

const quiet = { info() {}, warn() {}, error() {} }
const NOW = new Date('2026-11-14T03:00:00.000Z')
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

function setup({ jobs = [], stdout = 'news\n', running } = {}) {
  const runs = []
  const wakes = []
  const deliveries = []
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const controller = new CronJobs({
    jobs,
    logger: quiet,
    history,
    now: () => NOW,
    watchdogMs: 0,
    events: { coalesceSeconds: 0, maxRunsPerHour: 0 },
    CronClass: class { constructor() {} nextRun() { return null } stop() {} },
    run: async (options) => {
      runs.push(options)
      if (running) await running
      return { ok: true, exitCode: 0, stdout, stderr: '', stdoutDropped: 0, durationMs: 3 }
    },
    wake: async (request) => { wakes.push(request); return `session-new-${wakes.length}` },
    reuse: async (request) => { deliveries.push(request); return { queued: false } },
  }).start()
  return { controller, runs, wakes, deliveries, history }
}

const base = { cwd: '/tmp', target: { kind: 'new' } }

test('a job with on and no schedule runs on a matching event, with the events on stdin and in the prompt', async () => {
  const { controller, runs, wakes, history } = setup()
  const job = await controller.create({ ...base, title: 'Mail', prompt: 'Read the mail.', command: 'gate', on: ['mail.*'] })
  assert.equal(job.state, 'active')
  assert.equal(job.schedule, null)
  assert.deepEqual(job.on, ['mail.*'])
  assert.equal(job.nextRunAt, null)

  let released = 0
  assert.deepEqual(controller.emit({ channel: 'calendar.x' }), { matched: [] })
  assert.deepEqual(controller.emit({ channel: 'mail.inbox', data: { state: 's2' } }, () => released++), { matched: [job.id] })
  await tick()
  assert.equal(released, 1)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].env.DSH_CRON_TRIGGER, 'event')
  assert.equal(runs[0].env.DSH_CRON_JOB, job.id)
  const input = JSON.parse(runs[0].input)
  assert.equal(input.trigger, 'event')
  assert.deepEqual(input.events[0].data, { state: 's2' })
  assert.equal(wakes.length, 1)
  assert.match(wakes[0].text, /Events that started this run/)
  assert.match(wakes[0].text, /"state":"s2"/)
  assert.deepEqual(wakes[0].principal, { kind: 'cron-job', channel: 'cron', id: job.id, name: 'Mail', trigger: 'event', events: ['mail.inbox'] })
  const [run] = history.runs(job.id)
  assert.equal(run.trigger, 'event')
  assert.deepEqual(run.events, { count: 1, channels: ['mail.inbox'] })
})

test('scheduled runs get no stdin but know their trigger', async () => {
  const { controller, runs } = setup()
  const job = await controller.create({ ...base, title: 'Plain', command: 'echo hi', schedule: { cron: '0 * * * *', timeZone: 'UTC' } })
  controller.runNow(job.id)
  await tick()
  assert.equal(runs[0].input, undefined)
  assert.equal(runs[0].env.DSH_CRON_TRIGGER, 'manual')
})

test('paused jobs and other channels take no events; a duplicate key is dropped', async () => {
  const { controller, runs } = setup()
  const job = await controller.create({ ...base, title: 'CI', command: 'true', on: ['ci.run'] })
  await controller.setPaused(job.id, true)
  assert.deepEqual(controller.emit({ channel: 'ci.run' }).matched, [])
  await controller.setPaused(job.id, false)
  assert.deepEqual(controller.emit({ channel: 'ci.run', key: '42' }).matched, [job.id])
  assert.deepEqual(controller.emit({ channel: 'ci.run', key: '42' }), { matched: [], duplicate: true })
  await tick()
  assert.equal(runs.length, 1)
})

test('a once job ends after its first event run; a manual run does not end it', async () => {
  const { controller, wakes } = setup()
  const job = await controller.create({ ...base, title: 'Verify DSH after restart', prompt: 'Check DSH.', on: ['dsh.started'], once: true })
  controller.runNow(job.id)
  await tick()
  assert.equal(controller.get(job.id).state, 'active')
  controller.emit({ channel: 'dsh.started' })
  await tick()
  assert.equal(wakes.length, 2)
  assert.equal(controller.get(job.id).state, 'ended')
  assert.deepEqual(controller.emit({ channel: 'dsh.started' }).matched, [])
})

test('an event that arrives during a run starts one follow-up run when it ends', async () => {
  let finish
  const running = new Promise(resolve => { finish = resolve })
  const { controller, runs } = setup({ running })
  const job = await controller.create({ ...base, title: 'Feed', command: 'true', on: ['feed'] })
  controller.emit({ channel: 'feed', text: 'one' })
  await tick()
  assert.equal(runs.length, 1)
  controller.emit({ channel: 'feed', text: 'two' })
  controller.emit({ channel: 'feed', text: 'three' })
  await tick()
  assert.equal(runs.length, 1)
  finish()
  await tick()
  await tick()
  assert.equal(runs.length, 2)
  assert.deepEqual(JSON.parse(runs[1].input).events.map(e => e.text), ['two', 'three'])
  assert.equal(controller.get(job.id).running, null)
})

test('editing: on can replace the schedule, an empty cron removes it, and a job needs one of them', async () => {
  const { controller } = setup()
  const job = await controller.create({ ...base, title: 'Mail', prompt: 'Read.', schedule: { cron: '*/15 * * * *', timeZone: 'UTC' } })
  await assert.rejects(controller.update(job.id, { schedule: { cron: '' } }), (error) => error instanceof JobInputError && /schedule, on/.test(error.message))
  let view = await controller.update(job.id, { on: ['mail.inbox'], schedule: { cron: '0 */2 * * *', timeZone: 'America/New_York' } })
  assert.equal(view.schedule.expression, '0 */2 * * *')
  assert.deepEqual(view.on, ['mail.inbox'])
  view = await controller.update(job.id, { schedule: { cron: '' } })
  assert.equal(view.schedule, null)
  assert.equal(view.state, 'active')
  await assert.rejects(controller.update(job.id, { on: [] }), /schedule, on/)
  await assert.rejects(controller.update(job.id, { on: ['bad pattern'] }), /not a channel pattern/)
  await assert.rejects(controller.create({ ...base, title: 'Nothing', prompt: 'x' }), /cron|schedule/i)
})

test('config jobs can subscribe, with or without a schedule', async () => {
  const { controller, runs } = setup({ jobs: [
    { name: 'listener', command: 'true', on: ['alerts.*'] },
    { name: 'broken', command: 'true', on: ['bad pattern'] },
  ] })
  assert.equal(controller.get('listener').state, 'active')
  assert.equal(controller.get('broken').state, 'invalid')
  assert.deepEqual(controller.emit({ channel: 'alerts.disk' }).matched, ['listener'])
  await tick()
  assert.equal(runs.length, 1)
})

test('deleting a job releases its waiting events', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const controller = new CronJobs({
    jobs: [], logger: quiet, history, now: () => NOW, watchdogMs: 0,
    events: { coalesceSeconds: 60 },
    run: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    wake: async () => 's',
  }).start()
  const job = await controller.create({ ...base, title: 'Slow', command: 'true', on: ['x'] })
  let released = 0
  controller.emit({ channel: 'x' }, () => released++)
  assert.equal(controller.get(job.id).pendingEvents.count, 1)
  await controller.remove(job.id)
  assert.equal(released, 1)
  await controller.stop()
})

function slowSetup(events) {
  const wakes = []
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const controller = new CronJobs({
    jobs: [], logger: quiet, history, now: () => NOW, watchdogMs: 0,
    events,
    run: async () => ({ ok: true, exitCode: 0, stdout: 'news\n', stderr: '', durationMs: 1 }),
    wake: async request => { wakes.push(request); return `s${wakes.length}` },
  }).start()
  return { controller, wakes }
}

test('a job\'s own coalesceSeconds replaces the plugin window, and 0 runs at once', async () => {
  const { controller, wakes } = slowSetup({ coalesceSeconds: 600, maxRunsPerHour: 0 })
  const slow = await controller.create({ ...base, title: 'Slow', prompt: 'p', command: 'gate', on: ['a.*'] })
  const quick = await controller.create({ ...base, title: 'Quick', prompt: 'p', command: 'gate', on: ['b.*'], coalesceSeconds: 0 })
  const long = await controller.create({ ...base, title: 'Long', prompt: 'p', command: 'gate', on: ['c.*'], coalesceSeconds: 900 })
  assert.equal(slow.coalesceSeconds, null)
  assert.equal(slow.coalesceEffectiveSeconds, 600)
  assert.equal(quick.coalesceSeconds, 0)
  assert.equal(long.coalesceEffectiveSeconds, 900)

  controller.emit({ channel: 'a.1' })
  controller.emit({ channel: 'c.1' })
  controller.emit({ channel: 'c.2' })
  assert.equal(controller.get(slow.id).pendingEvents.dueAt, new Date(NOW.getTime() + 600_000).toISOString())
  assert.equal(controller.get(long.id).pendingEvents.dueAt, new Date(NOW.getTime() + 900_000).toISOString())
  assert.equal(controller.get(long.id).pendingEvents.count, 2)
  controller.emit({ channel: 'b.1' })
  await tick()
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].principal.id, quick.id)
  await controller.stop()
})

test('coalesceSeconds can be changed, cleared and is checked', async () => {
  const { controller } = slowSetup({ coalesceSeconds: 30 })
  const job = await controller.create({ ...base, title: 'Mail', prompt: 'p', command: 'gate', on: ['mail.*'] })
  assert.equal((await controller.update(job.id, { coalesceSeconds: 900 })).coalesceEffectiveSeconds, 900)
  controller.emit({ channel: 'mail.x' })
  assert.equal(controller.get(job.id).pendingEvents.dueAt, new Date(NOW.getTime() + 900_000).toISOString())
  const cleared = await controller.update(job.id, { coalesceSeconds: null })
  assert.equal(cleared.coalesceSeconds, null)
  assert.equal(cleared.coalesceEffectiveSeconds, 30)
  assert.equal((await controller.update(job.id, { title: 'Mail 2' })).coalesceEffectiveSeconds, 30)
  await assert.rejects(controller.update(job.id, { coalesceSeconds: -5 }), JobInputError)
  await assert.rejects(controller.update(job.id, { coalesceSeconds: 1.5 }), JobInputError)
  await assert.rejects(controller.create({ ...base, title: 'Bad', prompt: 'p', on: ['x'], coalesceSeconds: 'soon' }), JobInputError)
  const plain = await controller.create({ ...base, title: 'Timer', command: 'true', schedule: { cron: '0 * * * *', timeZone: 'UTC' } })
  assert.equal(plain.coalesceEffectiveSeconds, null)
  await controller.stop()
})

test('a config job takes coalesceSeconds too', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const controller = new CronJobs({
    jobs: [{ name: 'cfg', command: 'true', on: ['x'], coalesceSeconds: 120 }],
    logger: quiet, history, now: () => NOW, watchdogMs: 0, events: { coalesceSeconds: 30 },
    run: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
  }).start()
  assert.equal(controller.get('cfg').coalesceEffectiveSeconds, 120)
  controller.emit({ channel: 'x' })
  assert.equal(controller.get('cfg').pendingEvents.dueAt, new Date(NOW.getTime() + 120_000).toISOString())
  await controller.stop()
})

test('a job\'s own maxRunsPerHour replaces the plugin cap, 0 lifts it, and it can be cleared', async () => {
  const { controller, wakes } = slowSetup({ coalesceSeconds: 0, maxRunsPerHour: 1 })
  const capped = await controller.create({ ...base, title: 'Capped', prompt: 'p', command: 'gate', on: ['a.*'] })
  const free = await controller.create({ ...base, title: 'Free', prompt: 'p', command: 'gate', on: ['b.*'], maxRunsPerHour: 0 })
  assert.equal(capped.maxRunsPerHour, null)
  assert.equal(capped.maxRunsPerHourEffective, 1)
  assert.equal(free.maxRunsPerHourEffective, 0)
  for (const channel of ['a.1', 'a.2', 'a.3', 'b.1', 'b.2', 'b.3']) {
    controller.emit({ channel })
    await tick()
  }
  assert.equal(wakes.filter(w => w.principal.id === capped.id).length, 1)
  assert.equal(wakes.filter(w => w.principal.id === free.id).length, 3)
  const raised = await controller.update(capped.id, { maxRunsPerHour: 60 })
  assert.equal(raised.maxRunsPerHourEffective, 60)
  assert.equal((await controller.update(capped.id, { maxRunsPerHour: null })).maxRunsPerHourEffective, 1)
  await assert.rejects(controller.update(capped.id, { maxRunsPerHour: -1 }), JobInputError)
  await assert.rejects(controller.update(capped.id, { maxRunsPerHour: 1.5 }), JobInputError)
  await controller.stop()
})

test('a config job takes maxRunsPerHour too', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const controller = new CronJobs({
    jobs: [{ name: 'cfg', command: 'true', on: ['x'], maxRunsPerHour: 90 }],
    logger: quiet, history, now: () => NOW, watchdogMs: 0, events: { maxRunsPerHour: 6 },
    run: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
  }).start()
  assert.equal(controller.get('cfg').maxRunsPerHourEffective, 90)
  await controller.stop()
})
