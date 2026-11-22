import { randomUUID } from 'node:crypto'
import { finalAnswer } from './deliver.js'

/**
 * Open a new agent session and send it one user message, the same way the
 * built-in Schedule delivers a run with a `new` target: create the session
 * through the Session controller, resolve its live agent, attach it to the
 * Workspace registered at its directory, name it, queue the message as a
 * follow-up (which starts a turn), and wait until session persistence has
 * stored the message.
 *
 * Uses only public Host services, so that hosts without them still run
 * plain jobs: `sessionController` and `sessions` (required), `agents`,
 * `workspaceRegistry`, `sessionTitle`, and `llm` when a model is requested.
 * Every one is read through {@link sessionServices}, which waits for a
 * service the host has not registered yet (a run right after a DSH start).
 *
 * A requested model is checked with `llm.resolveCallConfig()` before the
 * session is created, then set on the new session's agent with
 * `agent.model.select()`, the same steps the Web model picker's
 * `selectModel` takes. Unlike the picker, it does not save the choice as the
 * host's default model, so a job's model never changes other sessions.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {object} request
 * @param {string} request.text - Message text.
 * @param {string} [request.messageId] - Id of the message, so its answer can be found later.
 * @param {object} [request.principal] - Who sends the message, recorded on its source.
 * @param {string} request.title - Session title.
 * @param {string} [request.agentPreset] - Agent preset id; the host default when omitted.
 * @param {string} [request.cwd] - Session directory; the host default when omitted.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} [request.model] - Model of the session; the preset or host default when omitted.
 * @param {{ warn: Function }} logger
 * @param {ServiceWait} [wait]
 * @returns {Promise<string>} The new session id.
 */
