import { runCommand } from './command.js'

/**
 * Channels a delivery target can name with `via`. Almost every channel is a
 * DSH service another plugin provides, looked up by name at send time. One is
 * built in: `command`, which hands the result to a shell command, so any CLI
 * (a notification router, a mailer, a chat bridge) can receive job results
 * without a plugin of its own.
 */

/** Name of the built-in channel that runs a command. */
export const COMMAND_CHANNEL = 'command'
/** Longest a delivery command may run. */
export const COMMAND_TIMEOUT_MS = 5 * 60_000
/** Lines of the command's stderr kept in a failure. */
const STDERR_LINES = 10
/** Exit codes of a shell that could not run the command at all: retrying won't help. */
const NOT_RUNNABLE = new Set([126, 127])

/**
 * The built-in command channel. `send` runs `to` with the shell, in `cwd`,
 * with the message as one JSON document on stdin (the object a service's
 * `send` gets: `{ to, text, files, from }`). `DSH_CRON_JOB` names the job and
 * `DSH_SESSION_ID` is the session that wrote the answer (unset for command
 * jobs), so a DSH tool the command calls credits that session. Exit 0 is sent.
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {typeof runCommand} [options.run]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.timeoutMs]
 */
export function commandChannel({ cwd, run = runCommand, env = process.env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return {
    async send({ to, text, files, from }) {
      if (!to) throw permanent('the command channel needs the command line as the address (`to`)')
      const childEnv = { ...env, DSH_CRON_JOB: from?.job ?? '' }
      if (from?.sessionId) childEnv.DSH_SESSION_ID = from.sessionId
      else delete childEnv.DSH_SESSION_ID
      const result = await run({ command: to, cwd, timeoutMs, env: childEnv, input: `${JSON.stringify({ to, text, files, from })}\n` })
      if (result.ok) return
      const how = result.error !== undefined ? `could not run: ${result.error}`
        : result.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`
      const stderr = (result.stderr ?? '').trim().split('\n').slice(-STDERR_LINES).join('\n')
      const error = new Error(`delivery command failed (${how})${stderr ? `: ${stderr}` : ''}`)
      if (result.error !== undefined || NOT_RUNNABLE.has(result.exitCode)) error.retryable = false
      throw error
    },
  }
}

/**
 * The channel a target's `via` names: the built-in command channel, or the
 * DSH service of that name (undefined when none is running).
 * @param {string} name
 * @param {{ get: (name: string) => any, cwd?: string }} options - `get` finds a service; `cwd` is where a command runs.
 */
export function findChannel(name, { get, cwd }) {
  if (name === COMMAND_CHANNEL) return commandChannel({ cwd })
  try {
    return get(name)
  } catch {
    return undefined
  }
}

/** Why a target can't be delivered to now, or undefined when its channel can send. */
export function channelProblem(target, get) {
  if (target.via === COMMAND_CHANNEL) return target.to ? undefined : 'the command channel needs a command: "command:<command line>"'
  const channel = findChannel(target.via, { get })
  return typeof channel?.send === 'function' ? undefined : `no running service ${JSON.stringify(target.via)} can deliver messages`
}

function permanent(message) {
  const error = new Error(message)
  error.retryable = false
  return error
}
