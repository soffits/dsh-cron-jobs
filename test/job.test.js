import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JobRunner, agentModel, isGated } from '../src/job.js'
import { Config } from '../src/config.js'

function makeLogger() {
  const lines = []
  const record = level => (format, ...args) => {
    let i = 0
    lines.push(`${level} ${String(format).replace(/%s/g, () => String(args[i++]))}`)
  }
  return { lines, info: record('info'), warn: record('warn'), error: record('error') }
}

const okResult = (stdout = '') => ({
  ok: true, exitCode: 0, signal: null, timedOut: false, aborted: false,
  stdout, stderr: '', stdoutDropped: 0, durationMs: 12,
})

function setup(job, { result = okResult(), wakeImpl } = {}) {
  const logger = makeLogger()
  const runs = []
  const wakes = []
  const runner = new JobRunner(job, {
    logger,
    now: () => new Date('2026-03-04T05:06:00Z'),
    run: async (options) => { runs.push(options); return typeof result === 'function' ? result() : result },
    wake: wakeImpl ?? (async (request) => { wakes.push(request); return 'session-1' }),
  })
  return { runner, logger, runs, wakes }
}

test('isGated needs a non-empty agent prompt', () => {
  assert.equal(isGated({ agent: {} }), false)
  assert.equal(isGated({ agent: { prompt: '  ' } }), false)
  assert.equal(isGated({}), false)
  assert.equal(isGated({ agent: { prompt: 'look' } }), true)
})

test('a plain job runs the command and never wakes', async () => {
  const job = { name: 'backup', command: 'echo hi', cwd: '/srv', timeoutSeconds: 5, agent: {} }
  const { runner, runs, wakes, logger } = setup(job, { result: okResult('hi\n') })
  assert.deepEqual(await runner.tick(), { status: 'done' })
  assert.equal(runs.length, 1)
  assert.equal(runs[0].command, 'echo hi')
  assert.equal(runs[0].cwd, '/srv')
  assert.equal(runs[0].timeoutMs, 5000)
  assert.equal(wakes.length, 0)
  assert.ok(logger.lines.some(line => line.includes('[backup] exit 0 in 0.0s')))
  assert.ok(logger.lines.some(line => line.includes('[backup] stdout: hi')))
})

test('a failed run is logged as a warning and does not wake', async () => {
  const job = { name: 'gate', command: 'false', agent: { prompt: 'check' } }
  const { runner, wakes, logger } = setup(job, {
    result: { ...okResult('there is output'), ok: false, exitCode: 1 },
  })
  assert.deepEqual(await runner.tick(), { status: 'failed' })
  assert.equal(wakes.length, 0)
  assert.ok(logger.lines.some(line => line.startsWith('warn [gate] exit 1')))
})

test('a timed-out run is reported as such', async () => {
  const job = { name: 'slow', command: 'sleep 9', timeoutSeconds: 1 }
  const { runner, logger } = setup(job, { result: { ...okResult(), ok: false, exitCode: null, signal: 'SIGTERM', timedOut: true } })
  await runner.tick()
  assert.ok(logger.lines.some(line => line.includes('[slow] timed out after 1s')))
})

test('a gated job with empty output stays idle', async () => {
  const job = { name: 'gate', command: 'true', agent: { prompt: 'check' } }
  const { runner, wakes } = setup(job, { result: okResult('\n') })
  assert.deepEqual(await runner.tick(), { status: 'idle' })
  assert.equal(wakes.length, 0)
})

test('a gated job honours {"wakeAgent": false}', async () => {
  const job = { name: 'gate', command: 'x', agent: { prompt: 'check' } }
  const { runner, wakes } = setup(job, { result: okResult('{"wakeAgent": false}\n') })
  assert.deepEqual(await runner.tick(), { status: 'idle' })
  assert.equal(wakes.length, 0)
})

