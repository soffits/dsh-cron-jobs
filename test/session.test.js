import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveWhenIdle, deliverToSession, openAgentSession, userHold, userMessage } from '../src/session.js'

const logger = { warn() {}, info() {}, error() {} }

function fakeHost({ flushOk = true, resolveError, modelError } = {}) {
  const calls = []
  const session = { id: 'session-new' }
  const agent = {
    id: 'session-new',
    session,
    model: { select(selection) { calls.push(['selectModel', selection]) } },
    followup(message) { calls.push(['followup', message]) },
  }
  const services = {
    sessionController: {
      async create(request) { calls.push(['create', request]); return { sessionId: 'session-new' } },
      async resolveAgent(id) {
        calls.push(['resolveAgent', id])
        return resolveError ? { error: resolveError } : { agent }
      },
    },
    sessions: { async flush(s) { calls.push(['flush', s]); return flushOk } },
    agents: { withoutInitiator(fn) { calls.push(['withoutInitiator']); return fn() } },
    workspaceRegistry: {
      async resolveByPath(path) {
        calls.push(['resolveByPath', path])
        return { async attachSession(id) { calls.push(['attachSession', id]) } }
      },
    },
    sessionTitle: { rename(s, title) { calls.push(['rename', s, title]) } },
    llm: {
      async resolveCallConfig(config) {
        calls.push(['checkModel', config])
        if (modelError) throw new Error(modelError)
        return config
      },
    },
  }
  return { ctx: { get: key => services[key] }, calls, session }
}

test('creates, names, and prompts a new session in order', async () => {
  const { ctx, calls, session } = fakeHost()
  const id = await openAgentSession(ctx, { text: 'hello', title: 'job · now', agentPreset: 'p', cwd: '/w' }, logger)
  assert.equal(id, 'session-new')
  assert.deepEqual(calls.map(call => call[0]), [
    'withoutInitiator', 'create', 'resolveAgent', 'resolveByPath', 'attachSession', 'rename', 'followup', 'flush',
  ])
  assert.deepEqual(calls[1][1], { cwd: '/w', agentPreset: 'p' })
  assert.deepEqual(calls[5].slice(1), [session, 'job · now'])
  const message = calls[6][1]
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(message.source, { kind: 'schedule' })
})

test('omits cwd and preset when not given', async () => {
  const { ctx, calls } = fakeHost()
  await openAgentSession(ctx, { text: 't', title: 'x' }, logger)
  assert.deepEqual(calls.find(call => call[0] === 'create')[1], {})
  assert.equal(calls.some(call => call[0] === 'resolveByPath'), false)
})

test('a requested model is checked first and set on the new session before the prompt', async () => {
  const { ctx, calls } = fakeHost()
  const model = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }
  await openAgentSession(ctx, { text: 't', title: 'x', model }, logger)
  assert.deepEqual(calls.map(call => call[0]), [
    'withoutInitiator', 'checkModel', 'create', 'resolveAgent', 'selectModel', 'rename', 'followup', 'flush',
  ])
  assert.deepEqual(calls[1][1], model)
  assert.deepEqual(calls[4][1], model)
  // The model is not a session-create field.
  assert.deepEqual(calls[2][1], {})
})

test('no model selection without a requested model', async () => {
  const { ctx, calls } = fakeHost()
  await openAgentSession(ctx, { text: 't', title: 'x' }, logger)
  assert.equal(calls.some(call => call[0] === 'selectModel' || call[0] === 'checkModel'), false)
})

test('an unavailable model fails before any session is created', async () => {
  const { ctx, calls } = fakeHost({ modelError: 'unknown provider' })
  await assert.rejects(
    openAgentSession(ctx, { text: 't', title: 'x', model: { provider: 'nope', model: 'm' } }, logger),
    /model nope\/m is not available: unknown provider/,
  )
  assert.equal(calls.some(call => call[0] === 'create'), false)
})

test('fails clearly without a session controller', async () => {
  await assert.rejects(openAgentSession({ get: () => undefined }, { text: 't', title: 'x' }, logger), /cannot create sessions/)
})

test('rejects when the agent cannot be resolved or the message is not stored', async () => {
  const resolveError = new Error('session/not-found')
  await assert.rejects(openAgentSession(fakeHost({ resolveError }).ctx, { text: 't', title: 'x' }, logger), /not-found/)
  await assert.rejects(openAgentSession(fakeHost({ flushOk: false }).ctx, { text: 't', title: 'x' }, logger), /did not acknowledge/)
})

test('messages are frozen and get fresh ids', () => {
  const a = userMessage('a')
  const b = userMessage('a')
  assert.notEqual(a.id, b.id)
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.content[0]))
})

function existingHost({ status = 'idle', archived = [], pinned = [], log = [], resolveError, whenIdle, archiveImpl } = {}) {
  const calls = []
  const session = { id: 'session-old', log }
  const agent = {
    status,
    session,
    followup(message) { calls.push(['followup', message]) },
    whenIdle: whenIdle ?? (async () => { calls.push(['whenIdle']) }),
  }
  const registry = {
    archivedSessionIds: [...archived],
    pinnedSessionIds: [...pinned],
    async unarchiveSession(id) { calls.push(['unarchive', id]); this.archivedSessionIds = this.archivedSessionIds.filter(x => x !== id) },
    async archiveSession(id) {
      calls.push(['archive', id])
      if (archiveImpl) return archiveImpl(id)
      this.archivedSessionIds.push(id)
    },
  }
  const services = {
    sessionController: { async resolveAgent(id) { calls.push(['resolveAgent', id]); return resolveError ? { error: resolveError } : { agent } } },
    sessions: { async flush() { calls.push(['flush']); return true } },
    workspaceRegistry: registry,
  }
  return { ctx: { get: key => services[key] }, calls, registry }
}

