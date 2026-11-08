import { Cron } from 'croner'
import {
  RRule, canonicalizeTimeZone, formatFourDigitYearInstant, parseLocalCalendar, parseOffsetInstant, resolveLocalInstant,
} from '@deepseek-ai/dsh-util-time'

/**
 * Job schedules: a cron expression (croner), an RFC 5545 DTSTART/RRULE pair
 * (DSH's own bounded RRULE engine from @deepseek-ai/dsh-util-time, the one the
 * built-in Schedule uses, so rules behave the same), or one instant.
 *
 * A parsed schedule answers `next(afterMs)`: the first occurrence strictly
 * after a time, or undefined once the schedule is used up.
 */

/** A schedule the user wrote that cannot be used; `code` says which part. */
export class ScheduleError extends Error {
  /**
   * @param {'invalid_rule' | 'invalid_time_zone' | 'not_future'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ScheduleError'
    this.code = code
  }
}

/**
 * @typedef {{ kind: 'cron', expression: string, timeZone?: string }
 *   | { kind: 'rrule', rrule: string }
 *   | { kind: 'at', at: string, timeZone?: string }} ScheduleSpec
 *   The stored form. `at` is a UTC instant; its `timeZone` is only for display.
 */

/**
 * @typedef {object} Schedule
 * @property {ScheduleSpec} spec
 * @property {string | undefined} timeZone - Zone used for local times; undefined means the host zone.
 * @property {(afterMs: number) => Date | undefined} next
 */

/**
 * Parse a stored schedule.
 * @param {ScheduleSpec} spec
 * @returns {Schedule}
 * @throws {ScheduleError}
 */
export function parseSchedule(spec) {
  switch (spec?.kind) {
    case 'cron': {
      let cron
      try {
        cron = new Cron(spec.expression, { timezone: spec.timeZone || undefined, paused: true })
        // croner checks the zone only when it computes a time.
        cron.nextRun()
      } catch (error) {
        throw new ScheduleError(/time ?zone/i.test(String(error?.message)) ? 'invalid_time_zone' : 'invalid_rule', `cron: ${describe(error)}`)
      }
      return {
        spec,
        timeZone: spec.timeZone || undefined,
        next(afterMs) {
          const next = cron.nextRun(new Date(afterMs))
          return next ?? undefined
        },
      }
    }
    case 'rrule': {
      const parsed = RRule.parse(spec.rrule)
      if (parsed.kind === 'rejected') {
        throw new ScheduleError(parsed.reason === 'time_zone' ? 'invalid_time_zone' : 'invalid_rule', `rrule: ${parsed.detail}`)
      }
      const rule = parsed.rule
      return {
        spec: { kind: 'rrule', rrule: rule.expression },
        timeZone: rule.timeZone,
        next(afterMs) {
          const next = rule.next(afterMs)
          return next === undefined ? undefined : new Date(next)
        },
      }
    }
    case 'at': {
      const at = Date.parse(spec.at)
      if (!Number.isFinite(at)) throw new ScheduleError('invalid_rule', `at: ${JSON.stringify(spec.at)} is not a time`)
      return {
        spec,
        timeZone: spec.timeZone || undefined,
        next: afterMs => (at > afterMs ? new Date(at) : undefined),
      }
    }
    default:
      throw new ScheduleError('invalid_rule', 'the job has no schedule: set cron, rrule or at')
  }
}

/**
 * Build a stored schedule from user input with exactly one of cron, rrule or
 * at. A cron expression and an `at` without an offset need a time zone, so a
 * job never silently runs on the host's clock.
 *
 * @param {{ cron?: string, rrule?: string, at?: string, timeZone?: string }} input
 * @returns {ScheduleSpec}
 * @throws {ScheduleError}
 */
export function scheduleFromInput({ cron, rrule, at, timeZone }) {
  const given = [cron, rrule, at].filter(value => value !== undefined && value !== '')
  if (given.length !== 1) throw new ScheduleError('invalid_rule', 'give exactly one of cron, rrule or at')
  const zone = timeZone === undefined || timeZone === '' ? undefined : canonicalZone(timeZone)
  if (rrule) {
    if (zone !== undefined) throw new ScheduleError('invalid_rule', 'an rrule takes its time zone from DTSTART; leave timeZone empty')
    return parseSchedule({ kind: 'rrule', rrule: rrule.trim() }).spec
  }
  if (cron) {
    if (zone === undefined) throw new ScheduleError('invalid_time_zone', 'a cron schedule needs timeZone')
    const spec = { kind: 'cron', expression: cron.trim(), timeZone: zone }
    parseSchedule(spec)
    return spec
  }
  return { kind: 'at', at: parseAt(at.trim(), zone), ...(zone ? { timeZone: zone } : {}) }
}

/** A one-time `at`: RFC 3339 with an offset, or a local date-time read in `zone`. */
function parseAt(text, zone) {
  const instant = parseOffsetInstant(text)
  if (instant.kind === 'accepted') return iso(instant.epoch)
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d{1,3})?)?$/.exec(text)
  if (match === null) {
    throw new ScheduleError('invalid_rule', `at: ${JSON.stringify(text)} is not a date-time like 2026-11-20T09:00:00-05:00 or 2026-11-20T09:00`)
  }
  if (zone === undefined) throw new ScheduleError('invalid_time_zone', 'an at without an offset needs timeZone')
  const local = parseLocalCalendar(match[1], match[2] + (match[3] ?? ':00'))
  if (local.kind === 'rejected') throw new ScheduleError('invalid_rule', `at: ${JSON.stringify(text)} is not a real date and time`)
  const epoch = resolveLocalInstant(local.time, zone)
  if (epoch === undefined) throw new ScheduleError('invalid_rule', `at: ${text} does not exist in ${zone} (skipped by a daylight-saving change)`)
  return iso(epoch)
}

