import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CronJobs } from '../src/controller.js'
import { HistoryStore, memoryTable } from '../src/history.js'
import { DeclaredSetError, planDeclared } from '../src/declared.js'

const quiet = { info() {}, warn() {}, error() {} }
const NOW = new Date('2026-11-08T12:00:00.000Z')

class FakeTimer {
  constructor(schedule, options) { this.schedule = schedule; this.options = options; this.due = options.first ?? schedule.next(options.now()) }
  nextRun() { return this.due ?? null }
  pause() {}
  resume() {}
  stop() {}
}

function setup() {
  const records = []
  const controller = new CronJobs({
    jobs: [],
    logger: quiet,
    history: new HistoryStore({ table: memoryTable(), logger: quiet }),
    now: () => NOW,
    TimerClass: FakeTimer,
    CronClass: class { constructor() {} nextRun() { return null } stop() {} },
    record: async entry => { records.push(entry) },
    run: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', stdoutDropped: 0, durationMs: 1 }),
    wake: async () => 'session-1',
    watchdogMs: 0,
    sweepMs: 0,
  }).start()
  return { controller, records }
}

const review = { key: 'plan-review', title: 'Plan review', prompt: 'Review the plan.', cron: '0 9 * * *', timeZone: 'Europe/Berlin', deliver: 'telegramTopics:42', model: { provider: 'p', model: 'm' } }
const backup = { key: 'backup', title: 'Backup', command: 'backup.sh', cron: '27 * * * *', timeZone: 'UTC', deliver: 'none', timeoutSeconds: 600 }

test('a declared set is created, then a second apply changes nothing', async () => {
  const { controller, records } = setup()
  const first = await controller.applyDeclared({ set: 'home', jobs: [review, backup] })
  assert.equal(first.create.length, 2)
  assert.ok(first.create.every(item => item.id.startsWith('job-')))
  const stored = controller.store.all()
  assert.deepEqual(stored.map(job => job.declared), [{ set: 'home', key: 'plan-review' }, { set: 'home', key: 'backup' }])
  assert.equal(stored[1].timeoutSeconds, 600)
  assert.equal(stored[1].deliver, false)
  assert.deepEqual(stored[0].deliver, { via: 'telegramTopics', to: '42' })
  const again = await controller.applyDeclared({ set: 'home', jobs: [review, backup] })
  assert.deepEqual([again.create.length, again.update.length, again.remove.length, again.unchanged], [0, 0, 0, 2])
  assert.equal(records.filter(entry => entry.event === 'declared').length, 2)
  assert.deepEqual(controller.list().find(job => job.name === 'Backup').declared, { set: 'home', key: 'backup' })
})

test('releasing a set keeps every job, its history and its pause state, and later applies no longer see them', async () => {
  const { controller, records } = setup()
  await controller.applyDeclared({ set: 'home', jobs: [review, backup] })
  await controller.applyDeclared({ set: 'other', jobs: [{ ...backup, key: 'theirs' }] })
  const [first] = controller.store.all()
  await controller.setPaused(first.id, true)
  const plan = await controller.releaseDeclared({ set: 'home', dryRun: true })
  assert.deepEqual(plan.release.map(item => item.key), ['plan-review', 'backup'])
  assert.ok(controller.store.all().slice(0, 2).every(job => job.declared), 'a dry run writes nothing')
  const done = await controller.releaseDeclared({ set: 'home' })
  assert.equal(done.release.length, 2)
  const stored = controller.store.all()
  assert.equal(stored.length, 3)
  assert.deepEqual(stored.map(job => job.declared), [undefined, undefined, { set: 'other', key: 'theirs' }])
  assert.equal(stored[0].id, first.id)
  assert.equal(stored[0].status, 'paused')
  assert.equal(stored[0].prompt, review.prompt)
  assert.ok(records.some(entry => entry.event === 'declared-released' && entry.released === 2))
  const again = await controller.applyDeclared({ set: 'home', jobs: [review, backup] })
  assert.equal(again.create.length, 2, 'the released jobs are not members any more')
  assert.deepEqual((await controller.releaseDeclared({ set: 'nothing-here' })).release, [])
})

