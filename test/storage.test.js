// Stored jobs against DSH's real storage hub, domain layer and JSON backend:
// a cron_jobs.json written by 0.3 (no `tasks` table) opens, and a job saved
// by one plugin start is loaded by the next.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import { openHistory } from '../src/history.js'
import { CronJobs } from '../src/controller.js'

const quiet = { info() {}, warn() {}, error() {} }

async function withDomain(dir, fn) {
  const root = new Context()
  root.plugin(Storage)
  root.plugin(storageJson, { root: dir })
  root.plugin(storageDomain, { backend: 'json' })
  let result
  await new Promise((resolve, reject) => {
    root.inject(['storageDomain'], async (ctx) => {
      try {
        const history = await openHistory(ctx.storageDomain, { logger: quiet })
        result = await fn(history)
        await history.close()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
  return result
}

test('stored jobs persist in cron_jobs.json next to 0.3 history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dcj-storage-'))
  try {
    await mkdir(dir, { recursive: true })
    const old = { unit: { name: 'cron_jobs', version: 1 }, global: null, tables: { jobs: { mail: { paused: true, runs: [] } } } }
    await writeFile(join(dir, 'cron_jobs.json'), JSON.stringify(old))
    const controller = () => history => new CronJobs({
      jobs: [], logger: quiet, history, run: async () => ({}), wake: async () => 's',
      now: () => new Date('2026-11-08T12:00:00Z'),
    })
    const id = await withDomain(dir, async (history) => {
      assert.equal(history.paused('mail'), true)
      const job = await controller()(history).create({
        title: 'Hello', prompt: 'Hi', schedule: { at: '2026-11-09T09:00:00Z' }, target: { kind: 'new' },
      })
      return job.id
    })
    const file = JSON.parse(await readFile(join(dir, 'cron_jobs.json'), 'utf8'))
    assert.equal(file.tables.tasks[id].title, 'Hello')
    assert.equal(file.tables.jobs.mail.paused, true)
    await withDomain(dir, async (history) => {
      const jobs = controller()(history).start()
      const list = jobs.list()
      await jobs.stop()
      assert.deepEqual(list.map(job => [job.id, job.name, job.nextRunAt]), [[id, 'Hello', '2026-11-09T09:00:00.000Z']])
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
