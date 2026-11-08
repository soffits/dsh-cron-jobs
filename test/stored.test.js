import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronJobs, JobInputError } from '../src/controller.js'
import { HistoryStore, memoryTable } from '../src/history.js'
import { ScheduleError } from '../src/schedule.js'

const quiet = { info() {}, warn() {}, error() {} }
const settle = () => new Promise(resolve => setImmediate(resolve))
const NOW = new Date('2026-11-08T12:00:00.000Z')

/** Schedule-timer stand-in: remembers its options and lets the test fire it. */
function fakeTimers() {
  const timers = []
  class FakeTimer {
    constructor(schedule, options) {
      this.schedule = schedule
      this.options = options
      this.paused = options.paused
      this.stopped = false
      this.due = options.first ?? schedule.next(options.now())
      timers.push(this)
    }
    nextRun() { return this.due ?? null }
    pause() { this.paused = true }
    resume() { this.paused = false; if (this.due && this.due.getTime() <= this.options.now()) this.due = this.schedule.next(this.options.now()) }
    stop() { this.stopped = true }
    fire() {
      const occurrence = this.due
      this.due = this.schedule.next(Math.max(this.options.now(), occurrence.getTime()))
      this.options.onFire(occurrence)
    }
  }
  return { FakeTimer, timers }
}

function setup({ jobs = [], history = new HistoryStore({ table: memoryTable(), logger: quiet }), now = () => NOW } = {}) {
  const { FakeTimer, timers } = fakeTimers()
  const runs = []
  const wakes = []
  const deliveries = []
  const controller = new CronJobs({
    jobs,
    logger: quiet,
    history,
    now,
    TimerClass: FakeTimer,
    CronClass: class { constructor() {} nextRun() { return null } stop() {} },
    run: async (options) => { runs.push(options); return { ok: true, exitCode: 0, stdout: 'news\n', stderr: '', stdoutDropped: 0, durationMs: 3 } },
    wake: async (request) => { wakes.push(request); return `session-new-${wakes.length}` },
    reuse: async (request) => { deliveries.push(request); return { queued: false } },
  }).start()
  return { controller, timers, runs, wakes, deliveries, history }
}

const reminder = {
  title: 'Check the parcel',
  prompt: 'Has the parcel arrived?',
  schedule: { at: '2026-11-09T09:00', timeZone: 'America/Toronto' },
  cwd: '/home/me',
  preset: 'helper',
  target: { kind: 'session', sessionId: 'session-chat' },
  createdBy: 'session-chat',
}

test('create stores an agent-only job with its schedule, directory, preset and target', async () => {
  const { controller, history, timers } = setup()
  const job = await controller.create(reminder)
  assert.match(job.id, /^job-[0-9a-f]{8}$/)
  assert.equal(job.source, 'tool')
  assert.equal(job.kind, 'agent')
  assert.equal(job.state, 'active')
  assert.equal(job.nextRunAt, '2026-11-09T14:00:00.000Z')
  assert.deepEqual(job.target, { kind: 'session', sessionId: 'session-chat' })
  assert.equal(job.agent.preset, 'helper')
  assert.equal(job.agent.cwd, '/home/me')
  assert.equal(job.agent.autoArchive, false)
  assert.equal(job.createdBy, 'session-chat')
  const stored = history.tasks.get(job.id)
  assert.equal(stored.scheduledAt, '2026-11-09T14:00:00.000Z')
  assert.deepEqual(stored.schedule, { kind: 'at', at: '2026-11-09T14:00:00.000Z', timeZone: 'America/Toronto' })
  assert.equal(timers.length, 1)
})

test('create refuses bad input with a code', async () => {
  const { controller } = setup()
  const code = async (input, expected) => {
    await assert.rejects(controller.create(input), error => error.code === expected)
  }
  await code({ ...reminder, prompt: '' }, 'invalid_job')
  await code({ ...reminder, title: ' ' }, 'invalid_job')
  await code({ ...reminder, schedule: { at: '2026-11-01T09:00:00Z' } }, 'not_future')
  await code({ ...reminder, schedule: { cron: '0 9 * * *' } }, 'invalid_time_zone')
  await code({ ...reminder, schedule: { rrule: 'nope' } }, 'invalid_rule')
  assert.equal(controller.list().length, 0)
})

test('an agent-only job delivers its prompt to its session and ends after a one-time run', async () => {
  const { controller, timers, runs, wakes, deliveries, history } = setup()
  const job = await controller.create(reminder)
  timers[0].fire()
  await controller.stop()
  assert.equal(runs.length, 0, 'no command runs')
  assert.equal(wakes.length, 0, 'no new session')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].sessionId, 'session-chat')
  assert.equal(deliveries[0].ignoreHold, true)
  assert.equal(deliveries[0].mayUnarchive, true)
  assert.match(deliveries[0].text, new RegExp(`scheduled job "Check the parcel" \\(id ${job.id}, run at 2026-11-08 07:00\\)`))
  assert.match(deliveries[0].text, /Has the parcel arrived\?$/)
  const [run] = controller.runs(job.id)
  assert.equal(run.status, 'woke')
  assert.equal(run.targeted, true)
  assert.equal(run.sessionId, 'session-chat')
  assert.equal(run.archive, undefined, 'an explicit session is never archived')
  assert.equal(history.tasks.get(job.id).status, 'ended')
  assert.equal(controller.get(job.id).state, 'ended')
})

