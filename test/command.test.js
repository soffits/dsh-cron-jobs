import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { runCommand, MAX_STDOUT_BYTES } from '../src/command.js'

test('collects stdout, stderr and exit code', async () => {
  const result = await runCommand({ command: 'echo out; echo err >&2; exit 3' })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 3)
  assert.equal(result.stdout, 'out\n')
  assert.equal(result.stderr, 'err\n')
  assert.ok(result.durationMs >= 0)
})

test('exit 0 is ok', async () => {
  const result = await runCommand({ command: 'printf hello' })
  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'hello')
})

test('runs in the given cwd', async () => {
  const dir = await realpath(tmpdir())
  const result = await runCommand({ command: 'pwd', cwd: dir })
  assert.equal(result.stdout.trim(), dir)
})

test('a missing cwd fails without running', async () => {
  const result = await runCommand({ command: 'echo should-not-run', cwd: '/nonexistent/dir/for/test' })
  assert.equal(result.ok, false)
  assert.match(result.error, /working directory does not exist/)
  assert.equal(result.stdout, '')
})

test('times out and kills the whole process group', async () => {
  const started = Date.now()
  const result = await runCommand({ command: 'sleep 30 & sleep 30; echo late', timeoutMs: 200 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 10_000)
  assert.doesNotMatch(result.stdout, /late/)
})

test('an abort signal stops the run', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const result = await runCommand({ command: 'sleep 30', signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.aborted, true)
})

test('falls back to the next shell when one is missing', async () => {
  const result = await runCommand({ command: 'echo fallback', shells: ['no-such-shell-xyz', 'sh'] })
  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'fallback\n')
})

test('reports a spawn error when no shell exists', async () => {
  const result = await runCommand({ command: 'echo hi', shells: ['no-such-shell-xyz'] })
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

test('keeps only the tail of very large stdout', async () => {
  const bytes = MAX_STDOUT_BYTES + 5000
  const result = await runCommand({ command: `head -c ${bytes} /dev/zero | tr '\\0' 'a'; echo; echo LAST` })
  assert.equal(result.ok, true)
  assert.equal(Buffer.byteLength(result.stdout), MAX_STDOUT_BYTES)
  assert.ok(result.stdout.endsWith('LAST\n'))
  assert.equal(result.stdoutDropped, bytes + 1 + 5 - MAX_STDOUT_BYTES)
})
