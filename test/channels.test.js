import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { channelProblem, commandChannel, findChannel } from '../src/channels.js'
import { sendMessage } from '../src/deliver.js'

const message = { to: '', text: 'Morning 早上好', files: ['/tmp/a.png'], from: { job: 'Digest', jobId: 'job-1', sessionId: 'session-9', runId: 'run-3' } }

test('the command channel hands the message to the command as JSON on stdin, in its directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-channel-'))
  try {
    const command = 'cat > got.json; printf "%s|%s" "$DSH_CRON_JOB" "$DSH_SESSION_ID" > env.txt'
    await commandChannel({ cwd: dir }).send({ ...message, to: command })
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'got.json'), 'utf8')), { ...message, to: command })
    assert.equal(await readFile(join(dir, 'env.txt'), 'utf8'), 'Digest|session-9')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a command job result carries no session, even when the host has one set', async () => {
  const seen = []
  const channel = commandChannel({ env: { PATH: '/bin', DSH_SESSION_ID: 'host' }, run: async (call) => { seen.push(call.env); return { ok: true } } })
  await channel.send({ ...message, to: 'x', from: { job: 'Backup', jobId: 'job-2' } })
  assert.equal('DSH_SESSION_ID' in seen[0], false)
  assert.equal(seen[0].DSH_CRON_JOB, 'Backup')
})

test('a failing command is an error with its exit and stderr; one that cannot run is not retried', async () => {
  const failing = commandChannel({ run: async () => ({ ok: false, exitCode: 1, stderr: 'no destination took it\n' }) })
  await assert.rejects(failing.send({ ...message, to: 'x' }), (error) => {
    assert.match(error.message, /exit 1.*no destination took it/s)
    assert.notEqual(error.retryable, false)
    return true
  })
  const missing = commandChannel({ run: async () => ({ ok: false, exitCode: 127, stderr: 'x: not found' }) })
  await assert.rejects(missing.send({ ...message, to: 'x' }), error => error.retryable === false)
  await assert.rejects(commandChannel().send({ ...message, to: '' }), error => error.retryable === false)
})

test('a failed command is tried again like any channel, and a sent one stops there', async () => {
  let calls = 0
  const run = async () => (++calls < 2 ? { ok: false, exitCode: 1, stderr: '' } : { ok: true })
  const sent = await sendMessage({
    lookup: () => commandChannel({ run }), target: { via: 'command', to: 'notify' }, message: { text: 'hi', files: [] }, from: { job: 'J' }, retryMs: [0],
  })
  assert.deepEqual(sent, { status: 'sent', attempts: 2 })
})

test('command is built in; every other name is a DSH service', () => {
  const services = { chat: { send() {} } }
  const get = name => services[name]
  assert.equal(typeof findChannel('command', { get }).send, 'function')
  assert.equal(findChannel('chat', { get }), services.chat)
  assert.equal(findChannel('mail', { get: () => { throw new Error('strict') } }), undefined)
  assert.equal(channelProblem({ via: 'command', to: 'notify-send' }, get), undefined)
  assert.match(channelProblem({ via: 'command', to: '' }, get), /needs a command/)
  assert.equal(channelProblem({ via: 'chat', to: 'x' }, get), undefined)
  assert.match(channelProblem({ via: 'mail', to: 'x' }, get), /no running service "mail"/)
})
