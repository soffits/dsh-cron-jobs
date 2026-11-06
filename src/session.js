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
 * `workspaceRegistry`, `sessionTitle` (optional).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {object} request
 * @param {string} request.text - Message text.
 * @param {string} request.title - Session title.
 * @param {string} [request.agentPreset] - Agent preset id; the host default when omitted.
 * @param {string} [request.cwd] - Session directory; the host default when omitted.
 * @param {{ warn: Function }} logger
 * @returns {Promise<string>} The new session id.
 */
export async function openAgentSession(ctx, { text, title, agentPreset, cwd }, logger) {
  const controller = ctx.get('sessionController')
  const sessions = ctx.get('sessions')
  if (controller === undefined || sessions === undefined) {
    throw new Error('this host cannot create sessions (no sessionController service)')
  }
  const open = async () => {
    const { sessionId } = await controller.create({
      ...(cwd ? { cwd } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    })
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const { agent } = resolved

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