test('a new_once job opens one session and keeps sending to it', async () => {
  const { controller, timers, wakes, deliveries, history } = setup()
  const job = await controller.create({
    ...reminder, target: { kind: 'new_once' }, schedule: { cron: '0 9 * * *', timeZone: 'America/Toronto' },
  })
  timers[0].fire()
  await settle()
  await settle()
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].cwd, '/home/me')
  assert.equal(wakes[0].agentPreset, 'helper')
  assert.deepEqual(history.tasks.get(job.id).target, { kind: 'new_once', sessionId: 'session-new-1' })
  timers[0].fire()
  await controller.stop()
  assert.equal(wakes.length, 1)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].sessionId, 'session-new-1')
  assert.equal(history.tasks.get(job.id).status, 'active')
})

test('a gated stored job runs its command and appends the output', async () => {
  const { controller, timers, runs, wakes } = setup()
  await controller.create({
    title: 'Mail', prompt: 'Sort the new mail.', command: './new-mail', cwd: '/w',
    schedule: { rrule: 'DTSTART;TZID=America/Toronto:20261109T100000\nRRULE:FREQ=DAILY;INTERVAL=3' },
    target: { kind: 'new' },
  })
  timers[0].fire()
  await controller.stop()
  assert.equal(runs[0].command, './new-mail')
  assert.equal(runs[0].cwd, '/w')
  assert.equal(runs[0].timeoutMs, 3600 * 1000)
  assert.match(wakes[0].text, /Sort the new mail\.\n\n--- Output of the job's command \(stdout\) ---\nnews/)
  assert.match(wakes[0].title, /^Mail · /)
})

test('a run missed while DSH was down happens once at startup', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const first = setup({ history })
  const job = await first.controller.create({ ...reminder, schedule: { cron: '0 9 * * *', timeZone: 'America/Toronto' } })
  await first.controller.stop()
  // Restart two days later: the saved next run is in the past.
  const later = new Date('2026-11-10T20:00:00.000Z')
  const second = setup({ history, now: () => later })
  const [timer] = second.timers
  assert.equal(timer.options.first.toISOString(), '2026-11-08T14:00:00.000Z')
  timer.fire()
  await second.controller.stop()
  assert.equal(second.deliveries.length, 1)
  assert.equal(history.tasks.get(job.id).scheduledAt, '2026-11-11T14:00:00.000Z', 'then continues from the present')
})

test('pause, resume, update and delete a stored job; config jobs are read-only', async () => {
  const { controller, timers, history } = setup({ jobs: [{ name: 'cfg', cron: '* * * * *', command: 'true' }] })
  const job = await controller.create({ ...reminder, schedule: { cron: '0 9 * * *', timeZone: 'America/Toronto' } })
  const paused = await controller.setPaused(job.id, true)
  assert.equal(paused.job.state, 'paused')
  assert.equal(history.tasks.get(job.id).status, 'paused')
  assert.equal(timers.at(-1).paused, true)
  assert.equal((await controller.setPaused(job.id, false)).job.state, 'active')

  const updated = await controller.update(job.id, { title: 'Parcel check', command: './check', prompt: '', schedule: { timeZone: 'Europe/Berlin' } })
  assert.equal(updated.name, 'Parcel check')
  assert.equal(updated.kind, 'command')
  assert.equal(updated.timeZone, 'Europe/Berlin')
  assert.equal(updated.nextRunAt, '2026-11-09T08:00:00.000Z')
  assert.equal(timers.at(-2).stopped, true, 'the old timer is replaced')
  await assert.rejects(controller.update(job.id, { command: '' }), error => error instanceof JobInputError && error.code === 'invalid_job')
  await assert.rejects(controller.update(job.id, { schedule: { timeZone: 'UTC' }, title: 'x' }).then(() => controller.update(job.id, { schedule: {} })), error => error instanceof ScheduleError)

  await assert.rejects(controller.update('cfg', { title: 'x' }), error => error.code === 'read_only')
  await assert.rejects(controller.remove('cfg'), error => error.code === 'read_only')
  await assert.rejects(controller.remove('job-nothere'), error => error.code === 'not_found')

  assert.deepEqual(await controller.remove(job.id), { id: job.id, deleted: true })
  assert.equal(history.tasks.get(job.id), undefined)
  assert.equal(controller.get(job.id), undefined)
  assert.equal(timers.at(-1).stopped, true)
  await controller.stop()
})

