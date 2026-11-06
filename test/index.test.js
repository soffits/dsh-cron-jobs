import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, name } from '../index.js'

test('apply arms jobs inside an effect and cleans up', () => {
  const effects = []
  const lines = []
  const log = level => (...args) => lines.push([level, ...args])
  const logger = Object.assign(() => ({ info: log('info'), warn: log('warn'), error: log('error') }), {})
  const ctx = { logger, effect: (fn) => { effects.push(fn()) }, get: () => undefined }
  apply(ctx, Config({ jobs: [{ name: 'a', cron: '0 0 1 1 *', command: 'true' }] }))
  assert.equal(name, 'dsh-cron-jobs')
  assert.equal(effects.length, 1)
  assert.ok(lines.some(line => line[0] === 'info' && line[2] === 'a'))
  effects[0]()
})
