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
  assert.deepEqual(await runner.tick(), { status: 'woke', sessionId: 'session-1', sessionOpenedAt: '2026-03-04T05:06:00.000Z' })
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

// Reuse and auto-archive -----------------------------------------------------

import { HistoryStore, memoryTable } from '../src/history.js'

const quiet = { info() {}, warn() {}, error() {} }

function reuseSetup(agent, { reuseImpl, settleImpl, defaults = {}, now } = {}) {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const calls = { wake: [], reuse: [], settle: [] }
  let clock = now ?? new Date('2026-03-04T05:00:00Z')
  let opened = 0
  const runner = new JobRunner({ name: 'mail', command: 'gate', agent }, {
    logger: quiet,
    history,
    defaults,
    now: () => clock,
    run: async () => okResult('new mail'),
    wake: async (request) => { calls.wake.push(request); return `session-${++opened}` },
    reuse: async (request) => {
      calls.reuse.push(request)
      return reuseImpl ? reuseImpl(request) : { queued: false }
    },
    settle: async (sessionId, options) => {
      calls.settle.push({ sessionId, options })
      return settleImpl ? settleImpl(sessionId, options) : { archive: 'archived' }
    },
  })
  return { runner, history, calls, advance: (ms) => { clock = new Date(clock.getTime() + ms) } }
}

const HOUR = 3600 * 1000
const drain = async (runner) => { while (runner.settling.size > 0) await Promise.all([...runner.settling]) }

test('agentSettings: job values win, then plugin defaults; cwd falls back to the command cwd', async () => {
  const { agentSettings } = await import('../src/job.js')
  assert.deepEqual(agentSettings({ cwd: '/cmd', agent: { prompt: 'p' } }), { cwd: '/cmd', autoArchive: false, reuseWithinHours: 0 })
  assert.deepEqual(agentSettings({ cwd: '/cmd', agent: { prompt: 'p' } }, { agentCwd: '/main', autoArchive: true, reuseWithinHours: 2 }),
    { cwd: '/main', autoArchive: true, reuseWithinHours: 2 })
  assert.deepEqual(agentSettings({ agent: { prompt: 'p', cwd: '/own', autoArchive: false, reuseWithinHours: 0 } }, { agentCwd: '/main', autoArchive: true, reuseWithinHours: 2 }),
    { cwd: '/own', autoArchive: false, reuseWithinHours: 0 })
})

test('the plugin default cwd is used for the woken session', async () => {
  const { runner, calls } = reuseSetup({ prompt: 'p' }, { defaults: { agentCwd: '/home/main' } })
  await runner.tick()
  assert.equal(calls.wake[0].cwd, '/home/main')
})

test('within the reuse window the prompt goes into the previous session; after it a new one opens', async () => {
  const { runner, history, calls, advance } = reuseSetup({ prompt: 'p', reuseWithinHours: 2 })
  const first = await runner.tick()
  assert.equal(first.sessionId, 'session-1')
  assert.equal(calls.reuse.length, 0, 'nothing to reuse on the first run')

  advance(1.5 * HOUR)
  const second = await runner.tick()
  assert.equal(second.sessionId, 'session-1')
  assert.equal(second.reused, true)
  assert.equal(second.sessionOpenedAt, first.sessionOpenedAt, 'the window counts from the first wake')
  assert.equal(calls.reuse[0].sessionId, 'session-1')
  assert.match(calls.reuse[0].text, /new mail/)
  assert.equal(calls.wake.length, 1)

  // 2.5 h after the session was opened, though only 1 h after its reuse.
  advance(1 * HOUR)
  const third = await runner.tick()
  assert.equal(third.sessionId, 'session-2')
  assert.equal(third.reused, undefined)
  assert.equal(calls.reuse.length, 1)
  const saved = history.runs('mail')
  assert.equal(saved[1].reused, true)
  assert.equal(saved[1].sessionId, 'session-1')
})

test('reuse is off with a zero window', async () => {
  const { runner, calls } = reuseSetup({ prompt: 'p' })
  await runner.tick()
  await runner.tick()
  assert.equal(calls.reuse.length, 0)
  assert.equal(calls.wake.length, 2)
})

