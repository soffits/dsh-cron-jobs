// Loaded before every test file (npm test): the plugin keeps its event inbox
// and watcher state under DSH_HOME, so tests must never see the real one.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
delete process.env.DSH_CRON_EVENTS_DIR
