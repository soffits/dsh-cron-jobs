import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronJobs } from '../src/controller.js'
import { HistoryStore, memoryTable } from '../src/history.js'

const quiet = { info() {}, warn() {}, error() {} }
const NOW = new Date('2026-11-14T03:00:00.000Z')
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
const OWNER = { via: 'notify', to: 'owner' }
const OPS = { via: 'notify', to: 'ops' }

function setup({ problems, failWake = () => false } = {}) {
  const wakes = []
  const sent = []
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const controller = new CronJobs({
    jobs: [],
    logger: quiet,
    history,
    now: () => NOW,
    watchdogMs: 0,
    events: { coalesceSeconds: 0, maxRunsPerHour: 0 },
    defaults: { deliver: OWNER, ...(problems ? { problems } : {}) },
    CronClass: class { constructor() {} nextRun() { return null } stop() {} },
    run: async ({ command }) => command === 'false'
      ? { ok: false, exitCode: 1, stdout: '', stderr: 'boom', stdoutDropped: 0, durationMs: 3 }
      : { ok: true, exitCode: 0, stdout: command === 'gate' ? '' : 'all good', stderr: '', stdoutDropped: 0, durationMs: 3 },
    wake: async (request) => {
      wakes.push(request)
      if (failWake(request)) throw new Error('this host cannot create sessions (no sessionController service)')
      return `session-${wakes.length}`
    },
    send: async (target, message) => { sent.push({ to: target.to, text: message.text }); return { status: 'sent', attempts: 1 } },
  }).start()
  return { controller, wakes, sent, history }
}

const base = { cwd: '/tmp', target: { kind: 'new' }, schedule: { cron: '0 * * * *', timeZone: 'UTC' } }
const handler = { ...base, title: 'Fixer', prompt: 'Fix what broke.', on: ['cron.problem'] }

test('without a problems setting, a failure note goes to the job\'s target as before', async () => {
  const { controller, sent } = setup()
  const job = await controller.create({ ...base, title: 'Sync', command: 'false' })
  controller.runNow(job.id)
  await tick()
  assert.deepEqual(sent, [{ to: 'owner', text: '⚠️ Sync failed (exit 1)\nboom' }])
})

test('a failed command goes to the problems channel, and with deliver false not to the owner', async () => {
  const { controller, wakes, sent } = setup({ problems: { channel: 'cron.problem', deliver: false } })
  const fixer = await controller.create(handler)
  const job = await controller.create({ ...base, title: 'Sync', command: 'false' })
  controller.runNow(job.id)
  await tick()
  assert.deepEqual(sent, [])
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].principal.id, fixer.id)
  assert.match(wakes[0].text, /Sync failed \(exit 1\)/)
  assert.match(wakes[0].text, /"kind":"command-failed"/)
  assert.match(wakes[0].text, new RegExp(`"jobId":"${job.id}"`))
})

test('ordinary output still goes to the job\'s target', async () => {
  const { controller, sent } = setup({ problems: { channel: 'cron.problem', deliver: false } })
  await controller.create(handler)
  const job = await controller.create({ ...base, title: 'Report', command: 'echo' })
  controller.runNow(job.id)
  await tick()
  assert.deepEqual(sent, [{ to: 'owner', text: 'all good' }])
})

test('a failed wake is handed to the problems channel', async () => {
  const { controller, wakes, sent } = setup({
    problems: { channel: 'cron.problem', deliver: false },
    failWake: request => request.principal.name === 'Check-in',
  })
  await controller.create(handler)
  const job = await controller.create({ ...base, title: 'Check-in', prompt: 'Check in.' })
  controller.runNow(job.id)
  await tick()
  assert.deepEqual(sent, [])
  assert.equal(wakes.length, 2)
  assert.equal(wakes[1].principal.name, 'Fixer')
  assert.match(wakes[1].text, /"kind":"wake-failed"/)
  assert.match(wakes[1].text, /could not wake the agent: this host cannot create sessions/)
})

test('a problem no job takes still reaches the job\'s target', async () => {
  const { controller, sent } = setup({ problems: { channel: 'cron.problem', deliver: false } })
  const job = await controller.create({ ...base, title: 'Sync', command: 'false' })
  controller.runNow(job.id)
  await tick()
  assert.deepEqual(sent, [{ to: 'owner', text: '⚠️ Sync failed (exit 1)\nboom' }])
})

test('problems.deliver sends failure notes to their own target', async () => {
  const { controller, sent } = setup({ problems: { deliver: OPS } })
  const gated = await controller.create({ ...base, title: 'Gate', command: 'false', prompt: 'Look.' })
  const plain = await controller.create({ ...base, title: 'Report', command: 'echo' })
  controller.runNow(gated.id)
  controller.runNow(plain.id)
  await tick()
  assert.deepEqual(sent.sort((a, b) => a.to.localeCompare(b.to)), [
    { to: 'ops', text: '⚠️ Gate failed (exit 1)\nboom' },
    { to: 'owner', text: 'all good' },
  ])
})

test('a handler that fails on a problem event does not feed itself', async () => {
  const { controller, wakes, sent } = setup({ problems: { channel: 'cron.problem', deliver: false } })
  const fixer = await controller.create({ ...base, title: 'Fixer', command: 'false', prompt: 'Fix.', on: ['cron.problem'] })
  const job = await controller.create({ ...base, title: 'Sync', command: 'false' })
  controller.runNow(job.id)
  await tick()
  await tick()
  assert.equal(wakes.length, 0)
  // Sync's note went to the fixer; the fixer's own failure, started by that event, to its target.
  assert.deepEqual(sent, [{ to: 'owner', text: '⚠️ Fixer failed (exit 1)\nboom' }])
  const runs = controller.history.runs(fixer.id)
  assert.equal(runs.length, 1)
})

test('watcher notes follow the same rule', async () => {
  const { controller, wakes, sent } = setup({ problems: { channel: 'cron.problem', deliver: false } })
  await controller.notifyProblem('⚠️ Watcher mail down', { kind: 'watcher-down', watcher: 'mail', channel: 'mail.inbox' })
  assert.deepEqual(sent, [{ to: 'owner', text: '⚠️ Watcher mail down' }])
  await controller.create(handler)
  await controller.notifyProblem('✅ Watcher mail works again.', { kind: 'watcher-up', watcher: 'mail', channel: 'mail.inbox' })
  await tick()
  assert.equal(sent.length, 1)
  assert.match(wakes[0].text, /"kind":"watcher-up"/)
})
