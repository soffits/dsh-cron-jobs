import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import {
  commandResultText, deliveryTarget, finalAnswer, messageFromText, resolveDelivery, sendMessage,
} from '../src/deliver.js'
import { JobRunner } from '../src/job.js'
import { HistoryStore, memoryTable } from '../src/history.js'
import { CronJobs } from '../src/controller.js'
import { buildAgentPrompt } from '../src/prompt.js'
import { waitForAnswer } from '../src/session.js'
import * as tools from '../tools.js'

const quiet = { info() {}, warn() {}, error() {} }
const NOTIFY = { via: 'chat', to: 'notify' }
const ok = (stdout = '', extra = {}) => ({
  ok: true, exitCode: 0, signal: null, timedOut: false, aborted: false, stdout, stderr: '', stdoutDropped: 0, durationMs: 5, ...extra,
})
const drain = async (runner) => { while (runner.settling.size > 0) await Promise.all([...runner.settling]) }

test('delivery targets: the job wins, existing-session targets default to nothing, then the plugin default', () => {
  assert.deepEqual(deliveryTarget({ via: ' chat ', to: ' notify ' }), NOTIFY)
  assert.equal(deliveryTarget({ via: '' }), undefined)
  assert.equal(deliveryTarget(false), false)
  assert.equal(deliveryTarget(undefined), undefined)
  assert.deepEqual(resolveDelivery({}, NOTIFY), NOTIFY)
  assert.deepEqual(resolveDelivery({ deliver: { via: 'mail', to: 'me' } }, NOTIFY), { via: 'mail', to: 'me' })
  assert.equal(resolveDelivery({ deliver: false }, NOTIFY), undefined)
  assert.equal(resolveDelivery({ target: { kind: 'session', sessionId: 's' } }, NOTIFY), undefined)
  assert.deepEqual(resolveDelivery({ target: { kind: 'session', sessionId: 's' }, deliver: NOTIFY }), NOTIFY)
  assert.deepEqual(resolveDelivery({ target: { kind: 'new_once' } }, NOTIFY), NOTIFY)
  assert.equal(resolveDelivery({}, {}), undefined)
})

test('MEDIA lines become files; empty text and [SILENT] send nothing', () => {
  assert.deepEqual(messageFromText('Report ready\nMEDIA:/tmp/a.pdf\n  MEDIA: `out/b.png`\nMEDIA:~/c.txt', '/srv'), {
    text: 'Report ready', files: ['/tmp/a.pdf', '/srv/out/b.png', `${homedir()}/c.txt`],
  })
  assert.equal(messageFromText('  \n'), undefined)
  assert.equal(messageFromText('[SILENT]'), undefined)
  assert.equal(messageFromText(' [SILENT] \n'), undefined)
  assert.equal(messageFromText(undefined), undefined)
  assert.deepEqual(messageFromText('[SILENT]\nMEDIA:/tmp/a.png'), { text: '', files: ['/tmp/a.png'] })
  assert.deepEqual(messageFromText('Not [SILENT] at all'), { text: 'Not [SILENT] at all', files: [] })
})

test('a failed command reports its name, how it ended and the end of stderr after any stdout', () => {
  const job = { name: 'Sync', timeoutSeconds: 60 }
  assert.equal(commandResultText(job, ok('done\n')), 'done')
  const stderr = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
  const failed = commandResultText(job, { ...ok('partial\n'), ok: false, exitCode: 2, stderr })
  assert.ok(failed.startsWith('partial\n\n⚠️ Sync failed (exit 2)\nline 6\n'))
  assert.ok(failed.endsWith('line 20'))
  assert.ok(!failed.includes('line 5\n'))
  assert.equal(commandResultText(job, { ...ok(), ok: false, exitCode: null, signal: 'SIGTERM', timedOut: true }), '⚠️ Sync timed out after 60s')
  assert.equal(commandResultText(job, { ...ok(), ok: false, exitCode: null, error: 'working directory does not exist: /x' }),
    '⚠️ Sync could not run: working directory does not exist: /x')
})