export async function openAgentSession(ctx, { text, messageId, principal, title, agentPreset, cwd, model }, logger, wait = {}) {
  const { sessionController: controller, sessions, agents, workspaceRegistry, sessionTitle, llm } = await sessionServices(ctx, {
    required: ['sessionController', 'sessions', ...(model !== undefined ? ['llm'] : [])],
    optional: ['agents', 'workspaceRegistry', 'sessionTitle'],
  }, wait)
  if (controller === undefined || sessions === undefined) {
    throw new Error('this host cannot create sessions (no sessionController service)')
  }
  const open = async () => {
    if (model !== undefined) await checkModel(llm, model)
    const { sessionId } = await controller.create({
      ...(cwd ? { cwd } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    })
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const { agent } = resolved
    if (model !== undefined) agent.model.select({ ...model })

    await joinWorkspace(workspaceRegistry, sessionId, cwd, logger)
    nameSession(sessionTitle, agent, title, logger)

    agent.followup(userMessage(text, messageId, principal))
    if (!await sessions.flush(agent.session)) {
      throw new Error('session persistence did not acknowledge the message')
    }
    return sessionId
  }
  // A timer callback has no initiating agent; clearing it anyway keeps the new
  // session a top-level session rather than a child of whatever is running.
  return agents === undefined ? open() : agents.withoutInitiator(open)
}

/**
 * Send one user message into an existing session, the way the built-in
 * Schedule delivers to a `session` target: resolve (and if needed resume) its
 * live agent with `sessionController.resolveAgent()`, queue the message as a
 * follow-up, and wait until session persistence has stored it. A busy agent
 * keeps the message queued for its next turn; an idle one starts that turn.
 *
 * DSH blocks every model step of an archived session (the Session
 * controller's archived-session gate), so an archived session is unarchived
 * first, and only when `mayUnarchive` is set: the caller archives it again
 * once the turn is over. A session a person has taken over or pinned (see
 * {@link userHold}) is refused, so a reused session never barges into a
 * conversation, unless `ignoreHold` is set: a job whose target is that
 * session (such as a reminder created from it) is meant to post there.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} request
 * @param {string} request.sessionId
 * @param {string} request.text
 * @param {string} [request.messageId] - Id of the message, so its answer can be found later.
 * @param {object} [request.principal] - Who sends the message, recorded on its source.
 * @param {boolean} [request.mayUnarchive]
 * @param {boolean} [request.ignoreHold] - Deliver even to a pinned session or one a person uses.
 * @param {ServiceWait} [wait]
 * @returns {Promise<{ sessionId: string, queued: boolean, unarchived: boolean }>}
 *   `queued`: the session was busy and the message waits for its next turn.
 */
export async function deliverToSession(ctx, { sessionId, text, messageId, principal, mayUnarchive = false, ignoreHold = false }, wait = {}) {
  const { sessionController: controller, sessions, agents, workspaceRegistry: registry } = await sessionServices(ctx, {
    required: ['sessionController', 'sessions'],
    optional: ['agents', 'workspaceRegistry'],
  }, wait)
  if (controller === undefined || sessions === undefined) {
    throw new Error('this host cannot resume sessions (no sessionController service)')
  }
  const deliver = async () => {
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const { agent } = resolved
    const hold = ignoreHold ? undefined : userHold(registry, sessionId, agent.session)
    if (hold !== undefined) throw new Error(`the session is in use (${hold})`)
    const archived = registry?.archivedSessionIds?.includes(sessionId) === true
    if (archived) {
      if (!mayUnarchive) throw new Error('the session is archived')
      await registry.unarchiveSession(sessionId)
    }
    const queued = agent.status !== undefined && agent.status !== 'idle'
    agent.followup(userMessage(text, messageId, principal))
    if (!await sessions.flush(agent.session)) {
      throw new Error('session persistence did not acknowledge the message')
    }
    return { sessionId, queued, unarchived: archived }
  }
  return agents === undefined ? deliver() : agents.withoutInitiator(deliver)
}

/**
 * Principal kinds for senders that are not people: another DSH session, a
 * scheduled job, an outside script. The same shared kinds `dsh-message-context`
 * uses to tell agent messages from a person's; a channel records one of them
 * on `source.principal` for what a machine sent through it.
 */
export const NON_PERSON_PRINCIPAL_KINDS = Object.freeze(['dsh-session', 'cron-job', 'external'])

/**
 * Whether a person typed this message. DSH gives every message another
 * session, job or tool sends (`prompt_session`, `open_session`) source kind
 * `user` as well, so the kind alone cannot tell: the caller behind it is
 * `source.principal`, which DSH and the channel plugins write from the
 * connection's own identity (never from message text). A person is the owner
 * in the Web UI (no principal) or a channel's verified sender (`oidc-user`,
 * `telegram-user`, ...); a principal of a non-person kind is an agent.
 *
 * @param {{ kind?: string, principal?: { kind?: string } } | undefined} source - `source` of a `user/message` event.
 * @returns {boolean}
 */
export function sentByPerson(source) {
  return source?.kind === 'user' && !NON_PERSON_PRINCIPAL_KINDS.includes(source.principal?.kind)
}

/**
 * Why a session belongs to a person now, or undefined when it does not: it is
 * pinned in the sidebar, or a person has taken it over by sending it a
 * message from any client (Web UI, Telegram, or another; see
 * {@link sentByPerson}). This plugin's prompts are `schedule`, machine
 * messages inside its own turns (runtime context, subagent results) have
 * their own kinds, and messages from other agent sessions or jobs carry an
 * agent principal. Such a session is neither archived nor reused.
 *
 * @param {{ pinnedSessionIds?: string[] } | undefined} registry - The Workspace registry, when the host has one.
 * @param {string} sessionId
 * @param {{ log?: Array<{ type: string, data?: any }> }} [session] - The live session, to read its message log.
 * @returns {string | undefined}
 */
export function userHold(registry, sessionId, session) {
  if (registry?.pinnedSessionIds?.includes(sessionId)) return 'pinned'
  if (session?.log?.some(event => event.type === 'user/message' && sentByPerson(event.data?.source))) {
    return 'taken over by a person'
  }
  return undefined
}

/** Time between archive attempts while DSH still reports the session active. */
export const ARCHIVE_RETRY_MS = 5000
/** Archive attempts before giving up on a session that stays active. */
export const ARCHIVE_ATTEMPTS = 60

/**
 * Wait until a woken session's agent is idle (its turn, and any message
 * queued behind it, finished or failed), then archive the session with the
 * Workspace registry, the same service the sidebar's Archive action uses. An
 * archived session leaves the sidebar's active list but stays in DSH, and
 * session search still finds it.
 *
 * Never archives a running session: the registry itself refuses while any
 * `workspace/session-activity` listener reports work, and that refusal is
 * retried after the next idle. A session the user holds is kept.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Plugin unload; the session is left for the next copy.
 * @param {() => boolean} [options.isLatest] - False once a later run sent another message to this session; that run archives it.
 * @param {<T>(fn: () => Promise<T>) => Promise<T>} [options.lock] - Serializes the final check and the archive with deliveries to the same session.
 * @param {number} [options.retryMs]
 * @param {number} [options.attempts]
 * @returns {Promise<{ archive: 'archived' | 'kept' | 'pending' | 'superseded', note?: string }>}
 */
export async function archiveWhenIdle(ctx, sessionId, {
  signal, isLatest = () => true, lock = fn => fn(), retryMs = ARCHIVE_RETRY_MS, attempts = ARCHIVE_ATTEMPTS,
  serviceWaitMs = SERVICE_WAIT_MS,
} = {}) {
  const controller = await hostService(ctx, 'sessionController', { signal, waitMs: serviceWaitMs })
  const registry = await hostService(ctx, 'workspaceRegistry', { signal, waitMs: serviceWaitMs })
  if (signal?.aborted) return { archive: 'pending' }
  if (controller === undefined || registry === undefined) {
    return { archive: 'kept', note: 'this host has no workspace archive' }
  }
  for (let attempt = 1; ; attempt++) {
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) return { archive: 'kept', note: `session not found: ${describe(resolved.error)}` }
    const { agent } = resolved
    // A failed turn still ends the activity; its error belongs to the session.
    await agent.whenIdle().catch(() => {})
    if (signal?.aborted) return { archive: 'pending' }
    // A turn DSH's own stop cut off is unfinished work: dsh-restart-resume finds it after the
    // restart only in a session that is not archived, and the rerun's own run archives it later.
    if (turnCutByShutdown(agent.session?.log ?? [])) return { archive: 'kept', note: 'its turn was cut off by a DSH stop' }
    const result = await lock(async () => {
      if (!isLatest()) return { archive: 'superseded' }
      const hold = userHold(registry, sessionId, agent.session)
      if (hold !== undefined) return { archive: 'kept', note: hold }
      try {
        await registry.archiveSession(sessionId)
        return { archive: 'archived' }
      } catch (error) {
        if (error?.name !== 'WorkspaceActiveSessionError' || attempt >= attempts) {
          return { archive: 'kept', note: `not archived: ${describe(error)}` }
        }
        return undefined
      }
    })
    if (result !== undefined) return result
    await sleep(retryMs, signal)
    if (signal?.aborted) return { archive: 'pending' }
  }
}