test('a reuse that fails (gone, taken over, archived) falls back to a new session and says why', async () => {
  const { runner, history, calls, advance } = reuseSetup({ prompt: 'p', reuseWithinHours: 5 }, {
    reuseImpl: () => { throw new Error('the session is in use (taken over by a person)') },
  })
  await runner.tick()
  advance(HOUR)
  const outcome = await runner.tick()
  assert.equal(outcome.sessionId, 'session-2')
  assert.match(outcome.reuseNote, /session-1 not reused: .*taken over/)
  assert.equal(calls.wake.length, 2)
  assert.match(history.runs('mail')[0].reuseNote, /taken over/)
})

test('a busy reused session queues the prompt and the run says so', async () => {
  const { runner, history, advance } = reuseSetup({ prompt: 'p', reuseWithinHours: 5 }, {
    reuseImpl: () => ({ queued: true }),
  })
  await runner.tick()
  advance(HOUR)
  const outcome = await runner.tick()
  assert.equal(outcome.queued, true)
  assert.equal(history.runs('mail')[0].queued, true)
})

test('auto-archive marks the run pending, then saves the archive result', async () => {
  const { runner, history, calls } = reuseSetup({ prompt: 'p' }, { defaults: { autoArchive: true } })
  const outcome = await runner.tick()
  assert.equal(outcome.archive, 'pending')
  assert.equal(calls.settle[0].sessionId, 'session-1')
  await drain(runner)
  assert.equal(history.runs('mail')[0].archive, 'archived')
})

test('a kept session records why it was not archived', async () => {
  const { runner, history } = reuseSetup({ prompt: 'p', autoArchive: true }, {
    settleImpl: () => ({ archive: 'kept', note: 'pinned' }),
  })
  await runner.tick()
  await drain(runner)
  const [run] = history.runs('mail')
  assert.equal(run.archive, 'kept')
  assert.equal(run.archiveNote, 'pinned')
})

test('no archive when auto-archive is off', async () => {
  const { runner, calls } = reuseSetup({ prompt: 'p', autoArchive: false }, { defaults: { autoArchive: true } })
  const outcome = await runner.tick()
  assert.equal(outcome.archive, undefined)
  assert.equal(calls.settle.length, 0)
})

test('a later run that reuses the session takes over its archive', async () => {
  let releaseFirst
  const { runner, history, calls, advance } = reuseSetup({ prompt: 'p', autoArchive: true, reuseWithinHours: 5 }, {
    settleImpl: async (sessionId, { isLatest, lock }) => {
      // The first wait holds until the second run has delivered; later waits finish at once.
      if (calls.settle.length === 1) await new Promise(resolve => { releaseFirst = resolve })
      return lock(async () => (isLatest() ? { archive: 'archived' } : { archive: 'superseded' }))
    },
  })
  await runner.tick()
  advance(HOUR)
  const second = await runner.tick()
  assert.equal(second.reused, true)
  releaseFirst()
  await drain(runner)
  const [newer, older] = history.runs('mail')
  assert.equal(older.archive, 'superseded')
  assert.equal(newer.archive, 'archived')
})

test('an archive left pending by an unloaded copy is finished on the next start', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const id = await history.begin('mail', { trigger: 'schedule', startedAt: '2026-03-04T05:00:00Z' })
  await history.finish('mail', id, { status: 'woke', sessionId: 'session-old', archive: 'pending' })
  const settled = []
  const runner = new JobRunner({ name: 'mail', command: 'gate', agent: { prompt: 'p' } }, {
    logger: quiet, history, run: async () => okResult(), wake: async () => 'x',
    settle: async (sessionId) => { settled.push(sessionId); return { archive: 'archived' } },
  })
  await runner.resumeArchives()
  await drain(runner)
  assert.deepEqual(settled, ['session-old'])
  assert.equal(history.runs('mail')[0].archive, 'archived')
})

test('an aborted archive wait leaves the run pending', async () => {
  const controller = new AbortController()
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const runner = new JobRunner({ name: 'mail', command: 'gate', agent: { prompt: 'p', autoArchive: true } }, {
    logger: quiet, history, signal: controller.signal, run: async () => okResult('x'), wake: async () => 'session-1',
    settle: async () => { controller.abort(); return { archive: 'pending' } },
  })
  await runner.tick()
  await drain(runner)
  assert.equal(history.runs('mail')[0].archive, 'pending')
})
