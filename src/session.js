import { randomUUID } from 'node:crypto'

/**
 * Open a new agent session and send it one user message, the same way the
 * built-in Schedule delivers a run with a `new` target: create the session
 * through the Session controller, resolve its live agent, attach it to the
 * Workspace registered at its directory, name it, queue the message as a
 * follow-up (which starts a turn), and wait until session persistence has
 * stored the message.
 *
 * Uses only public Host services, read with `ctx.get()` so that hosts
 * without them still run plain jobs:
 * `sessionController` (required), `sessions` (required), `agents`,
 * `workspaceRegistry`, `sessionTitle`, `llm` (optional).
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
 * @param {string} request.title - Session title.
 * @param {string} [request.agentPreset] - Agent preset id; the host default when omitted.
 * @param {string} [request.cwd] - Session directory; the host default when omitted.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} [request.model] - Model of the session; the preset or host default when omitted.
 * @param {{ warn: Function }} logger
 * @returns {Promise<string>} The new session id.
 */
export async function openAgentSession(ctx, { text, title, agentPreset, cwd, model }, logger) {
  const controller = ctx.get('sessionController')
  const sessions = ctx.get('sessions')
  if (controller === undefined || sessions === undefined) {
    throw new Error('this host cannot create sessions (no sessionController service)')
  }
  const open = async () => {
    if (model !== undefined) await checkModel(ctx, model)
    const { sessionId } = await controller.create({
      ...(cwd ? { cwd } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    })
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const { agent } = resolved
    if (model !== undefined) agent.model.select({ ...model })

    await joinWorkspace(ctx, sessionId, cwd, logger)
    nameSession(ctx, agent, title, logger)

    agent.followup(userMessage(text))
    if (!await sessions.flush(agent.session)) {
      throw new Error('session persistence did not acknowledge the message')
    }
    return sessionId
  }
  // A timer callback has no initiating agent; clearing it anyway keeps the new
  // session a top-level session rather than a child of whatever is running.
  const agents = ctx.get('agents')
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
 * {@link userHold}) is refused, so a job never barges into a conversation.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} request
 * @param {string} request.sessionId
 * @param {string} request.text
 * @param {boolean} [request.mayUnarchive]
 * @returns {Promise<{ sessionId: string, queued: boolean, unarchived: boolean }>}
 *   `queued`: the session was busy and the message waits for its next turn.
 */
export async function deliverToSession(ctx, { sessionId, text, mayUnarchive = false }) {
  const controller = ctx.get('sessionController')
  const sessions = ctx.get('sessions')
  if (controller === undefined || sessions === undefined) {
    throw new Error('this host cannot resume sessions (no sessionController service)')
  }
  const deliver = async () => {
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const { agent } = resolved
    const hold = userHold(ctx, sessionId, agent.session)
    if (hold !== undefined) throw new Error(`the session is in use (${hold})`)
    const registry = ctx.get('workspaceRegistry')
    const archived = registry?.archivedSessionIds?.includes(sessionId) === true
    if (archived) {
      if (!mayUnarchive) throw new Error('the session is archived')
      await registry.unarchiveSession(sessionId)
    }
    const queued = agent.status !== undefined && agent.status !== 'idle'
    agent.followup(userMessage(text))
    if (!await sessions.flush(agent.session)) {
      throw new Error('session persistence did not acknowledge the message')
    }
    return { sessionId, queued, unarchived: archived }
  }
  const agents = ctx.get('agents')
  return agents === undefined ? deliver() : agents.withoutInitiator(deliver)
}

/**
 * Why a session belongs to a person now, or undefined when it does not: it is
 * pinned in the sidebar, or a person has taken it over by sending it a
 * message from any client (Web UI, Telegram, or another). DSH marks what a
 * person sends with source kind `user`; this plugin's prompts are `schedule`,
 * and machine messages inside its own turns (runtime context, subagent
 * results) have their own kinds. Such a session is neither archived nor
 * reused.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {{ log?: Array<{ type: string, data?: any }> }} [session] - The live session, to read its message log.
 * @returns {string | undefined}
 */
export function userHold(ctx, sessionId, session) {
  if (ctx.get('workspaceRegistry')?.pinnedSessionIds?.includes(sessionId)) return 'pinned'
  if (session?.log?.some(event => event.type === 'user/message' && event.data?.source?.kind === 'user')) {
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
} = {}) {
  const controller = ctx.get('sessionController')
  const registry = ctx.get('workspaceRegistry')
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
    const result = await lock(async () => {
      if (!isLatest()) return { archive: 'superseded' }
      const hold = userHold(ctx, sessionId, agent.session)
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
 * Web GUI show it as a scheduled run.
 */
export function userMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'schedule' },
  })
}

/** Reject a model the host cannot route, before any session is created. */
async function checkModel(ctx, model) {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('this host cannot select models (no llm service)')
  try {
    await llm.resolveCallConfig({ ...model })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`model ${model.provider}/${model.model} is not available: ${reason}`)
  }
}

async function joinWorkspace(ctx, sessionId, cwd, logger) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || !cwd) return
  try {
    await (await registry.resolveByPath(cwd))?.attachSession(sessionId)
  } catch (error) {
    logger.warn('session %s did not join the workspace at %s: %s', sessionId, cwd, String(error))
  }
}

function nameSession(ctx, agent, title, logger) {
  const titles = ctx.get('sessionTitle')
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
