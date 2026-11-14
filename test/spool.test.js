import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createEventSpool, enqueueEvent, waitForEventResult } from '../src/spool.js'

const run = promisify(execFile)
const BIN = new URL('../bin/dsh-cron-event.js', import.meta.url).pathname

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'cron-events-'))
}

test('events wait in the inbox, are taken in order, and stay until released', async () => {
  const dir = await tempDir()
  await enqueueEvent({ channel: 'a', data: { n: 1 } }, { dir })
  await enqueueEvent({ channel: 'b', text: 'two' }, { dir })
  const seen = []
  const acks = []
  const spool = createEventSpool({ dir, onError: assert.fail, handle: (input, ack) => { seen.push(input); acks.push(ack); return { matched: ['job'] } } })
  await spool.start()
  assert.deepEqual(seen.map(e => e.channel), ['a', 'b'])
  assert.ok(seen[0].at)
  let names = await readdir(dir)
  assert.equal(names.filter(n => n.endsWith('.processing')).length, 2)
  acks[0]()
  await new Promise(resolve => setTimeout(resolve, 20))
  names = await readdir(dir)
  assert.equal(names.filter(n => n.endsWith('.processing')).length, 1)
  // Unreleased at a restart: read again.
  await spool.stop()
  const again = []
  const next = createEventSpool({ dir, onError: assert.fail, handle: (input, ack) => { again.push(input.channel); ack(); return { matched: [] } } })
  await next.start()
  assert.deepEqual(again, ['b'])
  await next.stop()
  await rm(dir, { recursive: true })
})

test('a waiting sender gets the matched jobs; a malformed event is refused and removed', async () => {
  const dir = await tempDir()
  const spool = createEventSpool({ dir, intervalMs: 50, onError: assert.fail, handle: (input, ack) => {
    if (input.channel === 'bad') throw new Error('not a channel')
    ack()
    return { matched: ['job-1'] }
  } })
  await spool.start()
  const ok = await enqueueEvent({ channel: 'good' }, { dir, wait: true })
  assert.deepEqual(await waitForEventResult(ok, { dir, timeoutMs: 2000 }), { ok: true, matched: ['job-1'] })
  const bad = await enqueueEvent({ channel: 'bad' }, { dir, wait: true })
  assert.deepEqual(await waitForEventResult(bad, { dir, timeoutMs: 2000 }), { ok: false, error: 'not a channel' })
  await spool.stop()
  assert.deepEqual(await readdir(dir), [])
  await rm(dir, { recursive: true })
})

test('an event the stopping scheduler cannot take goes back in line', async () => {
  const dir = await tempDir()
  await enqueueEvent({ channel: 'a' }, { dir })
  const spool = createEventSpool({ dir, onError: assert.fail, handle: () => { throw Object.assign(new Error('stopping'), { code: 'unavailable' }) } })
  await spool.start()
  await spool.stop()
  const names = await readdir(dir)
  assert.equal(names.length, 1)
  assert.ok(names[0].endsWith('.json'))
  await rm(dir, { recursive: true })
})

test('dsh-cron-event writes an event and reports what DSH did with it', async () => {
  const home = await tempDir()
  const dir = join(home, 'cron-jobs', 'events')
  const env = { ...process.env, DSH_HOME: home, DSH_CRON_EVENTS_DIR: '' }
  const queued = await run(process.execPath, [BIN, 'ci.run.7', '--data', '{"conclusion":"success"}', '--id', 'run-7', '--no-wait'], { env })
  assert.match(queued.stdout, /"queued"/)
  const [file] = await readdir(dir)
  await rename(join(dir, file), join(dir, 'kept.json'))
  const taken = []
  const spool = createEventSpool({ dir, intervalMs: 50, onError: assert.fail, handle: (input, ack) => { taken.push(input); ack(); return { matched: ['job-ci'] } } })
  await spool.start()
  assert.deepEqual(taken[0].data, { conclusion: 'success' })
  assert.equal(taken[0].key, 'run-7')
  assert.equal(taken[0].source, 'dsh-cron-event')
  const waited = await run(process.execPath, [BIN, 'ci.run.8', '--text', 'done'], { env })
  assert.deepEqual(JSON.parse(waited.stdout), { matched: ['job-ci'] })
  assert.equal(taken[1].text, 'done')
  await assert.rejects(run(process.execPath, [BIN, 'bad channel'], { env }), error => error.code === 2)
  await assert.rejects(run(process.execPath, [BIN, 'a', '--data', '{nope'], { env }), error => error.code === 2)
  await spool.stop()
  await rm(home, { recursive: true })
})