function turn(messageId, texts, reason = 'completed', turnNo = 1) {
  return [
    { type: 'turn/start', data: { turn: turnNo } },
    { type: 'user/message', data: { id: messageId, role: 'user', content: [] } },
    ...texts.map(text => ({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text }] } } })),
    ...(reason ? [{ type: 'turn/end', data: { turn: turnNo, reason: { kind: reason } } }] : []),
  ]
}

test('the final answer is the last assistant text of the turn the prompt started', () => {
  const log = [...turn('old', ['old answer']), ...turn('m1', ['working on it', 'Here you go'], 'completed', 2), ...turn('m2', ['later'], 'completed', 3)]
  assert.deepEqual(finalAnswer(log, 'm1'), { done: true, text: 'Here you go', reason: 'completed' })
  assert.deepEqual(finalAnswer(turn('m1', ['half'], null), 'm1'), { done: false })
  assert.deepEqual(finalAnswer(log, 'missing'), { done: false })
  assert.deepEqual(finalAnswer(turn('m1', [], 'error'), 'm1'), { done: true, text: '', reason: 'error' })
})

test('sendMessage calls send({ to, text, files, from }) on the named service', async () => {
  const calls = []
  const result = await sendMessage({
    lookup: name => (name === 'chat' ? { send: async request => { calls.push(request) } } : undefined),
    target: NOTIFY, message: { text: 'hi', files: ['/f'] }, from: { job: 'J', sessionId: 's1' },
  })
  assert.deepEqual(result, { status: 'sent', attempts: 1 })
  assert.deepEqual(calls, [{ to: 'notify', text: 'hi', files: ['/f'], from: { job: 'J', sessionId: 's1' } }])
})

test('sendMessage retries transient failures, stops on permanent ones, and never throws', async () => {
  let tries = 0
  const flaky = { send: async () => { if (++tries < 3) throw new Error('network down') } }
  assert.deepEqual(await sendMessage({ lookup: () => flaky, target: NOTIFY, message: { text: 'x', files: [] }, from: { job: 'J' }, retryMs: [0] }),
    { status: 'sent', attempts: 3 })

  const missing = await sendMessage({ lookup: () => undefined, target: NOTIFY, message: { text: 'x', files: [] }, from: { job: 'J' }, retryMs: [0] })
  assert.deepEqual(missing, { status: 'failed', attempts: 3, error: 'no service named chat is running' })

  let permanentTries = 0
  const bad = { send: async () => { permanentTries++; throw Object.assign(new Error('unknown topic'), { retryable: false }) } }
  assert.deepEqual(await sendMessage({ lookup: () => bad, target: NOTIFY, message: { text: 'x', files: [] }, from: { job: 'J' }, retryMs: [0] }),
    { status: 'failed', attempts: 1, error: 'unknown topic' })
  assert.equal(permanentTries, 1)

  assert.deepEqual(await sendMessage({ lookup: () => ({}), target: NOTIFY, message: { text: 'x', files: [] }, from: { job: 'J' }, retryMs: [0] }),
    { status: 'failed', attempts: 1, error: 'service chat has no send method' })
})

/** A runner with a recording channel; `answers` maps message ids to the agent's answer. */
function deliverySetup(job, { result = ok(), defaults = { deliver: NOTIFY }, answer, sendImpl } = {}) {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const sent = []
  const records = []
  const wakes = []
  const runner = new JobRunner(job, {
    logger: quiet,
    history,
    defaults,
    record: async entry => { records.push(entry) },
    now: () => new Date('2026-11-08T12:00:00Z'),
    run: async () => result,
    wake: async (request) => { wakes.push(request); return 'session-w' },
    reuse: async () => ({ queued: false }),
    send: async (target, message, from) => {
      sent.push({ target, message, from })
      return sendImpl ? sendImpl() : { status: 'sent', attempts: 1 }
    },
    answer: answer ?? (async () => ({ text: '' })),
  })
  return { runner, history, sent, records, wakes, run: () => history.runs(job.id ?? job.name)[0] }
}

