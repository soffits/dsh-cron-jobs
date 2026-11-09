import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronTimer, ScheduleError, ScheduleTimer, describeSchedule, parseSchedule, scheduleFromInput } from '../src/schedule.js'

const at = iso => Date.parse(iso)

function rejects(input, code) {
  assert.throws(() => scheduleFromInput(input), error => error instanceof ScheduleError && error.code === code)
}

test('cron schedules need a zone and run in it', () => {
  const spec = scheduleFromInput({ cron: '0 9 * * *', timeZone: 'America/Toronto' })
  assert.deepEqual(spec, { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/Toronto' })
  assert.equal(parseSchedule(spec).next(at('2026-11-08T12:00:00Z')).toISOString(), '2026-11-08T14:00:00.000Z')
  rejects({ cron: '0 9 * * *' }, 'invalid_time_zone')
  rejects({ cron: '0 9 * * *', timeZone: 'Nope/Where' }, 'invalid_time_zone')
  rejects({ cron: 'not cron', timeZone: 'UTC' }, 'invalid_rule')
})

test('rrule schedules follow DTSTART, INTERVAL, UNTIL and COUNT', () => {
  const every3 = parseSchedule(scheduleFromInput({ rrule: 'DTSTART;TZID=America/Toronto:20261109T100000\nRRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261215T150000Z' }))
  assert.equal(every3.timeZone, 'America/Toronto')
  assert.equal(every3.next(at('2026-11-08T00:00:00Z')).toISOString(), '2026-11-09T15:00:00.000Z')
  assert.equal(every3.next(at('2026-11-09T15:00:00Z')).toISOString(), '2026-11-12T15:00:00.000Z')
  assert.equal(every3.next(at('2026-12-15T15:00:00Z')), undefined, 'nothing after UNTIL')

  const weekly = parseSchedule({ kind: 'rrule', rrule: 'DTSTART;TZID=America/Toronto:20261109T110000\nRRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270131T160000Z' })
  assert.equal(weekly.next(at('2026-11-09T16:00:00Z')).toISOString(), '2026-11-16T16:00:00.000Z')

  const once = parseSchedule({ kind: 'rrule', rrule: 'DTSTART:20261116T150000Z\nRRULE:FREQ=DAILY;COUNT=1' })
  assert.equal(once.timeZone, 'UTC')
  assert.equal(once.next(at('2026-11-10T00:00:00Z')).toISOString(), '2026-11-16T15:00:00.000Z')
  assert.equal(once.next(at('2026-11-16T15:00:00Z')), undefined)

  rejects({ rrule: 'RRULE:FREQ=DAILY' }, 'invalid_rule')
  rejects({ rrule: 'DTSTART:20261116T150000Z\nRRULE:FREQ=DAILY;COUNT=1', timeZone: 'UTC' }, 'invalid_rule')
})

test('at takes an offset, or a local time in timeZone', () => {
  assert.deepEqual(scheduleFromInput({ at: '2026-11-20T09:00:00-05:00' }), { kind: 'at', at: '2026-11-20T14:00:00.000Z' })
  assert.deepEqual(scheduleFromInput({ at: '2026-11-20T09:00', timeZone: 'America/Toronto' }),
    { kind: 'at', at: '2026-11-20T14:00:00.000Z', timeZone: 'America/Toronto' })
  rejects({ at: '2026-11-20T09:00' }, 'invalid_time_zone')
  rejects({ at: 'tomorrow', timeZone: 'UTC' }, 'invalid_rule')
  rejects({ at: '2026-03-08T02:30', timeZone: 'America/Toronto' }, 'invalid_rule')
  const once = parseSchedule({ kind: 'at', at: '2026-11-20T14:00:00.000Z' })
  assert.equal(once.next(at('2026-11-20T13:00:00Z')).toISOString(), '2026-11-20T14:00:00.000Z')
  assert.equal(once.next(at('2026-11-20T14:00:00Z')), undefined)
})

test('exactly one schedule is required', () => {
  rejects({}, 'invalid_rule')
  rejects({ cron: '* * * * *', at: '2026-11-20T09:00:00Z', timeZone: 'UTC' }, 'invalid_rule')
})

test('describeSchedule is one short line', () => {
  assert.equal(describeSchedule({ kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' }), 'cron 0 9 * * * (UTC)')
  assert.equal(describeSchedule({ kind: 'rrule', rrule: 'DTSTART:20261116T150000Z\nRRULE:FREQ=DAILY;COUNT=1' }), 'DTSTART:20261116T150000Z RRULE:FREQ=DAILY;COUNT=1')
  assert.equal(describeSchedule({ kind: 'at', at: '2026-11-20T14:00:00.000Z' }), 'once at 2026-11-20T14:00:00.000Z')
})

test('ScheduleTimer fires a past first occurrence at once, then follows the schedule', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at('2026-11-08T12:00:00Z') })
  const fired = []
  const schedule = parseSchedule({ kind: 'cron', expression: '0 * * * *', timeZone: 'UTC' })
  const timer = new ScheduleTimer(schedule, { first: new Date('2026-11-08T09:00:00Z'), onFire: d => fired.push(d.toISOString()) })
  t.mock.timers.tick(0)
  assert.deepEqual(fired, ['2026-11-08T09:00:00.000Z'], 'one catch-up run, not one per missed hour')
  assert.equal(timer.nextRun().toISOString(), '2026-11-08T13:00:00.000Z')
  t.mock.timers.tick(3600 * 1000)
  assert.deepEqual(fired.slice(1), ['2026-11-08T13:00:00.000Z'])
  timer.pause()
  t.mock.timers.tick(3 * 3600 * 1000)
  assert.equal(fired.length, 2, 'paused timers do not fire')
  timer.resume()
  assert.equal(timer.nextRun().toISOString(), '2026-11-08T17:00:00.000Z', 'resume skips what passed while paused')
  timer.stop()
  t.mock.timers.tick(3600 * 1000)
  assert.equal(fired.length, 2)
})

test('ScheduleTimer waits across long gaps and ends when the schedule is used up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at('2026-11-08T12:00:00Z') })
  const fired = []
  const timer = new ScheduleTimer(parseSchedule({ kind: 'at', at: '2026-12-20T12:00:00.000Z' }), { onFire: d => fired.push(d) })
  t.mock.timers.tick(41 * 24 * 3600 * 1000)
  assert.equal(fired.length, 0)
  t.mock.timers.tick(24 * 3600 * 1000)
  assert.equal(fired.length, 1)
  assert.equal(timer.nextRun(), null)
})

test('CronTimer keeps a due tick when its timeout wakes early and the clock passes the due time meanwhile', () => {
  // croner's own timer drops this tick for a timer that has not fired yet:
  // after an early wake it computes the due time again from "now", which by
  // then is past it, and moves on to the next hour.
  const due = Date.parse('2026-11-08T19:23:00Z')
  let clock = due - 4000
  // The first read after the wake sees 1 ms before the due time; every later
  // read is at the due time, as when the clock ticks during the wake.
  let early = false
  const now = () => {
    if (!early) return clock
    early = false
    return due - 1
  }
  const fired = []
  const timer = new CronTimer('23 * * * *', { timezone: 'America/Toronto', now }, () => fired.push(clock))
  try {
    assert.equal(timer.nextRun().getTime(), due)
    clock = due
    early = true // the timeout wakes 1 ms early
    timer.wake()
    assert.deepEqual(fired, [], 'nothing runs before the due time')
    assert.equal(timer.nextRun().getTime(), due, 'the due tick is kept')
    timer.wake() // the re-armed timeout
    assert.deepEqual(fired, [due])
    assert.equal(timer.nextRun().toISOString(), '2026-11-08T20:23:00.000Z')
  } finally {
    timer.stop()
  }
})

test('a cron schedule always moves forward across daylight-saving changes', () => {
  // croner 10 answered a time in the past for a reference inside the
  // repeated hour of a fall back (06:00Z -> 05:23Z), so a timer armed then
  // fired over and over. Fall back 2026-11-01, spring forward 2026-03-08.
  const cases = [
    ['23 * * * *', '2026-11-01T04:00:00Z', '2026-11-01T08:00:00Z', 4],
    ['*/5 * * * *', '2026-11-01T05:00:00Z', '2026-11-01T07:00:00Z', 23],
    ['30 2 * * *', '2026-03-07T12:00:00Z', '2026-03-09T12:00:00Z', 2],
    ['23 * * * *', '2026-03-08T05:00:00Z', '2026-03-08T09:00:00Z', 4],
  ]
  for (const [expression, from, to, runs] of cases) {
    const schedule = parseSchedule({ kind: 'cron', expression, timeZone: 'America/Toronto' })
    for (let t = at(from); t < at(to); t += 60_000) {
      assert.ok(schedule.next(t).getTime() > t, `${expression} after ${new Date(t).toISOString()}`)
    }
    let count = 0
    for (let t = schedule.next(at(from)).getTime(); t < at(to); t = schedule.next(t).getTime()) count++
    assert.equal(count, runs, `${expression} runs from ${from} to ${to}`)
  }
})

test('CronTimer has croner\'s shape: starts paused, rejects a bad pattern or zone', () => {
  const fired = []
  const paused = new CronTimer('* * * * *', { timezone: 'UTC', paused: true }, () => fired.push(1))
  assert.equal(paused.timer, undefined, 'a paused timer arms no timeout')
  assert.equal(paused.nextRun() instanceof Date, true)
  paused.stop()
  assert.throws(() => new CronTimer('bad', { timezone: 'UTC' }), ScheduleError)
  assert.throws(() => new CronTimer('* * * * *', { timezone: 'Mars/Base' }), ScheduleError)
})