/** Whether the session's last turn ended because DSH stopped (aborted `disposed`) or died (`interrupted`). */
export function turnCutByShutdown(log) {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i]?.type === 'turn/start') return false
    if (log[i]?.type !== 'turn/end') continue
    const reason = log[i].data?.reason
    const kind = reason?.kind === 'aborted' ? reason.reason?.kind : reason?.kind
    return kind === 'disposed' || kind === 'interrupted'
  }
  return false
}

/** Time between checks while a prompt waits for its turn to end. */
export const ANSWER_RETRY_MS = 5000
/** Checks before giving up on a prompt that never reaches a finished turn. */
export const ANSWER_ATTEMPTS = 120

/**
 * Wait until the turn that a job's prompt started has ended, then return its
 * final answer (see finalAnswer in deliver.js). Waiting uses the agent's idle
 * signal; a prompt still queued behind other work, or a turn that has not
 * started yet, is checked again after the next idle.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {string} messageId - Id of the prompt.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Plugin unload: resolves `{ pending: true }`.
 * @param {number} [options.retryMs]
 * @param {number} [options.attempts]
 * @returns {Promise<{ pending: true } | { text: string, reason?: string, cause?: string } | { error: string }>}
 */
export async function waitForAnswer(ctx, sessionId, messageId, {
  signal, retryMs = ANSWER_RETRY_MS, attempts = ANSWER_ATTEMPTS, serviceWaitMs = SERVICE_WAIT_MS,
}) {
  const controller = await hostService(ctx, 'sessionController', { signal, waitMs: serviceWaitMs })
  if (signal?.aborted) return { pending: true }
  if (controller === undefined) return { error: 'this host cannot read sessions (no sessionController service)' }
  for (let attempt = 1; ; attempt++) {
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) return { error: `session not found: ${describe(resolved.error)}` }
    const { agent } = resolved
    await agent.whenIdle().catch(() => {})
    if (signal?.aborted) return { pending: true }
    const answer = finalAnswer(agent.session?.log ?? [], messageId)
    if (answer.done) return { text: answer.text ?? '', reason: answer.reason, ...(answer.cause ? { cause: answer.cause } : {}), ...(answer.failure ? { failure: answer.failure } : {}) }
    if (attempt >= attempts) return { error: 'the prompt never reached a finished turn' }
    await sleep(retryMs, signal)
    if (signal?.aborted) return { pending: true }
  }
}