test('a command job delivers its stdout, with MEDIA files resolved in its directory', async () => {
  const { runner, sent, run } = deliverySetup({ name: 'Digest', command: 'x', cwd: '/srv' }, { result: ok('Morning\nMEDIA:d.md\n') })
  const outcome = await runner.tick()
  assert.equal(outcome.delivery.status, 'sent')
  assert.deepEqual(sent, [{ target: NOTIFY, message: { text: 'Morning', files: ['/srv/d.md'] }, from: { job: 'Digest' } }])
  assert.equal(run().delivery.status, 'sent')
  assert.equal(run().delivery.via, 'chat')
})

test('a command job with empty output sends nothing, and a failure sends a note', async () => {
  const quietRun = deliverySetup({ name: 'Sync', command: 'x' }, { result: ok('\n') })
  await quietRun.runner.tick()
  assert.equal(quietRun.sent.length, 0)
  assert.equal(quietRun.run().delivery.status, 'silent')

  const failing = deliverySetup({ name: 'Sync', command: 'x' }, { result: { ...ok(), ok: false, exitCode: 1, stderr: 'boom' } })
  await failing.runner.tick()
  assert.equal(failing.sent[0].message.text, '⚠️ Sync failed (exit 1)\nboom')
})

test('a failed send is saved in the run history and the run log; the run still ends', async () => {
  const { runner, run, records } = deliverySetup({ name: 'Sync', command: 'x' }, {
    result: ok('hello'), sendImpl: () => ({ status: 'failed', attempts: 3, error: 'no service named chat is running' }),
  })
  const outcome = await runner.tick()
  assert.equal(outcome.status, 'done')
  assert.deepEqual({ status: run().delivery.status, error: run().delivery.error, attempts: run().delivery.attempts },
    { status: 'failed', error: 'no service named chat is running', attempts: 3 })
  assert.equal(records.at(-1).delivery, 'failed')
})

test('a gate that fails reports it; a gate that stays idle sends nothing; a stopped run sends nothing', async () => {
  const failing = deliverySetup({ name: 'Mail', command: 'x', agent: { prompt: 'p' } }, { result: { ...ok(), ok: false, exitCode: 3 } })
  await failing.runner.tick()
  assert.equal(failing.sent[0].message.text, '⚠️ Mail failed (exit 3)')

  const idle = deliverySetup({ name: 'Mail', command: 'x', agent: { prompt: 'p' } }, { result: ok('{"wakeAgent": false}') })
  await idle.runner.tick()
  assert.equal(idle.sent.length, 0)
  assert.equal(idle.run().delivery, undefined)

  const stopped = deliverySetup({ name: 'Sync', command: 'x' }, { result: { ...ok('partial'), ok: false, aborted: true, signal: 'SIGTERM' } })
  await stopped.runner.tick()
  assert.equal(stopped.sent.length, 0)
})

test('a woken agent\'s final answer is delivered once its turn ends, naming the job and the session', async () => {
  const asked = []
  const { runner, sent, wakes, run, records } = deliverySetup({ name: 'Check-in', agent: { prompt: 'Look around.', cwd: '/home/me' } }, {
    answer: async (sessionId, messageId) => { asked.push({ sessionId, messageId }); return { text: 'Hello Livia\nMEDIA:pic.png', reason: 'completed' } },
  })
  const outcome = await runner.tick()
  assert.equal(outcome.delivery.status, 'pending')
  assert.ok(wakes[0].messageId)
  assert.match(wakes[0].text, /Your final answer is delivered to notify through chat/)
  assert.deepEqual(asked, [{ sessionId: 'session-w', messageId: wakes[0].messageId }])
  await drain(runner)
  assert.deepEqual(sent, [{ target: NOTIFY, message: { text: 'Hello Livia', files: ['/home/me/pic.png'] }, from: { job: 'Check-in', sessionId: 'session-w' } }])
  assert.equal(run().delivery.status, 'sent')
  assert.equal(records.at(-1).event, 'delivery')
})

