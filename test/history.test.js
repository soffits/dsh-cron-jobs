import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HistoryStore, historyDomain, memoryTable, openHistory } from '../src/history.js'

const quiet = { warn() {}, error() {}, info() {} }

test('runs are saved newest last, bounded per job, and read newest first', async () => {
  const store = new HistoryStore({ table: memoryTable(), limit: 3, logger: quiet })
  const ids = []
  for (let i = 0; i < 5; i++) {
    const id = await store.begin('job', { trigger: 'schedule', startedAt: `2026-01-0${i + 1}T00:00:00.000Z` })
    ids.push(id)
    await store.finish('job', id, { status: 'done', exitCode: 0, durationMs: 5, sessionId: undefined })
  }
  const runs = store.runs('job')
  assert.equal(runs.length, 3)
  assert.deepEqual(runs.map(run => run.id), ids.slice(2).reverse())
  assert.equal(runs[0].status, 'done')
  assert.ok(!('sessionId' in runs[0]), 'undefined fields are not stored')
  assert.equal(store.lastRun('job').id, ids[4])
  assert.deepEqual(store.runs('other'), [])
})

test('pause state is kept beside the runs', async () => {
  const store = new HistoryStore({ table: memoryTable(), logger: quiet })
  await store.begin('job', { trigger: 'manual', startedAt: '2026-01-01T00:00:00.000Z' })
  await store.setPaused('job', true, new Date('2026-01-02T00:00:00Z'))
  assert.equal(store.paused('job'), true)
  assert.equal(store.state('job').pausedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(store.runs('job').length, 1)
  await store.setPaused('job', false)
  assert.equal(store.paused('job'), false)
  assert.ok(!('pausedAt' in store.state('job')))
})

test('concurrent writes to one job are not lost', async () => {
  const store = new HistoryStore({ table: memoryTable(), logger: quiet })
  const [id] = await Promise.all([
    store.begin('job', { trigger: 'schedule', startedAt: '2026-01-01T00:00:00.000Z' }),
    store.setPaused('job', true),
  ])
  await store.finish('job', id, { status: 'failed' })
  assert.equal(store.paused('job'), true)
  assert.equal(store.runs('job')[0].status, 'failed')
})

test('a failed write is logged and does not reject', async () => {
  const warnings = []
  const table = { ...memoryTable(), put: async () => { throw new Error('disk full') } }
  const store = new HistoryStore({ table, logger: { warn: (...args) => warnings.push(args) } })
  await store.setPaused('job', true)
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][2]), /disk full/)
})

test('openHistory uses the storage domain, marks interrupted runs, and survives a restart', async () => {
  // A fake storage domain whose data outlives open/close, like the JSON backend.
  const saved = new Map()
  const opens = []
  const storageDomain = {
    async open(spec) {
      opens.push(spec)
      const table = {
        get: key => saved.get(key),
        entries: () => saved.entries(),
        put: async (key, value) => { saved.set(key, spec.tables.jobs.valueSchema.parse(value)) },
      }
      return { table: () => table, close: async () => {} }
    },
  }
  const first = await openHistory(storageDomain, { limit: 10, logger: quiet })
  assert.equal(first.durable, true)
  await first.begin('job', { trigger: 'schedule', startedAt: '2026-01-01T00:00:00.000Z' })
  await first.setPaused('job', true)
  await first.close()

  const second = await openHistory(storageDomain, { limit: 10, logger: quiet })
  assert.equal(opens[0], historyDomain)
  assert.equal(second.paused('job'), true)
  const [run] = second.runs('job')
  assert.equal(run.status, 'interrupted')
  assert.ok(run.endedAt)
})

test('openHistory retries while the domain is still open, then falls back to memory on other errors', async () => {
  let attempts = 0
  const busy = {
    async open() {
      attempts++
      if (attempts < 3) throw Object.assign(new Error('open'), { code: 'already-open' })
      return { table: () => memoryTable(), close: async () => {} }
    },
  }
  const store = await openHistory(busy, { logger: quiet })
  assert.equal(attempts, 3)
  assert.equal(store.durable, true)

  const errors = []
  const broken = { async open() { throw new Error('version-mismatch') } }
  const fallback = await openHistory(broken, { logger: { ...quiet, error: (...args) => errors.push(args) } })
  assert.equal(fallback.durable, false)
  assert.equal(errors.length, 1)
  await fallback.setPaused('job', true)
  assert.equal(fallback.paused('job'), true)
})
