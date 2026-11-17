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