test('an empty or [SILENT] answer sends nothing; a missing answer is recorded as failed', async () => {
  for (const text of ['', '[SILENT]']) {
    const { runner, sent, run } = deliverySetup({ name: 'Dream', agent: { prompt: 'p' } }, { answer: async () => ({ text, reason: 'completed' }) })
    await runner.tick()
    await drain(runner)
    assert.equal(sent.length, 0)
    assert.equal(run().delivery.status, 'silent')
  }
  const lost = deliverySetup({ name: 'Dream', agent: { prompt: 'p' } }, { answer: async () => ({ error: 'session not found: gone' }) })
  await lost.runner.tick()
  await drain(lost.runner)
  assert.equal(lost.run().delivery.status, 'failed')
  assert.equal(lost.run().delivery.error, 'session not found: gone')
})

test('jobs that post into an existing session, or turn delivery off, deliver nothing', async () => {
  const own = deliverySetup({ name: 'Remind', agent: { prompt: 'p' }, target: { kind: 'session', sessionId: 'session-chat' } })
  const outcome = await own.runner.tick()
  assert.equal(outcome.delivery, undefined)
  assert.doesNotMatch(own.wakes.length ? own.wakes[0].text : '', /final answer/)

  const off = deliverySetup({ name: 'Dream', agent: { prompt: 'p' }, deliver: false })
  assert.equal((await off.runner.tick()).delivery, undefined)

  const none = deliverySetup({ name: 'Sync', command: 'x' }, { defaults: {}, result: ok('hi') })
  assert.equal((await none.runner.tick()).delivery, undefined)
})

test('a delivery left pending by an unloaded copy is finished on the next start', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const id = await history.begin('Check-in', { trigger: 'schedule', startedAt: '2026-11-08T11:00:00Z' })
  await history.finish('Check-in', id, { status: 'woke', sessionId: 'session-old', delivery: { status: 'pending', via: 'chat', to: 'notify', messageId: 'm-old' } })
  const sent = []
  const controller = new CronJobs({
    jobs: [{ name: 'Check-in', cron: '0 * * * *', agent: { prompt: 'p' } }],
    logger: quiet,
    history,
    run: async () => ok(),
    wake: async () => 'session-x',
    send: async (target, message, from) => { sent.push({ target, message, from }); return { status: 'sent', attempts: 1 } },
    answer: async (sessionId, messageId) => ({ text: `answer to ${messageId} in ${sessionId}` }),
    CronClass: class { nextRun() { return null } stop() {} },
  }).start()
  await drain(controller.entries.get('Check-in').runner)
  assert.deepEqual(sent, [{ target: NOTIFY, message: { text: 'answer to m-old in session-old', files: [] }, from: { job: 'Check-in', sessionId: 'session-old' } }])
  assert.equal(history.runs('Check-in')[0].delivery.status, 'sent')
})

