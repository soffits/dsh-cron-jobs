import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openAgentSession, userMessage } from '../src/session.js'

const logger = { warn() {}, info() {}, error() {} }

function fakeHost({ flushOk = true, resolveError } = {}) {
  const calls = []
  const session = { id: 'session-new' }
  const agent = {
    id: 'session-new',
    session,
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
