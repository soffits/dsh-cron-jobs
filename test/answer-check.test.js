import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkable, createAnswerChecks, openTurnAnswer } from '../src/answer-check.js'
import { runCommand } from '../src/command.js'
import { JobRunner } from '../src/job.js'

const logger = { info() {}, warn() {}, error() {} }
const prompt = id => ({ type: 'user/message', data: { id } })
const said = (...texts) => ({ type: 'assistant/message', data: { message: { content: texts.map(text => ({ type: 'text', text })) } } })
const turnStart = { type: 'turn/start', data: { turn: 1 } }
const turnEnd = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }

const result = (stdout, extra = {}) => ({ ok: true, exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false, ...extra })

function fakeAgent(log) {
  const steered = []
  return { steered, agent: { session: { id: 's1', log }, steer: message => steered.push(message) } }
}

test('openTurnAnswer reads the last text block of the open turn after the prompt', () => {
  const log = [turnStart, prompt('m1'), said('Now the board.'), said('Narration.', 'Final answer.')]
  assert.equal(openTurnAnswer(log, 'm1'), 'Final answer.')
  assert.equal(openTurnAnswer([turnStart, prompt('m1')], 'm1'), '')
  assert.equal(openTurnAnswer([...log, turnEnd, turnStart], 'm1'), undefined, 'a prompt from an ended turn is not checked again')
  assert.equal(openTurnAnswer(log, 'other'), undefined)
})

test('checkable skips empty, [SILENT] and MEDIA-only answers', () => {
  assert.equal(checkable(''), false)
  assert.equal(checkable('[SILENT]'), false)
  assert.equal(checkable('MEDIA:/tmp/a.png'), false)
  assert.equal(checkable('Hello'), true)
})

test('a check that prints something steers one rewrite request into the turn', async () => {
  const runs = []
  const lines = []
  const checks = createAnswerChecks({ run: async (options) => { runs.push(options); return result('Rewrite it in Chinese.\n') }, logger, record: async line => { lines.push(line) } })
  checks.expect('m1', { job: 'review', command: 'check', cwd: '/w' })
  const { agent, steered } = fakeAgent([turnStart, prompt('m1'), said('Hello there.')])
  await checks.onTurnStopping({ agent })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].input, 'Hello there.')
  assert.equal(runs[0].cwd, '/w')
  assert.equal(steered.length, 1)
  assert.equal(steered[0].content[0].text, 'Rewrite it in Chinese.')
  assert.equal(lines[0].status, 'steered')
  // The rewritten step closes the turn again: no second check, no loop.
  agent.session.log.push(prompt(steered[0].id), said('你好。'))
  await checks.onTurnStopping({ agent })
  assert.equal(runs.length, 1)
  assert.equal(steered.length, 1)
  assert.equal(checks.forget('m1'), 'steered')
  assert.equal(checks.size, 0)
})

test('empty output passes; a failing check is logged and does not steer', async () => {
  const lines = []
  let next = result('')
  const checks = createAnswerChecks({ run: async () => next, logger, record: async line => { lines.push(line) } })
  checks.expect('m1', { job: 'j', command: 'check' })
  const { agent, steered } = fakeAgent([turnStart, prompt('m1'), said('Fine.')])
  await checks.onTurnStopping({ agent })
  assert.equal(lines.at(-1).status, 'passed')
  checks.expect('m2', { job: 'j', command: 'check' })
  next = result('Rewrite', { ok: false, exitCode: 2 })
  await checks.onTurnStopping(fakeAgent([turnStart, prompt('m2'), said('Fine.')]))
  assert.equal(lines.at(-1).status, 'error')
  assert.equal(steered.length, 0)
})

test('turns without a watched prompt and [SILENT] answers run no check', async () => {
  let runs = 0
  const checks = createAnswerChecks({ run: async () => { runs++; return result('x') }, logger })
  await checks.onTurnStopping(fakeAgent([turnStart, prompt('m1'), said('Hi.')]))
  checks.expect('m1', { job: 'j', command: 'check' })
  await checks.onTurnStopping(fakeAgent([turnStart, prompt('other'), said('Hi.')]))
  await checks.onTurnStopping(fakeAgent([turnStart, prompt('m1'), said('Narration.', '[SILENT]')]))
  assert.equal(runs, 0)
})

test('recheck logs whether a steered rewrite fixed the answer', async () => {
  const lines = []
  const outputs = [result('Rewrite.'), result('')]
  const checks = createAnswerChecks({ run: async () => outputs.shift(), logger, record: async line => { lines.push(line) } })
  checks.expect('m1', { job: 'j', command: 'check' })
  await checks.onTurnStopping(fakeAgent([turnStart, prompt('m1'), said('Hello.')]))
  await checks.recheck('m1', '你好。', { sessionId: 's1' })
  assert.deepEqual(lines.map(line => [line.event, line.status]), [['answer-check', 'steered'], ['answer-recheck', 'fixed']])
})

test('runCommand passes input on stdin', async () => {
  const out = await runCommand({ command: 'tr a-z A-Z', input: 'hello' })
  assert.equal(out.stdout, 'HELLO')
  const ignored = await runCommand({ command: 'true', input: 'x'.repeat(1 << 20) })
  assert.equal(ignored.ok, true, 'a command that does not read stdin still passes')
})

test('a job with agent.answerCheck has its prompt watched until the answer is delivered', async () => {
  const expected = []
  const forgotten = []
  const checks = {
    expect: (id, options) => expected.push({ id, ...options }),
    forget: id => { forgotten.push(id) },
    recheck: async () => {},
  }
  const runner = new JobRunner({ name: 'review', agent: { prompt: 'look', cwd: '/w', answerCheck: 'check-lang' } }, {
    logger,
    run: async () => result(''),
    wake: async () => 'session-1',
    answer: async () => ({ text: 'Done.' }),
    send: async () => ({ status: 'sent', attempts: 1 }),
    checks,
    defaults: { deliver: { via: 'chan', to: 'x' } },
    history: { begin: async () => 'run-1', finish: async () => {}, update: async () => {}, runs: () => [] },
  })
  const outcome = await runner.tick()
  assert.equal(outcome.status, 'woke')
  assert.deepEqual(expected.map(({ job, command, cwd }) => ({ job, command, cwd })), [{ job: 'review', command: 'check-lang', cwd: '/w' }])
  await Promise.all(runner.settling)
  assert.deepEqual(forgotten, [expected[0].id])
})

test('watched prompts expire, so runs without a delivery do not pile up', async () => {
  let clock = 0
  const checks = createAnswerChecks({ run: async () => result(''), logger, now: () => new Date(clock) })
  checks.expect('old', { job: 'j', command: 'c' })
  clock = 13 * 60 * 60 * 1000
  checks.expect('new', { job: 'j', command: 'c' })
  assert.equal(checks.size, 1)
})
