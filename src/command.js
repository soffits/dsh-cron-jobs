import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

/** Bytes of stdout kept per run; older output is dropped from the front. */
export const MAX_STDOUT_BYTES = 1024 * 1024
/** Bytes of stderr kept per run; older output is dropped from the front. */
export const MAX_STDERR_BYTES = 64 * 1024
/** Time between SIGTERM and SIGKILL when a run is stopped. */
export const KILL_GRACE_MS = 5_000

/** Keeps only the last `limit` bytes written to it. */
class TailBuffer {
  constructor(limit) {
    this.limit = limit
    this.chunks = []
    this.size = 0
    this.dropped = 0
  }

  push(chunk) {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.limit) {
      const first = this.chunks[0]
      const excess = this.size - this.limit
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
        this.dropped += first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
        this.dropped += excess
      }
    }
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * Run one shell command and collect its result. Never rejects.
 *
 * The command runs as `<shell> -c <command>` in its own process group, so a
 * timeout or an abort stops the whole tree (SIGTERM, then SIGKILL after a
 * grace period).
 *
 * @param {object} options
 * @param {string} options.command - Shell command line.
 * @param {string} [options.cwd] - Working directory; the host process directory when omitted.
 * @param {number} [options.timeoutMs] - Stop the run after this many milliseconds; 0 or omitted means no limit.
 * @param {AbortSignal} [options.signal] - Stops the run when aborted.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment; the host environment when omitted.
 * @param {string[]} [options.shells] - Shells tried in order until one starts.
 * @returns {Promise<CommandResult>}
 *
 * @typedef {object} CommandResult
 * @property {boolean} ok - Exit code 0 without timeout, signal, or spawn error.
 * @property {number | null} exitCode
 * @property {string | null} signal - Signal that ended the process, if any.
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {string} [error] - Spawn error message.
 * @property {string} stdout - Last {@link MAX_STDOUT_BYTES} of stdout.
 * @property {string} stderr - Last {@link MAX_STDERR_BYTES} of stderr.
 * @property {number} stdoutDropped - Bytes of stdout dropped from the front.
 * @property {number} durationMs
 */
export async function runCommand({ command, cwd, timeoutMs, signal, env, shells = ['bash', 'sh'] }) {
  const started = Date.now()
  if (cwd !== undefined && !(await isDirectory(cwd))) {
    return {
      ok: false, exitCode: null, signal: null, timedOut: false, aborted: false,
      error: `working directory does not exist: ${cwd}`,
      stdout: '', stderr: '', stdoutDropped: 0, durationMs: Date.now() - started,
    }
  }
  let last
  for (const shell of shells) {
    last = await runWith(shell, { command, cwd, timeoutMs, signal, env })
    if (last.spawnMissing !== true) break
  }
  const { spawnMissing, ...result } = last
  return { ...result, durationMs: Date.now() - started }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function runWith(shell, { command, cwd, timeoutMs, signal, env }) {
  return new Promise((resolve) => {
    const stdout = new TailBuffer(MAX_STDOUT_BYTES)
    const stderr = new TailBuffer(MAX_STDERR_BYTES)
    let timedOut = false
    let aborted = false
    let spawnError
    let timer
    let killTimer
    let settled = false

    if (signal?.aborted) {
      resolve(finish({ exitCode: null, signal: null, aborted: true }))
      return
    }

    let child
    try {
      child = spawn(shell, ['-c', command], {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch (error) {
      resolve(finish({ exitCode: null, signal: null, error }))
      return
    }

    const stop = () => {
      killTree(child, 'SIGTERM')
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const onAbort = () => {
      aborted = true
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      timer.unref?.()
    }

    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', (error) => {
      spawnError = error
      // A child that never started emits no 'close'.
      if (child.pid === undefined) done(null, null)
    })
    child.on('close', (code, sig) => done(code, sig))

    function done(exitCode, sig) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve(finish({ exitCode, signal: sig, error: spawnError }))
    }

    function finish({ exitCode, signal: sig, error, aborted: preAborted }) {
      const wasAborted = aborted || preAborted === true
      return {
        ok: exitCode === 0 && !timedOut && !wasAborted && error === undefined,
        exitCode,
        signal: sig ?? null,
        timedOut,
        aborted: wasAborted,
        ...(error === undefined ? {} : { error: error.message ?? String(error) }),
        spawnMissing: error?.code === 'ENOENT' && child?.pid === undefined,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutDropped: stdout.dropped,
      }
    }
  })
}

/** Signal the child's process group, falling back to the child alone. */
function killTree(child, sig) {
  // The shell may have exited while children in its group still run, so the
  // group is signalled even after the shell's own exit.
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, sig)
    else child.kill(sig)
  } catch {
    try { child.kill(sig) } catch { /* already gone */ }
  }
}
