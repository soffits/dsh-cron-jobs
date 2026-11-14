/**
 * Events: named hints from outside DSH (a CLI, a hook, a watcher) that start
 * the jobs subscribed to their channel. An event only says "look now"; the
 * job reads the truth from its source, so a lost or forged event costs at
 * most one missed or wasted run (the job's schedule is the safety net).
 *
 * - Channels are dot-separated names such as `mail.sakina` or `dsh.started`.
 * - A job's `on` lists channel patterns; `*` matches one or more characters
 *   of any kind, dots included (`mail.*` matches `mail.icloud.inbox`).
 * - An event may carry a dedupe key: a second event with the same channel and
 *   key within an hour is dropped.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Longest channel name or pattern. */
export const MAX_CHANNEL_LENGTH = 200
/** Characters of an event's text, and of its data as JSON, that are kept. */
export const MAX_EVENT_BYTES = 16 * 1024
/** How long a dedupe key is remembered. */
export const DEDUPE_MS = 3600 * 1000

const SEGMENT = '[A-Za-z0-9_:-]+'
const CHANNEL = new RegExp(`^${SEGMENT}(\\.${SEGMENT})*$`)
const PATTERN = /^[A-Za-z0-9_:.*-]+$/

/** A request to emit or subscribe that cannot be carried out. */
export class EventInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EventInputError'
    this.code = 'invalid_event'
  }
}

/** The event inbox under the DSH home. */
export function defaultEventDir(env = process.env) {
  return env.DSH_CRON_EVENTS_DIR || join(env.DSH_HOME || join(homedir(), '.dsh'), 'cron-jobs', 'events')
}

/** State directory given to each watcher. */
export function defaultWatcherStateRoot(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'cron-jobs', 'watchers')
}

export function isChannel(value) {
  return typeof value === 'string' && value.length <= MAX_CHANNEL_LENGTH && CHANNEL.test(value)
}

export function isPattern(value) {
  return typeof value === 'string' && value.length <= MAX_CHANNEL_LENGTH && PATTERN.test(value)
    && !value.startsWith('.') && !value.endsWith('.') && !value.includes('..')
}

/**
 * Check and clean a list of channel patterns.
 * @returns {string[]} The patterns, trimmed and without duplicates.
 * @throws {EventInputError}
 */
