import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/**
 * Result delivery: after a run, a job's result can be handed to another
 * plugin that sends it somewhere (a chat, a mail box, a webhook). The plugin
 * knows no channel itself. A delivery target names a DSH service and an
 * address that service understands:
 *
 *     { via: 'telegramTopics', to: 'notify' }
 *
 * At delivery time the service is looked up by name and its `send` method is
 * called with `{ to, text, files, from }` (see README, "Delivery channels").
 */

/** Answer that means "nothing to send". */
export const SILENT = '[SILENT]'

/** Delivery attempts per result: the first try and two retries. */
export const DELIVERY_ATTEMPTS = 3
/** Wait before each retry, in milliseconds. */
export const DELIVERY_RETRY_MS = [5_000, 30_000]

/**
 * How long a delivery waits for its service to be running again (a plugin
 * reload, a stuck unload) before it fails. A restart in between leaves the
 * delivery pending, and the next start waits again.
 */
export const SERVICE_WAIT_MS = 60 * 60_000
/** How often a waiting delivery looks for its service. */
export const SERVICE_POLL_MS = 10_000

/** Lines of stderr shown in a failure note. */
export const FAILURE_STDERR_LINES = 15

const MEDIA_LINE = /^\s*MEDIA:\s*(\S.*?)\s*$/

/**
 * @typedef {{ via: string, to: string }} DeliveryTarget
 */

/**
 * Normalise a delivery target from the config, storage or a tool: an object
 * `{ via, to }`, or `false` for "deliver nothing". Anything else, or an empty
 * `via`, is undefined (not set).
 * @param {unknown} value
 * @returns {DeliveryTarget | false | undefined}
 */
export function deliveryTarget(value) {
  if (value === false) return false
  if (value === null || typeof value !== 'object') return undefined
  const via = typeof value.via === 'string' ? value.via.trim() : ''
  if (via === '') return undefined
  return { via, to: typeof value.to === 'string' ? value.to.trim() : '' }
}

/**
 * Where a job's result goes: the job's own `deliver`, else nothing for a job
 * that posts into an existing session (its answer is already in that
 * conversation), else the plugin default.
 * @param {{ deliver?: unknown, target?: { kind: string } }} job
 * @param {unknown} [fallback] - The plugin's default target.
 * @returns {DeliveryTarget | undefined}
 */
export function resolveDelivery(job, fallback) {
  const own = deliveryTarget(job.deliver)
  if (own !== undefined) return own === false ? undefined : own
  if (job.target?.kind === 'session') return undefined
  return deliveryTarget(fallback) || undefined
}

/** `via:to` for logs and the page. */
export function describeTarget(target) {
  return target.to ? `${target.via}:${target.to}` : target.via
}

/**
 * Turn a result text into a message: `MEDIA:<path>` lines become files
 * (relative paths and `~` resolved against `cwd` and the home directory),
 * the rest is the text. Empty text, or exactly `[SILENT]`, with no files is
 * nothing to send.
 * @param {string | undefined} raw
 * @param {string} [cwd]
 * @returns {{ text: string, files: string[] } | undefined}
 */
export function messageFromText(raw, cwd) {
  if (typeof raw !== 'string') return undefined
  const files = []
  const kept = []
  for (const line of raw.split(/\r?\n/)) {
    const media = MEDIA_LINE.exec(line)
    if (media) files.push(mediaPath(media[1], cwd))
    else kept.push(line)
  }
  let text = kept.join('\n').trim()
  if (text === SILENT) text = ''
  if (text === '' && files.length === 0) return undefined
  return { text, files }
}

function mediaPath(raw, cwd) {
  let path = raw.replace(/^[`'"]+|[`'"]+$/g, '')
  if (path === '~' || path.startsWith('~/')) path = homedir() + path.slice(1)
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path)
}

/**
 * The result text of a command run: its stdout, and after a failure a short
 * note with the job name, how it ended, and the end of stderr.
 * @param {{ name: string, timeoutSeconds?: number }} job
 * @param {import('./command.js').CommandResult} result
 * @returns {string}
 */
export function commandResultText(job, result) {
  const out = (result.stdout ?? '').trimEnd()
  if (result.ok) return out
  const stderr = (result.stderr ?? '').trim().split('\n').slice(-FAILURE_STDERR_LINES).join('\n')
  const note = `⚠️ ${failureLine(job, result)}${stderr ? `\n${stderr}` : ''}`
  return out.trim() ? `${out}\n\n${note}` : note
}

/** One line saying how a command run failed. */
export function failureLine(job, result) {
  if (result.error !== undefined) return `${job.name} could not run: ${result.error}`
  if (result.timedOut) return `${job.name} timed out after ${job.timeoutSeconds}s`
  if (result.signal) return `${job.name} was killed by ${result.signal}`
  return `${job.name} failed (exit ${result.exitCode})`
}

/**
 * The final answer of the turn that a given message started: the last text
 * block of the last assistant message between that `user/message` event and
 * the next `turn/end`. Only the last block counts because some providers
 * (Claude Code through dsh-oh-my-claude) put every text block of their own
 * inner tool loop into one assistant message, so narration would otherwise
 * be glued in front of a final `[SILENT]`. `done` is false while the turn is
 * still open, or the message has not entered a turn yet.
 * @param {Array<{ type: string, data?: any }>} log - The session's event log.
 * @param {string} messageId - Id of the prompt the job sent.
 * @returns {{ done: boolean, text?: string, reason?: string }}
 */
export function finalAnswer(log, messageId) {
  const start = log.findIndex(event => event.type === 'user/message' && event.data?.id === messageId)
  if (start === -1) return { done: false }
  let text = ''
  for (let i = start + 1; i < log.length; i++) {
    const event = log[i]
    if (event.type === 'assistant/message') {
      const parts = event.data?.message?.content ?? []
      const texts = parts.filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text.trim()).filter(Boolean)
      text = texts.at(-1) ?? ''
    } else if (event.type === 'turn/end') {
      // dsh-fallback-models stops a turn whose model failed and continues the
      // work in the next turn on a fallback model; the answer is there.
      if (continuedElsewhere(event.data?.reason)) continue
      return { done: true, text, reason: event.data?.reason?.kind }
    }
  }
  return { done: false }
}

