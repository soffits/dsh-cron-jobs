// Loaded before every test file (npm test): the plugin keeps its event inbox
// and watcher state under DSH_HOME, so tests must never see the real one.
// The temporary home is removed when the test process exits.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
process.env.DSH_HOME = home
delete process.env.DSH_CRON_EVENTS_DIR
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
