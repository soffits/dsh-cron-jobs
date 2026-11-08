import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject, name } from '../index.js'
import { memoryTable } from '../src/history.js'
import { CHANNEL, ENDPOINTS } from '../src/rpc.js'

function makeCtx() {
  const effects = []
  const lines = []
  const injected = []
  const log = level => (...args) => lines.push([level, ...args])
  const logger = Object.assign(() => ({ info: log('info'), warn: log('warn'), error: log('error') }), {})
  const opened = []
  const closed = []
  const storageDomain = {
    async open(spec) {
      opened.push(spec.name)
      const table = memoryTable()
      return { table: () => table, close: async () => { closed.push(spec.name) } }
    },
  }
  const handlers = new Map()
  const ctx = {
    logger,
    storageDomain,
    effect: (fn) => { effects.push(fn()) },
    get: () => undefined,
    inject: (deps, callback) => {
      injected.push(deps)
      callback({ connection: { fetch: { register: route => handlers.set(route.path, route) } } })
    },
  }
  return { ctx, effects, lines, opened, closed, handlers, injected }
}

test('apply opens history, arms jobs, serves the page channel and cleans up', async () => {
  const { ctx, effects, lines, opened, closed, handlers, injected } = makeCtx()
  apply(ctx, Config({ jobs: [{ name: 'a', cron: '0 0 1 1 *', command: 'true' }] }))
  assert.equal(name, 'dsh-cron-jobs')
  assert.deepEqual(inject, ['storageDomain'])
  assert.equal(effects.length, 1)
  assert.deepEqual(injected, [['connection', 'webServer']])

  assert.deepEqual([...handlers.keys()], ENDPOINTS.map(endpoint => `${CHANNEL}/${endpoint}`))
  const route = handlers.get(`${CHANNEL}/list`)
  assert.deepEqual(route.methods, ['POST'])
  const handler = async endpoint => (await handlers.get(`${CHANNEL}/${endpoint}`).fetch(new Request('http://dsh.test/', { method: 'POST', body: '{}' }))).json()
  // The channel answers once the history store is open and the jobs are armed.
  let listed
  for (let i = 0; i < 50; i++) {
    listed = await handler('list')
    if (listed.ok) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.value.jobs.map(job => [job.name, job.state]), [['a', 'active']])
  assert.deepEqual(opened, ['cron_jobs'])
  assert.ok(lines.some(line => line[0] === 'info' && line[2] === 'a'))

  await effects[0]()
  assert.deepEqual(closed, ['cron_jobs'])
  const after = await handler('list')
  assert.equal(after.ok, false)
  assert.equal(after.error.code, 'cron-jobs/unavailable')
})
