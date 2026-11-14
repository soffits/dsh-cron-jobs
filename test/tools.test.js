import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../index.js'
import * as tools from '../tools.js'
import { CronJobs } from '../src/controller.js'
import { HistoryStore, memoryTable } from '../src/history.js'

const quiet = { info() {}, warn() {}, error() {} }
const NOW = new Date('2026-11-08T12:00:00.000Z')

function caller({ id = 'session-chat', cwd = '/home/me/work', preset = 'helper', depth = 0 } = {}) {
  return {
    session: { id, header: { cwd, ...(depth ? { delegationDepth: depth } : {}) } },
    options: {},
    ctx: { get: name => (name === 'agentPresets' ? { composedPreset: () => preset } : undefined) },
  }
}

function setup({ jobs = [], sessions = ['session-other'] } = {}) {
  const controller = new CronJobs({
    jobs,
    logger: quiet,
    history: new HistoryStore({ table: memoryTable(), logger: quiet }),
    now: () => NOW,
    run: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    wake: async () => 'session-new',
    CronClass: class { nextRun() { return null } stop() {} },
  }).start()
  let available = true
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: id => (sessions.includes(id) ? {} : undefined) }
      if (name === 'sessionPersistence') return { stat: async () => undefined }
      return undefined
    },
  }
  const defs = Object.fromEntries(tools.createTools({ getJobs: () => (available ? controller : undefined), ctx }).map(d => [d.name.replace('cron_job_', ''), d]))
  const call = (name, args, agent = caller()) => defs[name].execute(args, { agent })
  return { controller, defs, call, setUnavailable: () => { available = false } }
}

