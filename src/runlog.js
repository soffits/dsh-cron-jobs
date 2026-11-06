import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Make a run recorder that appends one JSON line per event to `path`.
 * Without a path it records nothing. A failed write is logged and never
 * breaks the run it describes.
 *
 * @param {string | undefined} path - JSON Lines file, created with its directory.
 * @param {{ warn: Function }} logger
 * @returns {(entry: object) => Promise<void>}
 */
export function createRunLog(path, logger) {
  if (!path) return async () => {}
  let ready
  return async (entry) => {
    try {
      ready ??= mkdir(dirname(path), { recursive: true })
      await ready
      await appendFile(path, JSON.stringify(entry) + '\n')
    } catch (error) {
      ready = undefined
      logger.warn('run log %s not written: %s', path, error instanceof Error ? error.message : String(error))
    }
  }
}
