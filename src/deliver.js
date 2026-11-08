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
 * The final answer of the turn that a given message started: the text of the
 * last assistant message between that `user/message` event and the next
 * `turn/end`. `done` is false while the turn is still open, or the message
 * has not entered a turn yet.
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
      text = parts.filter(part => part?.type === 'text').map(part => part.text).join('').trim()
    } else if (event.type === 'turn/end') {
      return { done: true, text, reason: event.data?.reason?.kind }
    }
  }
  return { done: false }
}

/** An error from the channel that a retry will not fix. */
function permanent(error) {
  return error !== null && typeof error === 'object' && error.retryable === false
}

/**
 * Hand one message to the target's service, retrying transient failures.
 * Never rejects.
 * @param {object} options
 * @param {(name: string) => any} options.lookup - Finds a service by name.
 * @param {DeliveryTarget} options.target
 * @param {{ text: string, files: string[] }} options.message
 * @param {{ job: string, sessionId?: string }} options.from
 * @param {AbortSignal} [options.signal] - Stops waiting between attempts.
 * @param {number} [options.attempts]
 * @param {number[]} [options.retryMs]
 * @returns {Promise<{ status: 'sent' | 'failed', attempts: number, error?: string }>}
 */
export async function sendMessage({ lookup, target, message, from, signal, attempts = DELIVERY_ATTEMPTS, retryMs = DELIVERY_RETRY_MS }) {
  let error
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let retry = true
    try {
      const service = lookup(target.via)
      if (service === undefined || service === null) {
        throw new Error(`no service named ${target.via} is running`)
      }
      if (typeof service.send !== 'function') {
        retry = false
        throw new Error(`service ${target.via} has no send method`)
      }
      await service.send({ to: target.to, text: message.text, files: [...message.files], from: { ...from } })
      return { status: 'sent', attempts: attempt }
    } catch (caught) {
      error = describe(caught)
      if (!retry || permanent(caught)) return { status: 'failed', attempts: attempt, error }
    }
    if (attempt < attempts) {
      await sleep(retryMs[Math.min(attempt - 1, retryMs.length - 1)] ?? 0, signal)
      if (signal?.aborted) return { status: 'failed', attempts: attempt, error: `${error} (stopped before retrying)` }
    }
  }
  return { status: 'failed', attempts, error }
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
