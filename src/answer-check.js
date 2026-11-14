/**
 * Answer checks: a job may name a command that reads its agent's final answer
 * on stdin before the turn closes. Empty stdout passes the answer; anything
 * else is steered back into the same turn as a rewrite request, so the agent
 * writes the answer again and the job delivers that one. Each prompt is
 * steered at most once, so a check that never passes cannot loop a turn.
 *
 * The hook is DSH's `agent/turn-stopping` (serial): when a turn is about to
 * close with an empty next-step inbox, a listener that calls `agent.steer()`
 * makes the loop run one more step in the same turn.
 */
import { randomUUID } from 'node:crypto'
import { messageFromText } from './deliver.js'
import { userMessage } from './session.js'

/** Limit for one run of a check command. */
export const ANSWER_CHECK_TIMEOUT_MS = 60_000

/**
 * How long a prompt stays watched. A run whose answer is not delivered (no
 * delivery target) is never forgotten by its delivery, so old entries are
 * dropped when new ones come.
 */
export const ANSWER_CHECK_TTL_MS = 12 * 60 * 60 * 1000

/**
 * The answer a turn has so far: the last text block of the last assistant
 * message after the prompt with `messageId`, when that prompt is in the turn
 * still open at the end of the log. Undefined when the prompt is not there or
 * a turn has ended since.
 * @param {Array<{ type: string, data?: any }>} log
 * @param {string} messageId
 * @returns {string | undefined}
 */
export function openTurnAnswer(log, messageId) {
  let text
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]
    if (event.type === 'turn/end') return undefined
    if (event.type === 'user/message' && event.data?.id === messageId) return text ?? ''
    if (text === undefined && event.type === 'assistant/message') {
      const parts = event.data?.message?.content ?? []
      const texts = parts.filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text.trim()).filter(Boolean)
      if (texts.length > 0) text = texts.at(-1)
    }
  }
  return undefined
}

/**
 * Whether an answer is worth checking: not empty, not [SILENT], and not only
 * MEDIA lines.
 * @param {string} text
 */
export function checkable(text) {
  const message = messageFromText(text)
  return message !== undefined && message.text.trim() !== ''
}

/**
 * Pending checks, keyed by the prompt's message id.
 * @param {object} deps
 * @param {(options: object) => Promise<import('./command.js').CommandResult>} deps.run - Runs a command (command.js runCommand).
 * @param {{ info: Function, warn: Function }} deps.logger
 * @param {(entry: object) => Promise<void>} [deps.record] - Appends a run-log line.
 * @param {() => Date} [deps.now]
 */
export function createAnswerChecks({ run, logger, record = async () => {}, now = () => new Date() }) {
  /** @type {Map<string, { job: string, command: string, cwd?: string, at: number, steered: boolean, verdict?: string }>} */
  const pending = new Map()

  async function check(entry, text, signal) {
    const result = await run({ command: entry.command, cwd: entry.cwd, input: text, timeoutMs: ANSWER_CHECK_TIMEOUT_MS, signal })
    if (!result.ok) return { error: result.error ?? (result.timedOut ? 'timed out' : `exit code ${result.exitCode}`) }
    return { request: result.stdout.trim() }
  }

  return {
    /**
     * Check the answer to this prompt before its turn closes.
     * @param {string} messageId
     * @param {{ job: string, command: string, cwd?: string }} options
     */
    expect(messageId, { job, command, cwd }) {
      const at = now().getTime()
      for (const [id, entry] of pending) if (at - entry.at > ANSWER_CHECK_TTL_MS) pending.delete(id)
      pending.set(messageId, { job, command, ...(cwd ? { cwd } : {}), at, steered: false })
    },

    /** Stop watching a prompt; returns what its check did ('steered', 'passed', 'error' or undefined). */
    forget(messageId) {
      const entry = pending.get(messageId)
      pending.delete(messageId)
      return entry?.verdict
    },

    /** Number of prompts watched, for tests. */
    get size() {
      return pending.size
    },

    /**
     * The `agent/turn-stopping` listener. Finds a watched prompt in the
     * closing turn, runs its check on the answer and steers a rewrite
     * request when the check prints one.
     * @param {{ agent: { session?: { id?: string, log?: any[] }, steer: (message: object) => void }, signal?: AbortSignal }} payload
     */
    async onTurnStopping({ agent, signal }) {
      if (pending.size === 0) return
      const log = agent?.session?.log ?? []
      for (const [messageId, entry] of pending) {
        if (entry.steered) continue
        const text = openTurnAnswer(log, messageId)
        if (text === undefined) continue
        if (!checkable(text)) return
        const outcome = await check(entry, text, signal).catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
        if (signal?.aborted) return
        const sessionId = agent.session?.id
        const line = { time: now().toISOString(), job: entry.job, event: 'answer-check', ...(sessionId ? { sessionId } : {}) }
        if ('error' in outcome) {
          entry.verdict = 'error'
          logger.warn('[%s] answer check failed: %s', entry.job, outcome.error)
          await record({ ...line, status: 'error', error: outcome.error })
        } else if (outcome.request === '') {
          entry.verdict = 'passed'
          await record({ ...line, status: 'passed' })
        } else {
          entry.steered = true
          entry.verdict = 'steered'
          logger.info('[%s] answer check asked for a rewrite', entry.job)
          await record({ ...line, status: 'steered', request: outcome.request })
          agent.steer(userMessage(outcome.request, randomUUID()))
        }
        return
      }
    },

    /**
     * Run a prompt's check once more on its delivered answer, only to log
     * whether a steered rewrite fixed it. Never steers.
     * @param {string} messageId
     * @param {string} text
     * @param {{ sessionId?: string, signal?: AbortSignal }} [options]
     */
    async recheck(messageId, text, { sessionId, signal } = {}) {
      const entry = pending.get(messageId)
      if (entry?.verdict !== 'steered' || !checkable(text)) return
      const outcome = await check(entry, text, signal).catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
      if (signal?.aborted) return
      const status = 'error' in outcome ? 'error' : outcome.request === '' ? 'fixed' : 'still-flagged'
      if (status === 'still-flagged') logger.warn('[%s] the rewritten answer still fails its check', entry.job)
      await record({
        time: now().toISOString(), job: entry.job, event: 'answer-recheck', ...(sessionId ? { sessionId } : {}), status,
        ...('error' in outcome ? { error: outcome.error } : {}),
      })
    },
  }
}