/** Prefix of the stop reason dsh-fallback-models records on a turn it continues. */
export const FALLBACK_REASON_PREFIX = 'dsh-fallback-models:'

/** Whether a turn ended only because its work continues in the next turn. */
function continuedElsewhere(reason) {
  return reason?.kind === 'aborted' && reason.reason?.kind === 'hook'
    && typeof reason.reason.reason === 'string' && reason.reason.reason.startsWith(FALLBACK_REASON_PREFIX)
}

/** An error from the channel that a retry will not fix. */
function permanent(error) {
  return error !== null && typeof error === 'object' && error.retryable === false
}

/**
 * Hand one message to the target's service, retrying transient failures.
 * A service that is not running is waited for (looked up every `pollMs`, up
 * to `waitMs` in all) instead of counting as a failed attempt. Never rejects.
 *
 * Results: `sent`; `failed` (the service threw on every attempt, or a
 * permanent error); `unavailable` (the service was still not running after
 * `waitMs`); `stopped` (the signal fired before the message was sent). The
 * last two are not final: the caller decides whether to keep the message
 * pending.
 * @param {object} options
 * @param {(name: string) => any} options.lookup - Finds a service by name.
 * @param {DeliveryTarget} options.target
 * @param {{ text: string, files: string[] }} options.message
 * @param {{ job: string, sessionId?: string }} options.from
 * @param {AbortSignal} [options.signal] - Stops waiting.
 * @param {number} [options.attempts]
 * @param {number[]} [options.retryMs]
 * @param {number} [options.waitMs] - Longest wait for a missing service; 0 gives up at once.
 * @param {number} [options.pollMs]
 * @param {(error: string) => void} [options.onWait] - Called once, when the wait for a missing service starts.
 * @returns {Promise<{ status: 'sent' | 'failed' | 'unavailable' | 'stopped', attempts: number, error?: string }>}
 */
export async function sendMessage({
  lookup, target, message, from, signal, attempts = DELIVERY_ATTEMPTS, retryMs = DELIVERY_RETRY_MS,
  waitMs = SERVICE_WAIT_MS, pollMs = SERVICE_POLL_MS, onWait,
}) {
  const deadline = Date.now() + waitMs
  const missing = `no service named ${target.via} is running`
  let waiting = false
  let error
  let tried = 0
  while (tried < attempts) {
    if (signal?.aborted) return { status: 'stopped', attempts: tried, error: error ?? 'stopped before sending' }
    let service
    try {
      service = lookup(target.via)
    } catch {
      service = undefined
    }
    if (service === undefined || service === null) {
      error = missing
      if (Date.now() >= deadline) {
        return { status: 'unavailable', attempts: tried, error: waitMs > 0 ? `${error} (waited ${minutes(waitMs)})` : error }
      }
      if (!waiting) {
        waiting = true
        onWait?.(error)
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal)
      continue
    }
    if (typeof service.send !== 'function') {
      return { status: 'failed', attempts: tried + 1, error: `service ${target.via} has no send method` }
    }
    tried++
    try {
      await service.send({ to: target.to, text: message.text, files: [...message.files], from: { ...from } })
      return { status: 'sent', attempts: tried }
    } catch (caught) {
      error = describe(caught)
      if (permanent(caught)) return { status: 'failed', attempts: tried, error }
    }
    if (tried < attempts) await sleep(retryMs[Math.min(tried - 1, retryMs.length - 1)] ?? 0, signal)
  }
  return { status: 'failed', attempts, error }
}

function minutes(ms) {
  const count = Math.round(ms / 60_000)
  return count >= 1 ? `${count} min` : `${Math.round(ms / 1000)} s`
}

function sleep(ms, signal) {
  return new Promise((done) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      done()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function describe(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}
