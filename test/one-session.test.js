import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronJobs } from '../src/controller.js'
import { HistoryStore, memoryTable } from '../src/history.js'

const quiet = { info() {}, warn() {}, error() {} }
const NOW = new Date('2026-11-17T23:00:00.000Z')
const DONE = { text: 'handled', reason: 'completed' }
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

async function until(check, what = 'condition') {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

/** Schedule-timer stand-in: the test fires it. */
function fakeTimers() {
  const timers = []
  class FakeTimer {
    constructor(schedule, options) {
      this.schedule = schedule
      this.options = options
      this.due = options.first ?? schedule.next(options.now())
      timers.push(this)
    }
    nextRun() { return this.due ?? null }
    pause() {}
    resume() {}
    stop() {}
    fire() {
      const occurrence = this.due
      this.due = this.schedule.next(Math.max(this.options.now(), occurrence.getTime()))
      this.options.onFire(occurrence)
    }
  }
  return { FakeTimer, timers }
}

/**
 * A scheduler whose woken turns end when the test says so. `unread` is the
 * state the gate reports: it wakes the agent while it is true.
 */
function setup() {
  const { FakeTimer, timers } = fakeTimers()
  const state = { unread: true }
  const gates = []
  const wakes = []
  const records = []
  const turns = []
  const controller = new CronJobs({
    jobs: [],
    logger: quiet,
    history: new HistoryStore({ table: memoryTable(), logger: quiet }),
    now: () => NOW,
    record: async (entry) => { records.push(entry) },
    TimerClass: FakeTimer,
    CronClass: class { nextRun() { return null } stop() {} },
    run: async (options) => {
      gates.push(options.env.DSH_CRON_TRIGGER)
      return { ok: true, exitCode: 0, stdout: state.unread ? 'unread mail\n' : '{"wakeAgent": false}\n', stderr: '', stdoutDropped: 0, durationMs: 1 }
    },
    wake: async (request) => { wakes.push(request); return `session-${wakes.length}` },
    reuse: async () => ({ queued: false }),
    answer: (sessionId) => new Promise((resolve) => { turns.push({ sessionId, end: (answer = DONE) => resolve(answer) }) }),
    defaults: { autoArchive: false },
    watchdogMs: 0,
    events: { coalesceSeconds: 0, maxRunsPerHour: 0 },
  }).start()
  return { controller, timers, state, gates, wakes, records, turns }
}

const mailbox = { cwd: '/tmp', target: { kind: 'new' }, title: 'Mailbox', prompt: 'Read the mail.', command: 'gate', on: ['mail.*'], schedule: { cron: '0 */2 * * *', timeZone: 'UTC' } }

test('an event while the session woken by the clock still works wakes no second session; the gate decides after it ends', async () => {
  const { controller, timers, state, gates, wakes, turns } = setup()
  const job = await controller.create(mailbox)

  timers[0].fire()
  await until(() => turns.length === 1, 'the first turn')
  assert.equal(wakes.length, 1)

  controller.emit({ channel: 'mail.sakina' })
  await settle()
  assert.equal(wakes.length, 1, 'no second session while the first works')
  assert.deepEqual(gates, ['schedule'], 'the gate does not even run: it would still see the unread mail')

  // The first session reads the mail and ends its turn; the waiting event then re-checks the gate.
  state.unread = false
  turns[0].end()
  await until(() => gates.length === 2, 'the gate after the turn')
  await settle()
  assert.deepEqual(gates, ['schedule', 'event'])
  assert.equal(wakes.length, 1, 'nothing is left unread, so nothing wakes')
  assert.equal(controller.get(job.id).state, 'active')
})

test('mail that arrives while the session works is handled by one later session, after the first has ended', async () => {
  const { controller, timers, gates, wakes, turns } = setup()
  await controller.create(mailbox)

  timers[0].fire()
  await until(() => turns.length === 1, 'the first turn')
  controller.emit({ channel: 'mail.sakina', key: 'a' })
  controller.emit({ channel: 'mail.sakina', key: 'b' })
  await settle()
  assert.equal(wakes.length, 1)

  turns[0].end() // still unread: the first session did not get to the newest mail
  await until(() => wakes.length === 2, 'the second wake')
  assert.deepEqual(gates, ['schedule', 'event'], 'both events ran the gate once, together')
  assert.match(wakes[1].text, /"key":"a"/)
  assert.match(wakes[1].text, /"key":"b"/)
})

test('a scheduled tick while the woken session still works is skipped and logged, then runs once it ended', async () => {
  const { controller, timers, gates, wakes, records, turns } = setup()
  await controller.create(mailbox)

  timers[0].fire()
  await until(() => turns.length === 1, 'the first turn')
  timers[0].fire()
  await until(() => records.some(entry => entry.event === 'skipped'), 'the skip')
  assert.equal(wakes.length, 1)
  assert.deepEqual(gates, ['schedule'])
  assert.equal(records.find(entry => entry.event === 'skipped').reason, 'session-working')
  assert.equal(records.find(entry => entry.event === 'skipped').sessionId, 'session-1')

  turns[0].end()
  await settle()
  timers[0].fire()
  await until(() => wakes.length === 2, 'the next tick')
})

test('Run now is a person asking, and is not held back by a session still working', async () => {
  const { controller, wakes, turns } = setup()
  const job = await controller.create(mailbox)
  controller.runNow(job.id)
  await until(() => turns.length === 1, 'the first turn')
  controller.runNow(job.id)
  await until(() => wakes.length === 2, 'the manual run')
})

test('a tick skipped for a working session does not use up a once job', async () => {
  const { controller, timers, wakes, records, turns } = setup()
  const job = await controller.create({ ...mailbox, once: true, on: undefined })
  controller.runNow(job.id) // a manual run does not end a once job
  await until(() => turns.length === 1, 'the turn')
  timers[0].fire()
  await until(() => records.some(entry => entry.event === 'skipped'), 'the skip')
  assert.equal(controller.get(job.id).state, 'active')
  turns[0].end()
  await settle()
  timers[0].fire()
  await until(() => wakes.length === 2, 'the real run')
  await until(() => controller.get(job.id).state === 'ended', 'the end')
})

test('events wait for a turn that is cut off too, and the job runs again after it', async () => {
  const { controller, timers, wakes, turns } = setup()
  await controller.create(mailbox)
  timers[0].fire()
  await until(() => turns.length === 1, 'the first turn')
  controller.emit({ channel: 'mail.sakina' })
  await settle()
  assert.equal(wakes.length, 1)
  turns[0].end({ text: 'half', reason: 'aborted', cause: 'disposed' })
  await until(() => wakes.length === 2, 'the waiting batch')
})