test('the five tools have the configured prefix and object schemas', () => {
  const names = tools.createTools({ getJobs: () => undefined }).map(d => d.name)
  assert.deepEqual(names, ['cron_job_create', 'cron_job_edit', 'cron_job_list', 'cron_job_view', 'cron_job_watch'])
  const builtInNames = tools.createTools({ prefix: 'schedule', getJobs: () => undefined }).map(d => d.name)
  assert.deepEqual(builtInNames, ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view', 'schedule_watch'])
  for (const schema of Object.values(tools.toolSchemas('cron_job'))) {
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
    for (const key of schema.required) assert.ok(schema.properties[key])
  }
})

test('create takes the caller\'s directory, preset and session for "remind me here"', async () => {
  const { call, controller } = setup()
  const job = await call('create', { title: 'Parcel', prompt: 'Did it come?', at: '2026-11-09T09:00', timeZone: 'America/Toronto', target: 'this_session' })
  assert.equal(job.state, 'active')
  assert.equal(job.target, 'session session-chat')
  assert.equal(job.preset, 'helper')
  assert.equal(job.sessionCwd, '/home/me/work')
  assert.equal(job.nextRunAt, '2026-11-09T14:00:00.000Z')
  assert.equal(job.nextRunAtLocal, '2026-11-09 09:00 America/Toronto')
  assert.equal(job.createdBy, 'session-chat')
  assert.equal(controller.get(job.id).cwd, '/home/me/work')

  const fresh = await call('create', { title: 'Report', prompt: 'Write it.', cron: '0 9 * * 1', timeZone: 'America/Toronto', cwd: '/srv' })
  assert.equal(fresh.target, 'new')
  assert.equal(fresh.sessionCwd, '/srv')

  const other = await call('create', { title: 'Ping', prompt: 'hi', at: '2026-11-09T09:00:00Z', sessionId: 'session-other' })
  assert.equal(other.target, 'session session-other')
})

test('create reports input problems as codes the model can act on', async () => {
  const { call, setUnavailable } = setup()
  assert.equal((await call('create', { prompt: 'x' })).code, 'invalid_arguments')
  assert.equal((await call('create', { title: 'x', prompt: 'x', cron: '0 9 * * *', bogus: 1 })).code, 'invalid_arguments')
  assert.equal((await call('create', { title: 'x', prompt: 'x', target: 'elsewhere', at: '2026-11-09T09:00:00Z' })).code, 'invalid_arguments')
  assert.equal((await call('create', { title: 'x', prompt: 'x', cron: '0 9 * * *' })).code, 'invalid_time_zone')
  assert.equal((await call('create', { title: 'x', prompt: 'x', at: '2020-01-01T00:00:00Z' })).code, 'not_future')
  assert.equal((await call('create', { title: 'x', prompt: 'x', at: '2026-11-09T09:00:00Z', rrule: 'x' })).code, 'invalid_rule')
  assert.equal((await call('create', { title: 'x', at: '2026-11-09T09:00:00Z' })).code, 'invalid_job')
  assert.equal((await call('create', { title: 'x', prompt: 'x', at: '2026-11-09T09:00:00Z', sessionId: 'session-gone' })).code, 'invalid_target')
  assert.equal((await call('create', { title: 'x', prompt: 'x', at: '2026-11-09T09:00:00Z', target: 'this_session' }, caller({ depth: 1 }))).code, 'invalid_target')
  setUnavailable()
  assert.equal((await call('list', {})).code, 'unavailable')
})

test('edit updates, pauses, resumes and deletes stored jobs; config jobs are read-only', async () => {
  const { call } = setup({ jobs: [{ name: 'cfg', cron: '* * * * *', command: 'true' }] })
  const job = await call('create', { title: 'Check', prompt: 'Look.', rrule: 'DTSTART;TZID=America/Toronto:20261109T100000\nRRULE:FREQ=WEEKLY;BYDAY=MO' })
  const updated = await call('edit', { id: job.id, action: 'update', title: 'Check again', command: './probe' })
  assert.equal(updated.title, 'Check again')
  assert.equal(updated.kind, 'gate')
  assert.equal((await call('edit', { id: job.id, action: 'pause' })).state, 'paused')
  assert.equal((await call('edit', { id: job.id, action: 'resume' })).state, 'active')
  assert.equal((await call('edit', { id: job.id, action: 'pause', title: 'x' })).code, 'invalid_arguments')
  assert.equal((await call('edit', { id: job.id, action: 'update' })).code, 'invalid_arguments')
  const retargeted = await call('edit', { id: job.id, action: 'update', target: 'this_session' })
  assert.equal(retargeted.target, 'session session-chat')

  assert.equal((await call('edit', { id: 'cfg', action: 'pause' })).code, 'read_only')
  assert.equal((await call('edit', { id: 'cfg', action: 'delete' })).code, 'read_only')
  assert.deepEqual(await call('edit', { id: job.id, action: 'delete' }), { id: job.id, deleted: true })
  assert.equal((await call('view', { id: job.id })).code, 'not_found')
})

test('list is brief; view shows the definition and recent runs', async () => {
  const { call, controller } = setup({ jobs: [{ name: 'cfg', cron: '* * * * *', command: 'echo hi' }] })
  const job = await call('create', { title: 'Note', prompt: 'Remember the thing.', at: '2026-11-09T09:00:00Z' })
  const { jobs } = await call('list', {})
  assert.deepEqual(jobs.map(j => [j.id, j.source]), [['cfg', 'config'], [job.id, 'tool']])
  assert.equal(jobs[1].prompt, undefined)
  assert.equal(jobs[1].schedule, 'once at 2026-11-09T09:00:00.000Z')

  controller.runNow('cfg')
  await controller.stop()
  const view = await call('view', { id: 'cfg' })
  assert.equal(view.command, 'echo hi')
  assert.equal(view.recentRuns.length, 1)
  assert.equal(view.recentRuns[0].status, 'done')
  assert.equal((await call('view', { id: job.id })).prompt, 'Remember the thing.')
})

test('in Cordis, the tools reach the scheduler through the cronJobs service', async () => {
  const registered = new Map()
  const root = new Context()
  root.provide('tools', { register: definition => registered.set(definition.name, definition) })
  root.provide('storageDomain', {
    async open() {
      const tables = { jobs: memoryTable(), tasks: memoryTable() }
      return { table: name => tables[name], close: async () => {} }
    },
  })
  await root.plugin(tools, { prefix: 'cron_job' })
  const fiber = await root.plugin(host, { jobs: [] })
  const create = registered.get('cron_job_create')
  assert.ok(create)
  let job
  for (let i = 0; i < 50; i++) {
    job = await create.execute({ title: 'Hello', prompt: 'Say hi.', at: '2099-01-01T00:00:00Z' }, { agent: caller() })
    if (job.code !== 'unavailable') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.match(job.id, /^job-/)
  const { jobs } = await registered.get('cron_job_list').execute({}, { agent: caller() })
  assert.deepEqual(jobs.map(j => j.title), ['Hello'])
  await fiber.dispose()
  assert.equal((await registered.get('cron_job_list').execute({}, { agent: caller() })).code, 'unavailable')
})

test('create and edit set, change and clear a job\'s model; list and view show it', async () => {
  const { call } = setup()
  const model = { provider: 'anthropic', model: 'claude-sonnet-4-5', reasoningEffort: 'high' }
  const job = await call('create', { title: 'Report', prompt: 'Write it.', cron: '0 9 * * 1', timeZone: 'America/Toronto', model })
  assert.deepEqual(job.model, model)
  assert.deepEqual((await call('view', { id: job.id })).model, model)
  assert.deepEqual((await call('list', {})).jobs[0].model, model)

  const changed = await call('edit', { id: job.id, action: 'update', model: { provider: 'deepseek', model: 'deepseek-chat' } })
  assert.deepEqual(changed.model, { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal((await call('edit', { id: job.id, action: 'update', model: {} })).model, undefined)
  assert.equal((await call('view', { id: job.id })).model, undefined)

  assert.equal((await call('edit', { id: job.id, action: 'update', model: { provider: 'deepseek' } })).code, 'invalid_job')
  assert.equal((await call('edit', { id: job.id, action: 'update', model: 'gpt' })).code, 'invalid_arguments')
  assert.equal((await call('create', { title: 'x', prompt: 'x', cron: '0 9 * * *', timeZone: 'UTC', model: { provider: 'a', extra: 1 } })).code, 'invalid_arguments')
  const plain = await call('create', { title: 'Plain', prompt: 'hi', at: '2026-11-09T09:00:00Z' })
  assert.equal(plain.model, undefined)
})

test('create and edit take on and once; list shows them', async () => {
  const { call } = setup()
  const job = await call('create', { title: 'Verify DSH', prompt: 'Check DSH.', on: ['dsh.started'], once: true })
  assert.equal(job.state, 'active')
  assert.deepEqual(job.on, ['dsh.started'])
  assert.equal(job.once, true)
  assert.equal(job.schedule, null)
  assert.match((await call('create', { title: 'x', prompt: 'y', on: 'dsh.started' })).message, /on must be an array/)
  assert.match((await call('create', { title: 'x', prompt: 'y', on: [1] })).message, /only strings/)
  assert.equal((await call('create', { title: 'x', prompt: 'y', on: ['bad pattern'] })).code, 'invalid_job')
  const edited = await call('edit', { id: job.id, action: 'update', on: ['dsh.started', 'ci.*'], once: false, cron: '0 */2 * * *', timeZone: 'America/Toronto' })
  assert.deepEqual(edited.on, ['dsh.started', 'ci.*'])
  assert.equal(edited.once, undefined)
  assert.equal(edited.schedule, 'cron 0 */2 * * * (America/Toronto)')
  const cleared = await call('edit', { id: job.id, action: 'update', cron: '' })
  assert.equal(cleared.schedule, null)
  const listed = (await call('list', {})).jobs.find(j => j.id === job.id)
  assert.deepEqual(listed.on, ['dsh.started', 'ci.*'])
})

test('the watch tool creates, lists and deletes stored watchers', async () => {
  const { call, controller } = setup()
  const made = await call('watch', { action: 'create', id: 'once-1', channel: 'ci.1', command: 'sleep 30', once: true })
  assert.equal(made.id, 'once-1')
  assert.equal(made.cwd, '/home/me/work')
  assert.equal(made.once, true)
  assert.equal((await call('watch', { action: 'create', id: 'once-1', channel: 'ci.1', command: 'x' })).code, 'invalid_watcher')
  assert.equal((await call('watch', { action: 'create', id: 'bad id', channel: 'ci.1', command: 'x' })).code, 'invalid_watcher')
  assert.deepEqual((await call('watch', { action: 'list' })).watchers.map(w => w.id), ['once-1'])
  assert.equal((await call('watch', { action: 'list', id: 'x' })).code, 'invalid_arguments')
  assert.deepEqual(await call('watch', { action: 'delete', id: 'once-1' }), { id: 'once-1', deleted: true })
  assert.equal((await call('watch', { action: 'delete', id: 'once-1' })).code, 'not_found')
  await controller.stop()
})