test('a gated job with output opens a session with prompt, output, title, preset and cwd', async () => {
  const job = {
    name: 'inbox', command: 'x', cwd: '/jobs', timeZone: 'America/New_York',
    agent: { prompt: 'Triage these mails.', preset: 'helper', cwd: '/work' },
  }
  const { runner, wakes } = setup(job, { result: okResult('2 new mails\n') })
  assert.deepEqual(await runner.tick(), { status: 'woke', sessionId: 'session-1' })
  assert.equal(wakes.length, 1)
  const [request] = wakes
  assert.equal(request.title, 'inbox · 2026-03-04 00:06')
  assert.equal(request.agentPreset, 'helper')
  assert.equal(request.cwd, '/work')
  assert.match(request.text, /Triage these mails\./)
  assert.match(request.text, /--- Output of the job's command \(stdout\) ---\n2 new mails\n--- End of command output ---/)
})

test('the session cwd falls back to the job cwd, and the preset is omitted when empty', async () => {
  const job = { name: 'g', command: 'x', cwd: '/jobs', agent: { prompt: 'p', preset: '', cwd: '' } }
  const { runner, wakes } = setup(job, { result: okResult('go') })
  await runner.tick()
  assert.equal(wakes[0].cwd, '/jobs')
  assert.equal('agentPreset' in wakes[0], false)
})

test('a wake failure is logged and does not throw', async () => {
  const job = { name: 'g', command: 'x', agent: { prompt: 'p' } }
  const { runner, logger } = setup(job, {
    result: okResult('go'),
    wakeImpl: async () => { throw new Error('no controller') },
  })
  assert.deepEqual(await runner.tick(), { status: 'wake-failed', error: 'no controller' })
  assert.ok(logger.lines.some(line => line === 'warn [g] could not wake agent: no controller'))
})

test('a tick during a running run is skipped, and the next one runs', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const job = { name: 'long', command: 'x' }
  const { runner, runs, logger } = setup(job, { result: () => gate.then(() => okResult()) })
  const first = runner.tick()
  assert.deepEqual(await runner.tick(), { status: 'skipped' })
  assert.ok(logger.lines.some(line => line.startsWith('warn [long] previous run still going')))
  release()
  assert.deepEqual(await first, { status: 'done' })
  assert.deepEqual(await runner.tick(), { status: 'done' })
  assert.equal(runs.length, 2)
})

test('the overlap guard is released when the runner throws', async () => {
  const job = { name: 'boom', command: 'x' }
  let calls = 0
  const { runner } = setup(job, { result: () => { calls++; throw new Error('runner bug') } })
  await assert.rejects(runner.tick(), /runner bug/)
  await assert.rejects(runner.tick(), /runner bug/)
  assert.equal(calls, 2)
})

test('agentModel needs a provider and a model; effort is optional', () => {
  assert.equal(agentModel({}), undefined)
  assert.equal(agentModel({ agent: { prompt: 'p', model: { provider: 'deepseek', model: '' } } }), undefined)
  assert.equal(agentModel({ agent: { prompt: 'p', model: { provider: ' ', model: 'm' } } }), undefined)
  assert.deepEqual(agentModel({ agent: { model: { provider: ' deepseek ', model: 'deepseek-chat', reasoningEffort: '' } } }),
    { provider: 'deepseek', model: 'deepseek-chat' })
  assert.deepEqual(agentModel({ agent: { model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } } }),
    { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
})

test('config accepts agent.model and the wake request carries it', async () => {
  const config = Config({ jobs: [{
    name: 'g', cron: '* * * * *', command: 'echo hi',
    agent: { prompt: 'look', model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' } },
  }] })
  assert.deepEqual(config.jobs[0].agent.model, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' })
  const { runner, wakes } = setup(config.jobs[0], { result: okResult('work\n') })
  assert.equal((await runner.tick()).status, 'woke')
  assert.deepEqual(wakes[0].model, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' })

  const plain = Config({ jobs: [{ name: 'p', cron: '* * * * *', command: 'echo hi', agent: { prompt: 'look' } }] })
  const second = setup(plain.jobs[0], { result: okResult('work\n') })
  await second.runner.tick()
  assert.equal('model' in second.wakes[0], false)
})

test('a saved run keeps the reason a wake failed', async () => {
  const { HistoryStore, memoryTable } = await import('../src/history.js')
  const history = new HistoryStore({ table: memoryTable(), logger: { warn() {} } })
  const runner = new JobRunner({ name: 'g', command: 'x', agent: { prompt: 'p' } }, {
    logger: { info() {}, warn() {}, error() {} },
    history,
    run: async () => okResult('go'),
    wake: async () => { throw new Error('model nope/m is not available') },
  })
  await runner.tick()
  const [run] = history.runs('g')
  assert.equal(run.status, 'wake-failed')
  assert.equal(run.error, 'model nope/m is not available')
})
