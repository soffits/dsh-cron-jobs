/**
 * Decide whether a gate command's result should wake an agent.
 *
 * - A failed run (non-zero exit, signal, timeout, spawn error) never wakes.
 * - Empty stdout (only whitespace) does not wake.
 * - When the last non-empty stdout line is a JSON object whose `wakeAgent`
 *   is exactly `false`, it does not wake. This follows the Hermes Agent cron
 *   gate convention; any other value, a missing key, or non-JSON output wakes.
 * - Anything else wakes.
 *
 * @param {{ ok: boolean, stdout: string }} result - Finished command result.
 * @returns {{ wake: boolean, reason: string }} The decision and a short reason for the log.
 */
export function decideWake(result) {
  if (!result.ok) return { wake: false, reason: 'command failed' }
  const lines = result.stdout.split(/\r?\n/).filter(line => line.trim() !== '')
  if (lines.length === 0) return { wake: false, reason: 'empty output' }
  if (gateSaysNo(lines[lines.length - 1])) return { wake: false, reason: 'wakeAgent is false' }
  return { wake: true, reason: 'output present' }
}

/** Whether one line is a JSON object with `wakeAgent: false`. */
function gateSaysNo(line) {
  let value
  try {
    value = JSON.parse(line.trim())
  } catch {
    return false
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) && value.wakeAgent === false
}