test('waitForAnswer waits for the turn the prompt started, across idles', async () => {
  const log = [...turn('m1', ['still going'], null)]
  let idles = 0
  const agent = {
    session: { log },
    whenIdle: async () => {
      idles++
      if (idles === 2) log.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done' }] } } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    },
  }
  const ctx = { get: name => (name === 'sessionController' ? { resolveAgent: async () => ({ agent }) } : undefined) }
  assert.deepEqual(await waitForAnswer(ctx, 'session-1', 'm1', { retryMs: 0 }), { text: 'Done', reason: 'completed' })
  assert.equal(idles, 2)
  assert.deepEqual(await waitForAnswer(ctx, 'session-1', 'never', { retryMs: 0, attempts: 2 }), { error: 'the prompt never reached a finished turn' })
  const aborted = AbortSignal.abort()
  assert.deepEqual(await waitForAnswer(ctx, 'session-1', 'never', { signal: aborted }), { pending: true })
})

test('the agent prompt says where its answer goes only when it is delivered', () => {
  const base = { jobName: 'J', prompt: 'p', firedAt: '2026-11-08 07:00' }
  assert.doesNotMatch(buildAgentPrompt(base), /delivered/)
  assert.match(buildAgentPrompt({ ...base, delivery: NOTIFY }), /delivered to notify through chat; MEDIA:<path> lines .* exactly \[SILENT\] sends nothing/)
})

test('the tools set, show and reset a job\'s delivery target', async () => {
  const controller = new CronJobs({
    jobs: [],
    logger: quiet,
    history: new HistoryStore({ table: memoryTable(), logger: quiet }),
    now: () => new Date('2026-11-08T12:00:00Z'),
    run: async () => ok(),
    wake: async () => 'session-new',
    send: async () => ({ status: 'sent', attempts: 1 }),
    defaults: { deliver: NOTIFY },
    CronClass: class { nextRun() { return null } stop() {} },
  }).start()
  const ctx = { get: name => (name === 'mail' ? { send: async () => {} } : name === 'chat' ? { send: async () => {} } : undefined) }
  const defs = Object.fromEntries(tools.createTools({ getJobs: () => controller, ctx }).map(d => [d.name.replace('cron_job_', ''), d]))
  const agent = { session: { id: 'session-chat', header: { cwd: '/home/me' } }, options: {} }
  const call = (name, args) => defs[name].execute(args, { agent })

  const plain = await call('create', { title: 'A', prompt: 'p', cron: '0 9 * * *', timeZone: 'UTC' })
  assert.equal(plain.deliver, 'chat:notify')
  assert.deepEqual(controller.get(plain.id).deliver, { via: 'chat', to: 'notify', source: 'default' })

  const here = await call('create', { title: 'B', prompt: 'p', cron: '0 9 * * *', timeZone: 'UTC', target: 'this_session' })
  assert.equal(here.deliver, 'none')
  assert.equal(controller.get(here.id).deliver.source, 'session')

  const mailed = await call('create', { title: 'C', prompt: 'p', cron: '0 9 * * *', timeZone: 'UTC', deliver: 'mail:me@example.com' })
  assert.equal(mailed.deliver, 'mail:me@example.com')
  assert.deepEqual(controller.store.get(mailed.id).deliver, { via: 'mail', to: 'me@example.com' })

  const off = await call('edit', { id: mailed.id, action: 'update', deliver: 'none' })
  assert.equal(off.deliver, 'none')
  assert.equal(controller.store.get(mailed.id).deliver, false)
  const back = await call('edit', { id: mailed.id, action: 'update', deliver: '' })
  assert.equal(back.deliver, 'chat:notify')
  assert.equal(controller.store.get(mailed.id).deliver, undefined)

  const typo = await call('create', { title: 'D', prompt: 'p', cron: '0 9 * * *', timeZone: 'UTC', deliver: 'chta:notify' })
  assert.equal(typo.code, 'invalid_deliver')
  const garbage = await call('create', { title: 'D', prompt: 'p', cron: '0 9 * * *', timeZone: 'UTC', deliver: ':notify' })
  assert.equal(garbage.code, 'invalid_deliver')
})

test('the final answer follows a fallback model continuation into the next turn', () => {
  const stopped = turn('m1', ['partial'], null)
  stopped.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'dsh-fallback-models: a/x failed (SERVER); continuing on b/y' } } } })
  assert.deepEqual(finalAnswer(stopped, 'm1'), { done: false })
  const log = [...stopped, ...turn('notice', ['Done on the fallback'], 'completed', 2)]
  assert.deepEqual(finalAnswer(log, 'm1'), { done: true, text: 'Done on the fallback', reason: 'completed' })
  // Any other stop still ends the answer.
  const user = [...turn('m1', ['partial'], null), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }]
  assert.deepEqual(finalAnswer(user, 'm1'), { done: true, text: 'partial', reason: 'aborted' })
})