/** How long a resumed delivery or archive waits for a Host service to appear. */
export const SERVICE_WAIT_MS = 120_000
const SERVICE_POLL_MS = 500

/**
 * Read a Host service, waiting up to `waitMs` for it to be provided. At DSH
 * startup this plugin can start (and resume runs an earlier copy left
 * pending) before the session services are registered; reading them once
 * then failed a pending delivery for good (2026-11-13, "no sessionController
 * service" right after a restart). Resolves undefined when the service never
 * appears or the signal aborts.
 */
export async function hostService(ctx, name, { signal, waitMs = SERVICE_WAIT_MS, pollMs = SERVICE_POLL_MS } = {}) {
  const deadline = Date.now() + waitMs
  for (;;) {
    const service = ctx.get(name)
    if (service !== undefined || signal?.aborted || Date.now() >= deadline) return service
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal)
  }
}

/** How long an optional service is waited for once the required ones are there. */
export const OPTIONAL_SERVICE_WAIT_MS = 10_000

/**
 * @typedef {object} ServiceWait
 * @property {AbortSignal} [signal] - Plugin unload: stop waiting.
 * @property {number} [waitMs] - Wait for a required service; {@link SERVICE_WAIT_MS} by default.
 * @property {number} [optionalWaitMs] - Wait for an optional one after that; {@link OPTIONAL_SERVICE_WAIT_MS} by default.
 * @property {number} [pollMs]
 */

/**
 * Read the Host services a session path needs, waiting for them the way
 * {@link hostService} does: a job that fires while DSH is still starting
 * (a catch-up run, an event from a watcher) would otherwise find no
 * `sessionController` and fail (2026-11-16, a check-in's catch-up run ten
 * seconds after a restart). Required services are waited for fully; optional
 * ones, which come from other plugins of the same start, a short time more,
 * so a host that lacks one still runs jobs without a long delay.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ required: string[], optional?: string[] }} names
 * @param {ServiceWait} [wait]
 * @returns {Promise<Record<string, any>>} Each name mapped to its service, or undefined.
 */
export async function sessionServices(ctx, { required, optional = [] }, { signal, waitMs = SERVICE_WAIT_MS, optionalWaitMs = OPTIONAL_SERVICE_WAIT_MS, pollMs } = {}) {
  const read = (names, ms) => Promise.all(names.map(name => hostService(ctx, name, { signal, waitMs: ms, ...(pollMs !== undefined ? { pollMs } : {}) })))
  const found = await read(required, waitMs)
  const extra = await read(optional, found.every(service => service !== undefined) ? optionalWaitMs : 0)
  return Object.fromEntries([...required, ...optional].map((name, i) => [name, i < found.length ? found[i] : extra[i - found.length]]))
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function describe(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

/**
 * A user-role message from a scheduled source. `kind: 'schedule'` makes the
 * Web GUI show it as a scheduled run. `principal`, DSH's field for the caller
 * behind a user message, names the job that sent it (see
 * `JobRunner.promptPrincipal`), so session readers need not parse the text.
 * @param {string} text
 * @param {string} [id]
 * @param {object} [principal]
 */
export function userMessage(text, id = randomUUID(), principal) {
  return deepFreeze({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'schedule', ...(principal ? { principal: { ...principal } } : {}) },
  })
}

/** Reject a model the host cannot route, before any session is created. */
async function checkModel(llm, model) {
  if (llm === undefined) throw new Error('this host cannot select models (no llm service)')
  try {
    await llm.resolveCallConfig({ ...model })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`model ${model.provider}/${model.model} is not available: ${reason}`)
  }
}

async function joinWorkspace(registry, sessionId, cwd, logger) {
  if (registry === undefined || !cwd) return
  try {
    await (await registry.resolveByPath(cwd))?.attachSession(sessionId)
  } catch (error) {
    logger.warn('session %s did not join the workspace at %s: %s', sessionId, cwd, String(error))
  }
}

function nameSession(titles, agent, title, logger) {
  if (titles === undefined) return
  try {
    titles.rename(agent.session, title)
  } catch (error) {
    logger.warn('session %s was not named: %s', agent.id, String(error))
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