function canonicalZone(value) {
  const result = canonicalizeTimeZone(value)
  if (result.kind === 'rejected') {
    throw new ScheduleError('invalid_time_zone', `timeZone: ${JSON.stringify(value)} is not an IANA zone such as America/Toronto (UTC is "UTC")`)
  }
  return result.timeZone
}

function iso(epoch) {
  const text = formatFourDigitYearInstant(epoch)
  if (text === undefined) throw new ScheduleError('invalid_rule', 'the time is out of range')
  return text
}

/** Short human form of a schedule, for lists. */
export function describeSchedule(spec) {
  switch (spec?.kind) {
    case 'cron': return spec.timeZone ? `cron ${spec.expression} (${spec.timeZone})` : `cron ${spec.expression}`
    case 'rrule': return spec.rrule.replace(/\s*\n\s*/g, ' ')
    case 'at': return `once at ${spec.at}`
    default: return 'no schedule'
  }
}

/** Longest single wait; longer waits are split so timers never overflow. */
export const MAX_TIMER_MS = 6 * 3600 * 1000

/**
 * A timer for a parsed schedule with the part of croner's interface the
 * controller uses (`nextRun`, `pause`, `resume`, `stop`).
 *
 * `first` sets the first occurrence, which may be in the past: a stored job
 * whose saved next run passed while DSH was down fires once right away, then
 * continues from the present. Without `first`, the next occurrence after now.
 */
export class ScheduleTimer {
  /**
   * @param {Schedule} schedule
   * @param {object} options
   * @param {(occurrence: Date) => void} options.onFire
   * @param {Date} [options.first]
   * @param {() => number} [options.now]
   * @param {boolean} [options.paused]
   */
  constructor(schedule, { onFire, first, now = Date.now, paused = false }) {
    this.schedule = schedule
    this.onFire = onFire
    this.now = now
    this.paused = paused
    this.stopped = false
    this.timer = undefined
    this.due = first ?? schedule.next(now())
    this.arm()
  }

  /** The next occurrence, or null when the schedule is used up. */
  nextRun() {
    return this.due ?? null
  }

  pause() {
    this.paused = true
    this.clear()
    return true
  }

  /** Resume from the present: occurrences that passed while paused are skipped. */
  resume() {
    if (this.stopped) return false
    this.paused = false
    if (this.due !== undefined && this.due.getTime() <= this.now()) this.due = this.schedule.next(this.now())
    this.arm()
    return true
  }

  stop() {
    this.stopped = true
    this.clear()
  }

  clear() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  arm() {
    this.clear()
    if (this.paused || this.stopped || this.due === undefined) return
    const wait = Math.max(0, Math.min(this.due.getTime() - this.now(), MAX_TIMER_MS))
    this.timer = setTimeout(() => this.wake(), wait)
    this.timer.unref?.()
  }

  wake() {
    this.timer = undefined
    if (this.paused || this.stopped || this.due === undefined) return
    const occurrence = this.due
    // A timer can fire a little early, and long waits are split.
    if (occurrence.getTime() > this.now()) return this.arm()
    this.due = this.schedule.next(Math.max(this.now(), occurrence.getTime()))
    this.arm()
    this.onFire(occurrence)
  }
}

/**
 * A cron timer with croner's constructor shape (`pattern, { timezone, paused },
 * callback`) built on {@link ScheduleTimer}; the controller's default for
 * config cron jobs.
 *
 * croner's own timer is not used because it can silently skip a tick. When
 * its timeout wakes a little before the due time, it re-arms with a due time
 * computed again from "now"; for a timer that has not fired yet in this
 * process (every timer right after a start or a plugin reload), "now" can
 * already be past the due time by then, so the next occurrence is taken and
 * the due one is dropped without a trace. ScheduleTimer keeps the due
 * occurrence fixed until it has fired. croner still computes the occurrences.
 */
export class CronTimer extends ScheduleTimer {
  /**
   * @param {string} pattern
   * @param {{ timezone?: string, paused?: boolean, now?: () => number }} [options]
   * @param {() => void} [callback]
   */
  constructor(pattern, { timezone, paused = false, now = Date.now } = {}, callback = () => {}) {
    const schedule = parseSchedule({ kind: 'cron', expression: pattern, ...(timezone ? { timeZone: timezone } : {}) })
    super(schedule, { onFire: () => callback(), paused, now })
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
