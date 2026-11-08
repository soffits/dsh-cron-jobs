// Loads the plugin into DSH's real Cordis runtime with DSH's real Connection
// service, so the Web page's routes are tested the way DSH mounts them. A
// hand-written fake of `ctx.connection` missed that `rpc.handle` throws for
// outside plugins, which left the page with HTTP 405.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import * as plugin from '../index.js'
import { memoryTable } from '../src/history.js'
import { CHANNEL } from '../src/rpc.js'

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function host() {
  const root = new Context()
  class Credentials extends Service { constructor(ctx) { super(ctx, 'credentials') } }
  class WebServer extends Service {
    constructor(ctx) { super(ctx, 'webServer') }
    register() { return () => {} }
  }
  class StorageDomain extends Service {
    constructor(ctx) { super(ctx, 'storageDomain') }
    async open() {
      const table = memoryTable()
      return { table: () => table, close: async () => {} }
    }
  }
  root.plugin(Credentials)
  root.plugin(WebServer)
  root.plugin(StorageDomain)
  let connection
  // Same shape as DSH's client-connection plugin: it injects only credentials.
  root.plugin({
    name: 'client-connection',
    inject: ['credentials'],
    apply(ctx) { connection = new HostConnectionService(ctx, [], {}) },
  })
  await settle()
  return { root, api: connection.createSharedFetchHandler('/api') }
}

function post(endpoint, body = '{}') {
  return new Request(`http://dsh.test${CHANNEL}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

const owner = { principal: { kind: 'owner' } }

test('the page routes are mounted on the /api channel and answer the owner', async (t) => {
  const { root, api } = await host()
  const fiber = root.plugin(plugin, plugin.Config({ jobs: [{ name: 'a', cron: '0 0 1 1 *', command: 'true' }] }))
  // Dispose even when an assertion fails, so armed jobs don't keep the test alive.
  t.after(() => fiber.dispose())

  let response
  let body
  for (let i = 0; i < 50; i++) {
    response = await api.fetch(post('list'), owner)
    body = response.status === 200 ? await response.json() : undefined
    if (body?.ok) break
    await settle()
  }
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.value.jobs.map(job => job.name), ['a'])

  const runs = await (await api.fetch(post('runs', '{"name":"a"}'), owner)).json()
  assert.deepEqual(runs, { ok: true, value: { runs: [] } })
  const missing = await (await api.fetch(post('runs', '{"name":"zz"}'), owner)).json()
  assert.equal(missing.error.code, 'cron-jobs/not-found')

  const bad = await api.fetch(post('list', 'not json'), owner)
  assert.equal(bad.status, 400)

  // DSH itself keeps everyone but the owner away from exact /api routes.
  const guest = await api.fetch(post('list'), { principal: { kind: 'guest' } })
  assert.equal(guest.status, 403)

  await fiber.dispose()
  assert.equal((await api.fetch(post('list'), owner)).status, 404)
})