test('an ended job comes back with a new schedule; pausing it is refused', async () => {
  const { controller, timers } = setup()
  const job = await controller.create(reminder)
  timers[0].fire()
  await settle()
  await settle()
  assert.equal(controller.get(job.id).state, 'ended')
  assert.deepEqual(await controller.setPaused(job.id, true), { ok: false, code: 'ended' })
  const again = await controller.update(job.id, { schedule: { at: '2026-11-12T09:00:00-05:00' } })
  assert.equal(again.state, 'active')
  assert.equal(again.nextRunAt, '2026-11-12T14:00:00.000Z')
  await controller.stop()
})

test('config jobs take rrule, at and agent-only forms and a target session', async () => {
  const { controller, timers, runs, deliveries } = setup({
    jobs: [
      { name: 'weekly', rrule: 'DTSTART;TZID=America/Toronto:20261109T110000\nRRULE:FREQ=WEEKLY;BYDAY=MO', agent: { prompt: 'Weekly look.', sessionId: 'session-main' } },
      { name: 'once', at: '2026-11-20T09:00', timeZone: 'America/Toronto', command: 'true' },
      { name: 'both', cron: '* * * * *', at: '2026-11-20T09:00:00Z', command: 'true' },
      { name: 'empty', cron: '* * * * *' },
    ],
  })
  const [weekly, once, both, empty] = controller.list()
  assert.deepEqual([weekly.kind, weekly.state, weekly.source], ['agent', 'active', 'config'])
  assert.equal(weekly.nextRunAt, '2026-11-09T16:00:00.000Z')
  assert.equal(weekly.timeZone, 'America/Toronto')
  assert.deepEqual(weekly.target, { kind: 'session', sessionId: 'session-main' })
  assert.equal(once.nextRunAt, '2026-11-20T14:00:00.000Z')
  assert.equal(both.state, 'invalid')
  assert.equal(empty.state, 'invalid')
  timers[0].fire()
  await controller.stop()
  assert.equal(runs.length, 0)
  assert.equal(deliveries[0].sessionId, 'session-main')
  assert.match(deliveries[0].text, /cron job "weekly"/)
})

test('the page can delete stored jobs but not config jobs, by id', async () => {
  const { createRpcHandler } = await import('../src/rpc.js')
  const { controller } = setup({ jobs: [{ name: 'cfg', cron: '* * * * *', command: 'true' }] })
  const job = await controller.create(reminder)
  const handler = createRpcHandler(() => controller)
  const owner = { principal: { kind: 'owner' } }
  const list = await handler('list', {}, undefined, owner)
  assert.deepEqual(list.value.jobs.map(j => [j.id, j.source]), [['cfg', 'config'], [job.id, 'tool']])
  assert.equal((await handler('delete', { id: 'cfg' }, undefined, owner)).error.code, 'cron-jobs/read-only')
  assert.equal((await handler('delete', { id: 'job-none' }, undefined, owner)).error.code, 'cron-jobs/not-found')
  assert.equal((await handler('pause', { id: job.id, paused: true }, undefined, owner)).value.job.state, 'paused')
  assert.deepEqual((await handler('delete', { id: job.id }, undefined, owner)).value, { id: job.id, deleted: true })
  assert.equal(controller.list().length, 1)
  await controller.stop()
})

test('a stored job opens its sessions on its model; editing changes it and null clears it', async () => {
  const { controller, timers, wakes, history } = setup()
  const model = { provider: 'anthropic', model: 'claude-sonnet-4-5', reasoningEffort: 'high' }
  const job = await controller.create({ ...reminder, target: { kind: 'new' }, schedule: { cron: '0 9 * * *', timeZone: 'America/Toronto' }, model: { ...model, model: ' claude-sonnet-4-5 ' } })
  assert.deepEqual(job.agent.model, model)
  assert.deepEqual(history.tasks.get(job.id).model, model)
  timers[0].fire()
  await settle()
  await settle()
  assert.deepEqual(wakes[0].model, model)

  const changed = await controller.update(job.id, { model: { provider: 'deepseek', model: 'deepseek-chat' } })
  assert.deepEqual(changed.agent.model, { provider: 'deepseek', model: 'deepseek-chat' })
  await controller.update(job.id, { title: 'Renamed' })
  assert.deepEqual(history.tasks.get(job.id).model, { provider: 'deepseek', model: 'deepseek-chat' }, 'other edits keep the model')

  const cleared = await controller.update(job.id, { model: null })
  assert.equal(cleared.agent.model, null)
  assert.equal('model' in history.tasks.get(job.id), false)
  await assert.rejects(controller.create({ ...reminder, model: { provider: 'anthropic' } }), error => error.code === 'invalid_job')
  await assert.rejects(controller.update(job.id, { model: {} }), error => error.code === 'invalid_job')
  await controller.stop()
})
