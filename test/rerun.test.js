import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronJobs } from '../src/controller.js'
import { HistoryStore, memoryTable } from '../src/history.js'
import { cutOff, finalAnswer } from '../src/deliver.js'

const quiet = { info() {}, warn() {}, error() {} }
const NOTIFY = { via: 'chat', to: 'notify' }
const NOW = new Date('2026-11-14T03:05:00.000Z')
const CUT = { text: 'Halfway through', reason: 'aborted', cause: 'disposed' }
const DONE = { text: 'All done', reason: 'completed' }

async function until(check, what = 'condition') {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

/** Schedule-timer stand-in for stored jobs: the test fires it. */
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
 * One copy of the scheduler. `answers` gives the end of each prompt's turn
 * in order (the last one repeats); `nextRun` is the config jobs' next tick.
 */
function scheduler({ jobs = [], history, answers = [CUT, DONE], nextRun = null, rerun = { delayMs: 5 }, deliver = NOTIFY, now = () => NOW }) {
  const { FakeTimer, timers } = fakeTimers()
  const wakes = []
  const reuses = []
  const sent = []
  const records = []
  const asked = []
  const controller = new CronJobs({
    jobs,
    logger: quiet,
    history,
    now,
    record: async (entry) => { records.push(entry) },
    TimerClass: FakeTimer,
    CronClass: class { nextRun() { return nextRun } stop() {} },
    run: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', stdoutDropped: 0, durationMs: 1 }),
    wake: async (request) => { wakes.push(request); return `session-${wakes.length}` },
    reuse: async (request) => { reuses.push(request); return { queued: false } },
    send: async (target, message, from) => { sent.push({ target, message, from }); return { status: 'sent', attempts: 1 } },
    answer: async (sessionId, messageId) => {
      asked.push({ sessionId, messageId })
      return answers[Math.min(asked.length - 1, answers.length - 1)]
    },
    defaults: { deliver, autoArchive: false },
    watchdogMs: 0,
    rerun,
  }).start()
  return { controller, timers, wakes, reuses, sent, records, asked }
}

const checkIn = { name: 'Check-in', cron: '0 * * * *', agent: { prompt: 'Look around.' } }
const newHistory = () => new HistoryStore({ table: memoryTable(), logger: quiet })
const drain = async (controller) => {
  for (const { runner } of controller.entries.values()) {
    while (runner.settling.size > 0) await Promise.all([...runner.settling])
  }
  await Promise.all([...controller.inflight])
}

test('a turn DSH disposed is told apart from one a person stopped', () => {
  const log = [
    { type: 'user/message', data: { id: 'm1' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Halfway through' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
  ]
  const answer = finalAnswer(log, 'm1')
  assert.deepEqual(answer, { done: true, text: 'Halfway through', reason: 'aborted', cause: 'disposed' })
  assert.equal(cutOff(answer), true)
  assert.equal(cutOff({ reason: 'aborted', cause: 'user' }), false)
  assert.equal(cutOff({ reason: 'completed' }), false)
})

test('a cut-off turn runs again once, in its own session, and only the rerun\'s answer is delivered', async () => {
  const history = newHistory()
  const { controller, wakes, reuses, sent, records } = scheduler({ jobs: [checkIn], history })
  controller.fire(controller.entries.get('Check-in'))
  await until(() => history.runs('Check-in')[0]?.delivery?.status === 'sent' && history.runs('Check-in').length === 2, 'the rerun\'s delivery')
  await drain(controller)

  const [rerun, original] = history.runs('Check-in')
  assert.equal(wakes.length, 1)
  assert.equal(original.sessionId, 'session-1')
  assert.deepEqual(original.turn, { status: 'cut-off', messageId: original.turn.messageId, reason: 'aborted' })
  assert.equal(original.delivery.status, 'silent')
  assert.equal(original.delivery.error, 'turn cut off: disposed')
  assert.deepEqual(original.rerun, { status: 'started', at: NOW.toISOString(), runId: rerun.id })

  assert.equal(reuses.length, 1)
  assert.equal(reuses[0].sessionId, 'session-1')
  assert.equal(reuses[0].mayUnarchive, true)
  assert.equal(reuses[0].ignoreHold, false, 'a session the job opened for itself is left to a person who took it over')
  assert.match(reuses[0].text, /^This is a scheduled message from the user, sent by the cron job "Check-in" \(rerun of the run at /)
  assert.match(reuses[0].text, /was cut off before it finished, because DSH restarted or reloaded/)
  assert.match(reuses[0].text, /delivered to notify through chat/)

  assert.equal(rerun.rerunOf, original.id)
  assert.equal(rerun.trigger, 'schedule')
  assert.equal(rerun.status, 'woke')
  assert.equal(rerun.reused, true)
  assert.equal(rerun.sessionId, 'session-1')
  assert.equal(rerun.turn.status, 'ended')
  assert.deepEqual(sent.map(item => item.message.text), ['All done'])

  const events = records.map(entry => entry.event)
  assert.ok(events.includes('cut-off'))
  assert.equal(records.find(entry => entry.event === 'start' && entry.rerunOf)?.rerunOf, original.id)
  await controller.stop()
})

test('a cut-off run seen while DSH stops is rerun by the next start', async () => {
  const history = newHistory()
  const first = scheduler({ jobs: [checkIn], history, rerun: { delayMs: 60_000 } })
  first.controller.fire(first.controller.entries.get('Check-in'))
  await until(() => history.runs('Check-in')[0]?.rerun?.status === 'pending', 'the pending rerun')
  await drain(first.controller)
  await first.controller.stop()
  assert.equal(first.reuses.length, 0, 'the stop cancels the waiting rerun')

  const second = scheduler({ jobs: [checkIn], history, answers: [DONE] })
  await until(() => history.runs('Check-in').length === 2 && history.runs('Check-in')[0].delivery?.status === 'sent', 'the rerun after the restart')
  await drain(second.controller)
  assert.equal(second.reuses.length, 1)
  assert.equal(second.reuses[0].sessionId, 'session-1')
  assert.equal(history.runs('Check-in')[1].rerun.status, 'started')
  assert.deepEqual(second.sent.map(item => item.message.text), ['All done'])
  await second.controller.stop()
})

test('a turn cut off before the plugin noticed is found by the next start and rerun', async () => {
  const history = newHistory()
  const id = await history.begin('Check-in', { trigger: 'schedule', startedAt: '2026-11-14T03:00:00.000Z' })
  // Saved before turns were tracked: the prompt id sits on the pending delivery.
  await history.finish('Check-in', id, { status: 'woke', sessionId: 'session-old', delivery: { status: 'pending', ...NOTIFY, messageId: 'm-old' } })
  const { controller, reuses, sent, asked } = scheduler({ jobs: [checkIn], history })
  await until(() => history.runs('Check-in').length === 2 && history.runs('Check-in')[0].delivery?.status === 'sent', 'the rerun')
  await drain(controller)
  assert.deepEqual(asked[0], { sessionId: 'session-old', messageId: 'm-old' })
  assert.equal(reuses[0].sessionId, 'session-old')
  assert.equal(history.runs('Check-in')[1].delivery.status, 'silent')
  assert.deepEqual(sent.map(item => item.message.text), ['All done'])
  await controller.stop()
})

/** History with one cut-off run waiting for its rerun. */
async function pendingRerun({ startedAt = '2026-11-14T03:00:00.000Z', later } = {}) {
  const history = newHistory()
  const id = await history.begin('Check-in', { trigger: 'schedule', startedAt })
  await history.finish('Check-in', id, {
    status: 'woke', sessionId: 'session-old', turn: { status: 'cut-off', messageId: 'm-old', reason: 'aborted' }, rerun: { status: 'pending' },
  })
  if (later) {
    const next = await history.begin('Check-in', { trigger: 'schedule', startedAt: '2026-11-14T03:04:00.000Z' })
    await history.finish('Check-in', next, { status: later })
  }
  return { history, id }
}

for (const [why, setup, options, note] of [
  ['it is more than two hours old', { startedAt: '2026-11-14T00:30:00.000Z' }, {}, /^it started more than 2 h ago$/],
  ['a later run woke the agent', { later: 'woke' }, {}, /^a later run has woken the agent since$/],
  ['the next run is close', {}, { nextRun: new Date('2026-11-14T03:15:00.000Z') }, /^the next run is due at 2026-11-14T03:15:00.000Z$/],
]) {
  test(`a cut-off run is not rerun when ${why}`, async () => {
    const { history, id } = await pendingRerun(setup)
    const { controller, reuses, records } = scheduler({ jobs: [checkIn], history, ...options })
    await until(() => history.runs('Check-in').find(run => run.id === id).rerun.status === 'skipped', 'the skip')
    await drain(controller)
    assert.equal(reuses.length, 0)
    const { rerun } = history.runs('Check-in').find(run => run.id === id)
    assert.match(rerun.note, note)
    assert.match(records.find(entry => entry.event === 'rerun-skipped').note, note)
    await controller.stop()
  })
}

test('a later gate run that did not wake the agent does not stand in for the rerun', async () => {
  const { history } = await pendingRerun({ later: 'idle' })
  const { controller, reuses } = scheduler({ jobs: [checkIn], history, answers: [DONE] })
  await until(() => reuses.length === 1, 'the rerun')
  await drain(controller)
  await controller.stop()
})

test('a paused job\'s cut-off run is not rerun', async () => {
  const { history, id } = await pendingRerun()
  await history.setPaused('Check-in', true, NOW)
  const { controller, reuses } = scheduler({ jobs: [checkIn], history })
  await until(() => history.runs('Check-in').find(run => run.id === id).rerun.status === 'skipped', 'the skip')
  assert.equal(history.runs('Check-in').find(run => run.id === id).rerun.note, 'the job is paused')
  assert.equal(reuses.length, 0)
  await controller.stop()
})

test('a rerun that is cut off too is not rerun again', async () => {
  const history = newHistory()
  const { controller, reuses, records, sent } = scheduler({ jobs: [checkIn], history, answers: [CUT] })
  controller.fire(controller.entries.get('Check-in'))
  await until(() => history.runs('Check-in')[0]?.rerun?.status === 'skipped', 'the rerun\'s skip')
  await new Promise(resolve => setTimeout(resolve, 30))
  await drain(controller)
  const runs = history.runs('Check-in')
  assert.equal(runs.length, 2)
  assert.equal(reuses.length, 1)
  assert.equal(runs[0].rerun.note, 'a rerun is not run again')
  assert.equal(runs[1].rerun.status, 'started')
  assert.equal(records.filter(entry => entry.event === 'rerun-skipped').length, 1)
  assert.equal(sent.length, 0)
  await controller.stop()
})

test('a one-time job reruns after it has ended, without a delivery target, into its own session', async () => {
  const history = newHistory()
  const { controller, timers, wakes, reuses } = scheduler({ history, deliver: null })
  const job = await controller.create({
    title: 'Parcel check', prompt: 'Has the parcel arrived?', schedule: { at: '2026-11-14T03:10:00Z' }, target: { kind: 'new_once' },
  })
  timers.at(-1).fire()
  await until(() => history.runs(job.id).length === 2, 'the rerun')
  await drain(controller)
  assert.equal(controller.get(job.id).state, 'ended')
  assert.equal(wakes.length, 1)
  assert.equal(reuses.length, 1)
  assert.equal(reuses[0].sessionId, 'session-1')
  assert.equal(reuses[0].ignoreHold, true, 'a job\'s own target session takes the rerun like any run')
  assert.match(reuses[0].text, new RegExp(`sent by the scheduled job "Parcel check" \\(id ${job.id}, rerun of the run at `))
  assert.doesNotMatch(reuses[0].text, /delivered/)
  const [rerun, original] = history.runs(job.id)
  assert.equal(original.delivery, undefined)
  assert.equal(original.turn.status, 'cut-off')
  assert.equal(rerun.targeted, true)
  assert.equal(rerun.turn.status, 'ended')
  await controller.stop()
})
