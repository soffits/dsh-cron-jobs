import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatcherSupervisor, checkWatcher, lineEvent } from '../src/watchers.js'
import { CronJobs } from '../src/controller.js'
import { HistoryStore, memoryTable } from '../src/history.js'

const quiet = { info() {}, warn() {}, error() {} }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await wait(20)
  }
}

test('watcher lines become events: JSON objects are data, others text, wakeAgent false ignored', () => {
  assert.deepEqual(lineEvent('{"id":"s5","state":"s5"}', 'mail.sakina', 'watcher:m'), { channel: 'mail.sakina', data: { id: 's5', state: 's5' }, source: 'watcher:m', key: 's5' })
  assert.deepEqual(lineEvent('new mail', 'c', 'w'), { channel: 'c', text: 'new mail', source: 'w' })
  assert.deepEqual(lineEvent('[1,2]', 'c', 'w'), { channel: 'c', data: [1, 2], source: 'w' })
  assert.equal(lineEvent('{"wakeAgent": false}', 'c', 'w'), undefined)
  assert.equal(lineEvent('   ', 'c', 'w'), undefined)
  assert.throws(() => checkWatcher({ id: 'a b', channel: 'c', command: 'x' }), /id/)
  assert.throws(() => checkWatcher({ id: 'a', channel: 'c *', command: 'x' }), /channel/)
  assert.throws(() => checkWatcher({ id: 'a', channel: 'c', command: ' ' }), /command/)
})

test('a watcher runs, emits a line per event, is restarted when it exits, and alerts once when it stays down', async () => {
  const root = await mkdtemp(join(tmpdir(), 'watchers-'))
  const events = []
  const notes = []
  const log = []
  const sup = new WatcherSupervisor({
    emit: event => events.push(event),
    logger: quiet,
    record: async entry => { log.push(entry) },
    notify: async text => { notes.push(text) },
    stateRoot: root,
    limits: { minBackoffMs: 20, maxBackoffMs: 40, upAfterMs: 5000, downAlertMs: 300 },
  })
  sup.set([{ id: 'flaky', channel: 'feed', command: 'echo "$DSH_CRON_WATCHER $DSH_CRON_CHANNEL" > "$DSH_CRON_STATE_DIR/who"; echo \'{"n":1}\'; echo plain; echo \'{"wakeAgent": false}\'; echo oops >&2; exit 3' }])
  await until(() => notes.length === 1)
  assert.match(notes[0], /Watcher flaky \(feed\) has been down/)
  assert.match(notes[0], /exit 3/)
  assert.match(notes[0], /oops/)
  assert.deepEqual(events.slice(0, 2), [{ channel: 'feed', data: { n: 1 }, source: 'watcher:flaky' }, { channel: 'feed', text: 'plain', source: 'watcher:flaky' }])
  assert.ok(events.length >= 4, 'restarted at least once')
  assert.equal(await readFile(join(root, 'flaky', 'who'), 'utf8'), 'flaky feed\n')
  const [view] = sup.list()
  assert.ok(view.restarts >= 1)
  assert.equal(view.lastExit.code, 3)
  assert.ok(log.some(entry => entry.event === 'watcher-exit' && entry.stderrTail === 'oops'))
  assert.ok(log.some(entry => entry.event === 'watcher-down'))
  await sup.stop()
  await rm(root, { recursive: true })
})

test('a long-running watcher counts as up, says once it is back, and is stopped with its children', async () => {
  const notes = []
  const sup = new WatcherSupervisor({
    emit: () => {},
    logger: quiet,
    notify: async text => { notes.push(text) },
    limits: { minBackoffMs: 10, maxBackoffMs: 10, upAfterMs: 150, downAlertMs: 50 },
  })
  // Fails twice quickly, then stays up.
  const marker = join(await mkdtemp(join(tmpdir(), 'watchers-')), 'count')
  sup.set([{ id: 'w', channel: 'c', command: `n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; [ "$n" -ge 3 ] || { sleep 0.05; exit 1; }; sleep 30 & wait` }])
  await until(() => notes.length === 2)
  assert.match(notes[0], /down/)
  assert.match(notes[1], /works again/)
  const pid = sup.list()[0].pid
  assert.equal(sup.list()[0].state, 'running')
  await sup.stop()
  assert.equal(sup.list()[0].state, 'stopped')
  assert.throws(() => process.kill(pid, 0))
})

test('stored watchers from the tools feed jobs; a once watcher removes itself', async () => {
  const history = new HistoryStore({ table: memoryTable(), logger: quiet })
  const runs = []
  const controller = new CronJobs({
    jobs: [{ name: 'ci', command: 'cat', on: ['ci.*'] }],
    watchers: [{ id: 'cfg', channel: 'cfg.x', command: 'sleep 30' }],
    logger: quiet,
    history,
    watchdogMs: 0,
    events: { coalesceSeconds: 0 },
    run: async (options) => { runs.push(options); return { ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 } },
    wake: async () => 's',
  }).start()
  await assert.rejects(controller.createWatcher({ id: 'cfg', channel: 'a', command: 'x' }), /already exists/)
  await assert.rejects(controller.removeWatcher('cfg'), /plugin config/)
  const view = await controller.createWatcher({ id: 'ci-7', channel: 'ci.7', command: 'echo \'{"exit": 0}\'', once: true })
  assert.equal(view.once, true)
  await until(() => runs.length === 1)
  assert.deepEqual(JSON.parse(runs[0].input).events[0].data, { exit: 0 })
  await until(() => history.watchers.get('ci-7') === undefined)
  assert.deepEqual(controller.listWatchers().map(w => w.id), ['cfg'])
  await assert.rejects(controller.removeWatcher('nope'), /no watcher/)
  await controller.stop()
})

test('a copy left running by a DSH that died is stopped before the new one starts', async () => {
  const { spawn } = await import('node:child_process')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'watchers-'))
  const orphan = spawn('bash', ['-c', 'sleep 30 & wait'], { env: { ...process.env, DSH_CRON_WATCHER: 'mail' }, detached: true, stdio: 'ignore' })
  const gone = new Promise(resolve => orphan.on('exit', resolve))
  await mkdir(join(root, 'mail'), { recursive: true })
  await writeFile(join(root, 'mail', '.watcher.pid'), `${orphan.pid}\n`)
  // A pid file naming a process of another watcher is left alone.
  const other = spawn('bash', ['-c', 'sleep 30'], { env: { ...process.env, DSH_CRON_WATCHER: 'other' }, detached: true, stdio: 'ignore' })
  await mkdir(join(root, 'feed'), { recursive: true })
  await writeFile(join(root, 'feed', '.watcher.pid'), `${other.pid}\n`)
  const sup = new WatcherSupervisor({ emit: () => {}, logger: quiet, stateRoot: root })
  sup.set([{ id: 'mail', channel: 'mail.me', command: 'sleep 30' }, { id: 'feed', channel: 'feed', command: 'sleep 30' }])
  assert.equal(await gone, null)
  await until(() => sup.list().every(view => view.state === 'running'))
  assert.equal(Number(await readFile(join(root, 'mail', '.watcher.pid'), 'utf8')), sup.get('mail').pid)
  process.kill(other.pid, 0)
  process.kill(-other.pid, 'SIGTERM')
  await sup.stop()
  await rm(root, { recursive: true })
})
