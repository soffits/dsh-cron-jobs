import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createEventSpool } from '../src/spool.js'
import { handleRequest, REQUEST_MAX_AGE_MS } from '../src/requests.js'

const run = promisify(execFile)
const CLI = new URL('../bin/dsh-cron-apply.js', import.meta.url).pathname

test('an old request is refused, a fresh one reaches applyDeclared', async () => {
  const calls = []
  const jobs = { applyDeclared: async input => { calls.push(input); return { set: input.set } } }
  const now = () => Date.parse('2026-11-17T12:00:00Z')
  await assert.rejects(handleRequest(jobs, { type: 'declared', set: 'home', jobs: [], at: new Date(now() - REQUEST_MAX_AGE_MS - 1).toISOString() }, { now }), /expired/u)
  await assert.rejects(handleRequest(jobs, { type: 'other', at: new Date(now()).toISOString() }, { now }), /unknown request type/u)
  const done = await handleRequest(jobs, { type: 'declared', set: 'home', jobs: [], dryRun: true, at: new Date(now()).toISOString() }, { now })
  assert.deepEqual(done, { result: { set: 'home' } })
  assert.deepEqual([calls[0].dryRun, calls[0].prune], [true, true])
})

test('a release request reaches releaseDeclared, and expires like any other', async () => {
  const calls = []
  const jobs = { releaseDeclared: async input => { calls.push(input); return { set: input.set, release: [] } } }
  const now = () => Date.parse('2026-11-17T12:00:00Z')
  await assert.rejects(handleRequest(jobs, { type: 'release', set: 'home', at: new Date(now() - REQUEST_MAX_AGE_MS - 1).toISOString() }, { now }), /expired/u)
  const done = await handleRequest(jobs, { type: 'release', set: 'home', dryRun: true, at: new Date(now()).toISOString() }, { now })
  assert.deepEqual(done, { result: { set: 'home', release: [] } })
  assert.deepEqual(calls, [{ set: 'home', dryRun: true }])
})

test('dsh-cron-apply sends the set and prints the result; with nobody listening it withdraws the request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cron-requests-'))
  const env = { ...process.env, DSH_CRON_REQUESTS_DIR: dir }
  const empty = join(dir, '..', `${Date.now()}-empty.json`)
  writeFileSync(empty, '[]')
  const lonely = await run(process.execPath, [CLI, '--set', 'home', '--file', empty, '--timeout', '0.3'], { env }).then(() => 0, error => error.code)
  assert.equal(lonely, 3)
  const releaseAlone = await run(process.execPath, [CLI, '--set', 'home', '--release', '--timeout', '0.3'], { env }).then(() => 0, error => error.code)
  assert.equal(releaseAlone, 3, 'a release needs no list and is sent like any request')
  const releaseWithList = await run(process.execPath, [CLI, '--set', 'home', '--release', '--file', empty], { env }).then(() => 0, error => error.code)
  assert.equal(releaseWithList, 2)
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.json')), [], 'nothing is left behind to apply later')

  const seen = []
  const spool = createEventSpool({ dir, intervalMs: 20, onError: assert.fail, handle: async (input, ack) => { seen.push(input); ack(); return { result: { set: input.set, unchanged: input.jobs.length } } } })
  await spool.start()
  try {
    const file = join(dir, '..', `${Date.now()}-set.json`)
    writeFileSync(file, JSON.stringify({ jobs: [{ key: 'a' }] }))
    const { stdout } = await run(process.execPath, [CLI, '--set', 'home', '--dry-run', '--file', file, '--timeout', '5'], { env })
    assert.deepEqual(JSON.parse(stdout), { set: 'home', unchanged: 1 })
    assert.equal(seen[0].dryRun, true)
    assert.equal(seen[0].type, 'declared')
  } finally {
    await spool.stop()
  }
})

test('a run request is the page\'s Run now: same call, same refusals', async () => {
  const outcomes = { a: { ok: true, startedAt: '2026-11-17T12:00:00.000Z' }, b: { ok: false, code: 'busy' }, c: { ok: false, code: 'not-found' }, d: { ok: false, code: 'stopped' } }
  const calls = []
  const jobs = { runNow: id => { calls.push(id); return outcomes[id] } }
  const now = () => Date.parse('2026-11-17T12:00:00Z')
  const at = new Date(now()).toISOString()
  assert.deepEqual(await handleRequest(jobs, { type: 'run', id: 'a', at }, { now }), { result: { id: 'a', startedAt: '2026-11-17T12:00:00.000Z' } })
  await assert.rejects(handleRequest(jobs, { type: 'run', id: 'b', at }, { now }), /already running/u)
  await assert.rejects(handleRequest(jobs, { type: 'run', id: 'c', at }, { now }), /no job with id "c"/u)
  await assert.rejects(handleRequest(jobs, { type: 'run', id: 'd', at }, { now }), error => error.code === 'unavailable', 'a stopping scheduler puts the request back')
  await assert.rejects(handleRequest(jobs, { type: 'run', at }, { now }), /give the id/u)
  await assert.rejects(handleRequest(jobs, { type: 'run', id: 'a', at: new Date(now() - REQUEST_MAX_AGE_MS - 1).toISOString() }, { now }), /expired/u)
  assert.deepEqual(calls, ['a', 'b', 'c', 'd'])
})

test('dsh-cron-run starts the run through the inbox, says when it is refused, and withdraws an untaken request', async () => {
  const RUN = new URL('../bin/dsh-cron-run.js', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'cron-requests-'))
  const env = { ...process.env, DSH_CRON_REQUESTS_DIR: dir }
  const exit = args => run(process.execPath, [RUN, ...args], { env }).then(() => 0, error => error.code)
  assert.equal(await exit([]), 2)
  assert.equal(await exit(['a', 'b']), 2)
  assert.equal(await exit(['job-1', '--timeout', '0.3']), 3)
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.json')), [], 'an untaken run is never started later')

  const running = new Set(['busy'])
  const jobs = { runNow: id => id === 'nope' ? { ok: false, code: 'not-found' } : running.has(id) ? { ok: false, code: 'busy' } : (running.add(id), { ok: true, startedAt: '2026-11-17T12:00:00.000Z' }) }
  const spool = createEventSpool({ dir, intervalMs: 20, onError: assert.fail, handle: async (input, ack) => { try { return await handleRequest(jobs, input) } finally { ack() } } })
  await spool.start()
  try {
    const { stdout } = await run(process.execPath, [RUN, 'job-1', '--timeout', '5'], { env })
    assert.deepEqual(JSON.parse(stdout), { id: 'job-1', startedAt: '2026-11-17T12:00:00.000Z' })
    const busy = await run(process.execPath, [RUN, 'job-1', '--timeout', '5'], { env }).then(() => assert.fail('a second run while one is going'), error => error)
    assert.equal(busy.code, 1)
    assert.match(busy.stderr, /already running/u)
    assert.equal(await exit(['nope', '--timeout', '5']), 1)
  } finally {
    await spool.stop()
  }
})