test('only differing fields change; unset fields go back to the default; the id stays', async () => {
  const { controller } = setup()
  await controller.applyDeclared({ set: 'home', jobs: [review] })
  const id = controller.store.all()[0].id
  const changed = { ...review, prompt: 'Review the plan and the Todo.', deliver: undefined, model: undefined }
  const plan = await controller.applyDeclared({ set: 'home', jobs: [changed], dryRun: true })
  assert.deepEqual(Object.keys(plan.update[0].changes).sort(), ['deliver', 'model', 'prompt'])
  assert.equal(controller.store.get(id).prompt, 'Review the plan.', 'a dry run writes nothing')
  await controller.applyDeclared({ set: 'home', jobs: [changed] })
  const record = controller.store.get(id)
  assert.equal(record.prompt, 'Review the plan and the Todo.')
  assert.equal(record.deliver, undefined)
  assert.equal(record.model, undefined)
})

test('a tool-made job is adopted with its id and run state; tool jobs and other sets are left alone', async () => {
  const { controller } = setup()
  const tool = await controller.create({ title: 'Old review', prompt: 'Review.', schedule: { cron: '0 9 * * *', timeZone: 'Europe/Berlin' }, target: { kind: 'new' } })
  const loose = await controller.create({ title: 'One-shot', prompt: 'Later.', schedule: { at: '2026-11-09T09:00', timeZone: 'Europe/Berlin' }, target: { kind: 'new' } })
  await controller.applyDeclared({ set: 'other', jobs: [{ ...backup, key: 'theirs' }] })
  await controller.setPaused(tool.id, true)
  const result = await controller.applyDeclared({ set: 'home', jobs: [{ ...review, adopt: tool.id, paused: true }] })
  assert.equal(result.adopt.length, 1)
  assert.equal(result.adopt[0].id, tool.id)
  const record = controller.store.get(tool.id)
  assert.deepEqual(record.declared, { set: 'home', key: 'plan-review' })
  assert.equal(record.title, 'Plan review')
  assert.equal(record.status, 'paused')
  const emptied = await controller.applyDeclared({ set: 'home', jobs: [] })
  assert.deepEqual(emptied.remove.map(item => item.id), [tool.id])
  assert.ok(controller.store.get(loose.id), 'tool-made jobs are never pruned')
  assert.equal(controller.store.all().filter(job => job.declared?.set === 'other').length, 1, 'other sets are never pruned')
})

test('paused follows the declaration', async () => {
  const { controller } = setup()
  await controller.applyDeclared({ set: 'home', jobs: [{ ...review, paused: true }] })
  const id = controller.store.all()[0].id
  assert.equal(controller.store.get(id).status, 'paused')
  const plan = await controller.applyDeclared({ set: 'home', jobs: [review] })
  assert.deepEqual(Object.keys(plan.update[0].changes), ['paused'])
  assert.equal(controller.store.get(id).status, 'active')
})

test('a bad entry stops the whole apply before anything changes', async () => {
  const { controller } = setup()
  await assert.rejects(controller.applyDeclared({ set: 'home', jobs: [review, { key: 'bad', title: 'No work', cron: '0 9 * * *', timeZone: 'UTC' }] }), /bad.*prompt, a command/u)
  await assert.rejects(controller.applyDeclared({ set: 'home', jobs: [review, review] }), /appears twice/u)
  await assert.rejects(controller.applyDeclared({ set: 'home', jobs: [{ ...review, typo: 1 }] }), /unknown field typo/u)
  await assert.rejects(controller.applyDeclared({ set: 'home', jobs: [review], checkDeliver: () => 'no running service telegramTopics' }), /plan-review: no running service/u)
  assert.equal(controller.store.all().length, 0)
})

test('an adopt cannot take a job that belongs to another set', () => {
  const stored = [{ id: 'job-1', title: 'Theirs', status: 'active', target: { kind: 'new' }, declared: { set: 'other', key: 'x' } }]
  assert.throws(() => planDeclared({ set: 'home', entries: [{ ...review, adopt: 'job-1' }], stored }), DeclaredSetError)
})