test('deliverToSession queues into a busy session and reports it', async () => {
  const idle = existingHost()
  assert.deepEqual(await deliverToSession(idle.ctx, { sessionId: 'session-old', text: 't' }), { sessionId: 'session-old', queued: false, unarchived: false })
  const busy = existingHost({ status: 'running' })
  assert.deepEqual(await deliverToSession(busy.ctx, { sessionId: 'session-old', text: 't' }), { sessionId: 'session-old', queued: true, unarchived: false })
  assert.deepEqual(busy.calls.map(c => c[0]), ['resolveAgent', 'followup', 'flush'])
  assert.equal(busy.calls[1][1].source.kind, 'schedule')
})

test('deliverToSession refuses gone, archived (without leave), pinned and taken-over sessions', async () => {
  await assert.rejects(deliverToSession(existingHost({ resolveError: new Error('session/not-found') }).ctx, { sessionId: 'session-old', text: 't' }), /not-found/)
  await assert.rejects(deliverToSession(existingHost({ archived: ['session-old'] }).ctx, { sessionId: 'session-old', text: 't' }), /archived/)
  await assert.rejects(deliverToSession(existingHost({ pinned: ['session-old'] }).ctx, { sessionId: 'session-old', text: 't' }), /pinned/)
  const log = [{ type: 'user/message', data: { source: { kind: 'user' } } }]
  const held = existingHost({ log })
  await assert.rejects(deliverToSession(held.ctx, { sessionId: 'session-old', text: 't' }), /taken over by a person/)
  assert.equal(held.calls.some(c => c[0] === 'followup'), false)
})

test('deliverToSession unarchives first when allowed', async () => {
  const { ctx, calls } = existingHost({ archived: ['session-old'] })
  const sent = await deliverToSession(ctx, { sessionId: 'session-old', text: 't', mayUnarchive: true })
  assert.equal(sent.unarchived, true)
  assert.deepEqual(calls.map(c => c[0]), ['resolveAgent', 'unarchive', 'followup', 'flush'])
})

test('userHold ignores machine messages and this plugin\'s own prompts', () => {
  const ctx = { get: () => undefined }
  const log = [
    { type: 'user/message', data: { source: { kind: 'schedule' } } },
    { type: 'user/message', data: { source: { kind: 'runtime-context' } } },
    { type: 'user/message', data: { source: { kind: 'subagent-settled' } } },
    { type: 'assistant/message', data: {} },
  ]
  assert.equal(userHold(ctx, 's', { log }), undefined)
  assert.equal(userHold(ctx, 's', { log: [...log, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r' } } }] }), 'taken over by a person')
})

test('archiveWhenIdle waits for the turn, and still archives after a failed turn', async () => {
  const ok = existingHost()
  assert.deepEqual(await archiveWhenIdle(ok.ctx, 'session-old'), { archive: 'archived' })
  assert.deepEqual(ok.calls.map(c => c[0]), ['resolveAgent', 'whenIdle', 'archive'])
  const failed = existingHost({ whenIdle: async () => { throw new Error('turn failed') } })
  assert.deepEqual(await archiveWhenIdle(failed.ctx, 'session-old'), { archive: 'archived' })
})

test('archiveWhenIdle retries while DSH reports activity, then gives up', async () => {
  let refusals = 2
  const active = () => Object.assign(new Error('active'), { name: 'WorkspaceActiveSessionError' })
  const retry = existingHost({ archiveImpl: () => { if (refusals-- > 0) throw active() } })
  assert.deepEqual(await archiveWhenIdle(retry.ctx, 'session-old', { retryMs: 1 }), { archive: 'archived' })
  assert.equal(retry.calls.filter(c => c[0] === 'archive').length, 3)
  const stuck = existingHost({ archiveImpl: () => { throw active() } })
  const result = await archiveWhenIdle(stuck.ctx, 'session-old', { retryMs: 1, attempts: 3 })
  assert.equal(result.archive, 'kept')
  assert.match(result.note, /not archived: active/)
})

test('archiveWhenIdle: superseded, unloaded, gone, and no registry', async () => {
  assert.deepEqual(await archiveWhenIdle(existingHost().ctx, 'session-old', { isLatest: () => false }), { archive: 'superseded' })
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await archiveWhenIdle(existingHost().ctx, 'session-old', { signal: controller.signal }), { archive: 'pending' })
  const gone = await archiveWhenIdle(existingHost({ resolveError: new Error('nope') }).ctx, 'session-old')
  assert.equal(gone.archive, 'kept')
  assert.equal((await archiveWhenIdle({ get: () => undefined }, 's', { serviceWaitMs: 0 })).archive, 'kept')
})

test('archiveWhenIdle waits for services that register after the plugin starts', async () => {
  const host = existingHost()
  let ready = false
  setTimeout(() => { ready = true }, 30)
  const ctx = { get: name => (ready ? host.ctx.get(name) : undefined) }
  assert.deepEqual(await archiveWhenIdle(ctx, 'session-old', { serviceWaitMs: 2000 }), { archive: 'archived' })
})
