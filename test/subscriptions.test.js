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
  assert.deepEqual(controller.emit({ channel: 'mail.sakina', data: { state: 's2' } }, () => released++), { matched: [job.id] })
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
  const [run] = history.runs(job.id)
  assert.equal(run.trigger, 'event')
  assert.deepEqual(run.events, { count: 1, channels: ['mail.sakina'] })
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
  let view = await controller.update(job.id, { on: ['mail.sakina'], schedule: { cron: '0 */2 * * *', timeZone: 'America/Toronto' } })
  assert.equal(view.schedule.expression, '0 */2 * * *')
  assert.deepEqual(view.on, ['mail.sakina'])
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
