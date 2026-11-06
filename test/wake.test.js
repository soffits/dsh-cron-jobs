import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideWake } from '../src/wake.js'

const ok = stdout => ({ ok: true, stdout })

test('a failed command never wakes, even with output', () => {
  assert.equal(decideWake({ ok: false, stdout: 'something to do' }).wake, false)
})

test('empty or whitespace-only stdout does not wake', () => {
  assert.equal(decideWake(ok('')).wake, false)
  assert.equal(decideWake(ok('  \n\t\n')).wake, false)
})

test('{"wakeAgent": false} on the last non-empty line does not wake', () => {
  assert.equal(decideWake(ok('{"wakeAgent": false}')).wake, false)
  assert.equal(decideWake(ok('checked 3 feeds\n{"wakeAgent":false}\n\n')).wake, false)
  assert.equal(decideWake(ok('{"wakeAgent": false, "note": "quiet"}')).wake, false)
})

test('wakeAgent false on an earlier line still wakes', () => {
  assert.equal(decideWake(ok('{"wakeAgent": false}\nnew item found')).wake, true)
})

test('only a strict false skips', () => {
  for (const line of ['{"wakeAgent": true}', '{"wakeAgent": 0}', '{"wakeAgent": "false"}', '{"wakeAgent": null}', '{}']) {
    assert.equal(decideWake(ok(line)).wake, true, line)
  }
})

test('plain text, non-object JSON, and broken JSON wake', () => {
  for (const out of ['3 new messages', 'false', '[{"wakeAgent": false}]', 'null', '{"wakeAgent": false']) {
    assert.equal(decideWake(ok(out)).wake, true, out)
  }
})
