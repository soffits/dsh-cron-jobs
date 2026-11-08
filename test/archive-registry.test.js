// Runs archive, pin and unarchive against DSH's real Workspace registry,
// storage hub, domain layer and JSON storage backend inside Cordis, so the
// refusals the plugin relies on (an active session is not archived, a pinned
// one loses its pin when archived, an archived one must be unarchived before
// it can run) come from DSH itself and not from a fake. Only the agent and the
// session store are stand-ins; the `workspace/session-activity` listener is
// the same rule DSH's agent registry installs (running agent -> `turn`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { archiveWhenIdle, deliverToSession } from '../src/session.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

/** A live agent whose turn the test ends by hand. */
function fakeAgent(id, cwd) {
  let finish = () => {}
  let idle = Promise.resolve()
  const agent = {
    id,
    status: 'idle',
    session: { id, header: { id, cwd, createdAt: Date.now() }, log: [] },
    followup(message) {
      agent.session.log.push({ type: 'user/message', data: message })
      if (agent.status === 'idle') {
        agent.status = 'running'
        idle = new Promise((resolve) => { finish = () => { agent.status = 'idle'; resolve() } })
      }
    },
    endTurn() { finish() },
    whenIdle: () => idle,
  }
  return agent
}

async function host(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dcj-registry-'))
  const agents = new Map()
  const root = new Context()
  class Sessions extends Service {
    constructor(ctx) { super(ctx, 'sessions') }
    get(id) { return agents.get(id)?.session }
    list() { return [...agents.values()].map(agent => agent.session) }
    async flush() { return true }
  }
  class SessionPersistence extends Service {
    constructor(ctx) { super(ctx, 'sessionPersistence') }
    async list() { return [...agents.values()].map(agent => ({ header: agent.session.header })) }
  }
  class SessionController extends Service {
    constructor(ctx) { super(ctx, 'sessionController') }
    async resolveAgent(id) {
      const agent = agents.get(id)
      return agent ? { agent } : { error: new Error(`session ${id} not found`) }
    }
  }
  root.plugin(Storage)
  root.plugin(storageJson, { root: join(dir, 'storage') })
  root.plugin(storageDomain, { backend: 'json' })
  root.plugin(Sessions)
  root.plugin(SessionPersistence)
  root.plugin(SessionController)
  root.plugin({
    name: 'turn-activity',
    apply(ctx) {
      ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
        const rest = await next()
        return agents.get(sessionId)?.status === 'running' ? [{ kind: 'turn' }, ...rest] : rest
      })
    },
  })
  root.plugin(WorkspaceRegistry)
  let registry
  for (let i = 0; i < 100 && registry === undefined; i++) {
    await settle()
    registry = root.get('workspaceRegistry')
  }
  assert.ok(registry, 'the real workspace registry started')
  t.after(async () => {
    await root.registry.get(WorkspaceRegistry)?.dispose?.()
    await rm(dir, { recursive: true, force: true })
  })
  const add = (id) => {
    const agent = fakeAgent(id, dir)
    agents.set(id, agent)
    return agent
  }
  return { ctx: root, registry, add }
}

test('the real registry archives a session only after its turn ends', async (t) => {
  const { ctx, registry, add } = await host(t)
  const agent = add('session-a')
  agent.followup({ id: 'm1', role: 'user', content: [], source: { kind: 'schedule' } })
  assert.equal(agent.status, 'running')
  // DSH refuses to archive a running session.
  await assert.rejects(registry.archiveSession('session-a'), { name: 'WorkspaceActiveSessionError' })

  const done = archiveWhenIdle(ctx, 'session-a', { retryMs: 5 })
  await settle()
  assert.equal(registry.archivedSessionIds.includes('session-a'), false, 'not archived while running')
  agent.endTurn()
  assert.deepEqual(await done, { archive: 'archived' })
  assert.deepEqual([...registry.archivedSessionIds], ['session-a'])
})

test('pinned and person-held sessions stay out of the archive', async (t) => {
  const { ctx, registry, add } = await host(t)
  add('session-p')
  await registry.pinSession('session-p')
  assert.deepEqual(await archiveWhenIdle(ctx, 'session-p'), { archive: 'kept', note: 'pinned' })

  const held = add('session-h')
  held.session.log.push({ type: 'user/message', data: { source: { kind: 'user' } } })
  assert.deepEqual(await archiveWhenIdle(ctx, 'session-h'), { archive: 'kept', note: 'taken over by a person' })
  assert.deepEqual([...registry.archivedSessionIds], [])
})

test('reusing an archived session unarchives it before the prompt, then it is archived again', async (t) => {
  const { ctx, registry, add } = await host(t)
  const agent = add('session-r')
  await registry.archiveSession('session-r')

  await assert.rejects(deliverToSession(ctx, { sessionId: 'session-r', text: 'x' }), /archived/)
  assert.equal(agent.session.log.length, 0)

  const sent = await deliverToSession(ctx, { sessionId: 'session-r', text: 'again', mayUnarchive: true })
  assert.deepEqual(sent, { sessionId: 'session-r', queued: false, unarchived: true })
  assert.equal(registry.archivedSessionIds.includes('session-r'), false)
  const done = archiveWhenIdle(ctx, 'session-r', { retryMs: 5 })
  agent.endTurn()
  assert.deepEqual(await done, { archive: 'archived' })
  assert.ok(registry.archivedSessionIds.includes('session-r'))
})