export function checkPatterns(list) {
  if (!Array.isArray(list)) throw new EventInputError('on must be a list of channel patterns')
  const out = []
  for (const raw of list) {
    const value = typeof raw === 'string' ? raw.trim() : raw
    if (!isPattern(value)) throw new EventInputError(`${JSON.stringify(raw)} is not a channel pattern: dot-separated names of letters, digits, _ : -, with * for any characters`)
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** Whether a channel matches one pattern. */
export function channelMatches(pattern, channel) {
  if (!pattern.includes('*')) return pattern === channel
  const parts = pattern.split('*').map(part => part.replace(/[.\\^$+?()[\]{}|-]/g, '\\$&'))
  return new RegExp(`^${parts.join('.+')}$`).test(channel)
}

/** Whether a channel matches any of a job's patterns. */
export function subscribed(patterns, channel) {
  return Array.isArray(patterns) && patterns.some(pattern => channelMatches(pattern, channel))
}

/**
 * An event as jobs see it. Data that is not JSON-safe, too large data and
 * long text are cut down rather than refused, since a watcher's line should
 * still wake its job.
 * @param {{ channel: string, data?: any, text?: string, key?: string, source?: string, at?: string }} input
 * @param {() => Date} [now]
 * @throws {EventInputError} for a missing or malformed channel.
 */
export function normalizeEvent(input, now = () => new Date()) {
  if (input === null || typeof input !== 'object') throw new EventInputError('an event must be an object')
  const channel = typeof input.channel === 'string' ? input.channel.trim() : input.channel
  if (!isChannel(channel)) throw new EventInputError(`${JSON.stringify(input.channel)} is not a channel name: dot-separated names of letters, digits, _ : -`)
  const event = { channel, at: validTime(input.at) ?? now().toISOString() }
  if (typeof input.key === 'string' && input.key.trim() !== '') event.key = input.key.trim().slice(0, 200)
  if (typeof input.source === 'string' && input.source.trim() !== '') event.source = input.source.trim().slice(0, 200)
  if (input.data !== undefined) {
    let json
    try {
      json = JSON.stringify(input.data)
    } catch {
      json = undefined
    }
    if (json === undefined) event.text = String(input.data).slice(0, MAX_EVENT_BYTES)
    else if (json.length <= MAX_EVENT_BYTES) event.data = JSON.parse(json)
    else event.text = `${json.slice(0, MAX_EVENT_BYTES)}… [data cut at ${MAX_EVENT_BYTES} characters]`
  }
  if (typeof input.text === 'string' && input.text.trim() !== '' && event.text === undefined) {
    event.text = input.text.length > MAX_EVENT_BYTES ? `${input.text.slice(0, MAX_EVENT_BYTES)}… [text cut]` : input.text
  }
  return event
}

function validTime(value) {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/** Remembers dedupe keys for an hour. */
export class Deduper {
  constructor({ windowMs = DEDUPE_MS, now = () => Date.now() } = {}) {
    this.windowMs = windowMs
    this.now = now
    this.seen = new Map()
  }

  /** True when this channel and key were seen within the window; records it otherwise. */
  seenBefore(event) {
    if (event.key === undefined) return false
    const now = this.now()
    for (const [key, expires] of this.seen) {
      if (expires > now) break
      this.seen.delete(key)
    }
    const id = `${event.channel}\u0000${event.key}`
    const expires = this.seen.get(id)
    if (expires !== undefined && expires > now) return true
    this.seen.delete(id)
    this.seen.set(id, now + this.windowMs)
    return false
  }
}

/** Default batching of events per job. */
export const DEFAULT_COALESCE_SECONDS = 30
export const DEFAULT_MAX_RUNS_PER_HOUR = 6
/** Events kept in one batch; older ones are counted as dropped. */
export const MAX_BATCH_EVENTS = 50

const HOUR_MS = 3600 * 1000

/**
 * Gathers one job's events into batches and starts a run per batch:
 *
 * - The first event of a batch opens a window (`coalesceMs`); everything that
 *   arrives in it joins the batch, and the batch runs when it closes.
 * - A job that is still running when the window closes runs again as soon as
 *   it ends, with every event gathered meanwhile (one follow-up run).
 * - At most `maxRunsPerHour` event runs start in any hour; past that, events
 *   wait in the batch until the oldest of those runs is an hour old.
 *
 * Each event comes with a `release` callback, called once the event's run
 * has started (or the event is discarded), so a spool file is only removed
 * when nothing can lose it any more.
 */
export class EventBatcher {
  /**
   * @param {object} options
   * @param {(batch: { events: object[], dropped: number }) => void} options.start - Starts a run with the batch.
   * @param {() => boolean} options.busy - Whether the job is running now.
   * @param {number} [options.coalesceMs]
   * @param {number} [options.maxRunsPerHour] - 0 means no cap.
   * @param {() => number} [options.now]
   * @param {{ set: typeof setTimeout, clear: typeof clearTimeout }} [options.timers]
   */
  constructor({ start, busy, coalesceMs = DEFAULT_COALESCE_SECONDS * 1000, maxRunsPerHour = DEFAULT_MAX_RUNS_PER_HOUR, now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout } }) {
    this.startRun = start
    this.busy = busy
    this.coalesceMs = coalesceMs
    this.maxRunsPerHour = maxRunsPerHour
    this.now = now
    this.timers = timers
    this.pending = []
    this.releases = []
    this.dropped = 0
    this.openedAt = undefined
    this.timer = undefined
    this.recent = []
    this.stopped = false
  }

  /** Number of events waiting. */
  get size() {
    return this.pending.length
  }

  /** When the waiting batch is due to run, or undefined. */
  get dueAt() {
    return this.pending.length === 0 ? undefined : this.due()
  }

  add(event, release = () => {}) {
    if (this.stopped) return
    if (this.pending.length === 0) this.openedAt = this.now()
    this.pending.push(event)
    this.releases.push(release)
    if (this.pending.length > MAX_BATCH_EVENTS) {
      this.pending.shift()
      this.dropped++
    }
    this.arm()
  }

  due() {
    let at = this.openedAt + this.coalesceMs
    if (this.maxRunsPerHour > 0) {
      const now = this.now()
      this.recent = this.recent.filter(time => now - time < HOUR_MS)
      if (this.recent.length >= this.maxRunsPerHour) at = Math.max(at, this.recent[this.recent.length - this.maxRunsPerHour] + HOUR_MS)
    }
    return at
  }

  arm() {
    if (this.stopped || this.timer !== undefined || this.pending.length === 0) return
    const delay = Math.max(0, this.due() - this.now())
    this.timer = this.timers.set(() => {
      this.timer = undefined
      this.flush()
    }, delay)
    this.timer?.unref?.()
  }

  /** Run the batch if it is due and the job is idle; otherwise wait. */
  flush() {
    if (this.stopped || this.pending.length === 0) return
    if (this.due() > this.now()) return this.arm()
    // Running: idle() starts the follow-up run when the current one ends.
    if (this.busy()) return
    const batch = { events: this.pending, dropped: this.dropped }
    const releases = this.releases
    this.pending = []
    this.releases = []
    this.dropped = 0
    this.openedAt = undefined
    this.recent.push(this.now())
    this.startRun(batch)
    for (const release of releases) release()
  }

  /** The job's run ended: start a waiting batch whose window has closed. */
  idle() {
    if (this.timer === undefined) this.flush()
  }

  /** Drop waiting events (job paused, ended or deleted); they are released. */
  discard() {
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
    const releases = this.releases
    this.pending = []
    this.releases = []
    this.dropped = 0
    this.openedAt = undefined
    for (const release of releases) release()
  }

  /** Stop without releasing: unreleased spool events are read again at the next start. */
  stop() {
    this.stopped = true
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
  }
}

/** Bytes of events placed in an agent prompt. */
export const MAX_PROMPT_EVENT_BYTES = 32 * 1024

/** One line per event, as shown to a gate on stdin and to an agent. */
export function eventLines(batch, limit = Infinity) {
  const lines = batch.events.map(event => JSON.stringify(event))
  let omitted = batch.dropped
  let size = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
  while (size > limit && lines.length > 1) {
    size -= Buffer.byteLength(lines.shift()) + 1
    omitted++
  }
  return { lines, omitted }
}

/** What a command gets on stdin for an event run. */
export function eventInput(batch) {
  return `${JSON.stringify({ trigger: 'event', events: batch.events, dropped: batch.dropped })}\n`
}

/** Short summary of a batch for the run history and run log. */
export function batchSummary(batch) {
  const channels = [...new Set(batch.events.map(event => event.channel))]
  return { count: batch.events.length + batch.dropped, channels: channels.slice(0, 20) }
}
