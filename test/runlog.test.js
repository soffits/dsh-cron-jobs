import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunLog } from '../src/runlog.js'
import { JobRunner } from '../src/job.js'

const quietLogger = () => {
  const warnings = []
  return { warnings, info() {}, warn: (...args) => warnings.push(args), error() {} }
}

const okResult = (stdout = '') => ({
  ok: true, exitCode: 0, signal: null, timedOut: false, aborted: false,
  stdout, stderr: '', stdoutDropped: 0, durationMs: 12,
})

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-runlog-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

const readLines = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))

test('no path records nothing and does not throw', async () => {
  const record = createRunLog(undefined, quietLogger())
  await record({ job: 'x' })
})

test('appends one JSON line per entry, creating the directory', async () => {
  await withDir(async dir => {
    const path = join(dir, 'nested', 'runs.jsonl')
    const record = createRunLog(path, quietLogger())
    await record({ job: 'a', event: 'start' })
    await record({ job: 'a', event: 'end' })
    assert.deepEqual(await readLines(path), [{ job: 'a', event: 'start' }, { job: 'a', event: 'end' }])
  })
})

test('a write failure is logged, not thrown', async () => {
  await withDir(async dir => {
    const blocker = join(dir, 'file')
    await writeFile(blocker, '')
    const logger = quietLogger()
    await createRunLog(join(blocker, 'runs.jsonl'), logger)({ job: 'a' })
    assert.equal(logger.warnings.length, 1)
  })
})

test('a job run writes a start and an end record with its outcome', async () => {
  await withDir(async dir => {
    const path = join(dir, 'runs.jsonl')
    const runner = new JobRunner({ name: 'brief', command: 'x', timeoutSeconds: 5, agent: {} }, {
      logger: quietLogger(),
      now: () => new Date('2026-11-06T11:30:00Z'),
      run: async () => ({ ...okResult('out'), ok: false, exitCode: 1, stderr: 'boom' }),
      wake: async () => 'unused',
      record: createRunLog(path, quietLogger()),
    })
    assert.deepEqual(await runner.tick(), { status: 'failed' })
    const [start, end] = await readLines(path)
    assert.deepEqual(start, { time: '2026-11-06T11:30:00.000Z', job: 'brief', event: 'start' })
    assert.equal(end.event, 'end')
    assert.equal(end.status, 'failed')
    assert.equal(end.outcome, 'exit 1')
    assert.equal(end.exitCode, 1)
    assert.equal(end.stdoutTail, 'out')
    assert.equal(end.stderrTail, 'boom')
  })
})

test('a run that throws still gets an end record with the error', async () => {
  const entries = []
  const runner = new JobRunner({ name: 'j', command: 'x', agent: {} }, {
    logger: quietLogger(),
    run: async () => { throw new Error('spawn failed') },
    wake: async () => 'unused',
    record: async entry => { entries.push(entry) },
  })
  await assert.rejects(runner.tick(), /spawn failed/)
  assert.deepEqual(entries.map(e => e.event), ['start', 'end'])
  assert.equal(entries[1].error, 'spawn failed')
  assert.equal(runner.running, false)
})

test('a woken gated run records the session id, a skipped tick records skipped', async () => {
  const entries = []
  let release
  const runner = new JobRunner({ name: 'g', command: 'x', agent: { prompt: 'look' } }, {
    logger: quietLogger(),
    run: () => new Promise(resolve => { release = () => resolve(okResult('news\n')) }),
    wake: async () => 'session-9',
    record: async entry => { entries.push(entry) },
  })
  const first = runner.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await runner.tick(), { status: 'skipped' })
  release()
  assert.deepEqual(await first, { status: 'woke', sessionId: 'session-9' })
  assert.deepEqual(entries.map(e => e.event), ['start', 'skipped', 'end'])
  assert.equal(entries[2].sessionId, 'session-9')
})
