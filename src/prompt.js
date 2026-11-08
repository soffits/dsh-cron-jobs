/** Bytes of gate output placed in the agent prompt; older output is cut from the front. */
export const MAX_PROMPT_OUTPUT_BYTES = 64 * 1024

/**
 * Build the message sent to a woken agent: the job's prompt, then the gate
 * command's stdout in a clearly labelled block. A job without a command
 * (agent-only) sends the prompt alone.
 *
 * @param {object} input
 * @param {string} input.jobName
 * @param {string} [input.jobId] - Id of a stored job, so the agent can view, edit or delete it.
 * @param {string} input.prompt - The job's configured prompt.
 * @param {string} [input.stdout] - The gate command's stdout; omitted for an agent-only job.
 * @param {number} [input.droppedBytes] - Stdout bytes already dropped before `stdout`.
 * @param {string} input.firedAt - Local time of the run, as shown in the session title.
 * @returns {string}
 */
export function buildAgentPrompt({ jobName, jobId, prompt, stdout, droppedBytes = 0, firedAt }) {
  const header = jobId === undefined
    ? `This is a scheduled message from the user, sent by the cron job "${jobName}" (run at ${firedAt}).`
    : `This is a scheduled message from the user, sent by the scheduled job "${jobName}" (id ${jobId}, run at ${firedAt}).`
  if (stdout === undefined) return [header, '', prompt.trim()].join('\n')
  const { text, cut } = tailBytes(stdout.replace(/\s+$/, ''), MAX_PROMPT_OUTPUT_BYTES)
  const omitted = droppedBytes + cut
  return [
    header,
    '',
    prompt.trim(),
    '',
    `--- Output of the job's command (stdout) ---`,
    ...(omitted > 0 ? [`[${omitted} earlier bytes omitted]`] : []),
    text,
    '--- End of command output ---',
  ].join('\n')
}

/**
 * Session title for a woken run, like the built-in Schedule's new-session runs.
 * @param {string} jobName
 * @param {string} localTime - `YYYY-MM-DD HH:mm` in the job's time zone.
 */
export function sessionTitle(jobName, localTime) {
  return `${jobName} · ${localTime}`
}

/**
 * Format an instant as `YYYY-MM-DD HH:mm` in a time zone.
 * @param {Date} date
 * @param {string} [timeZone] - IANA zone; the host zone when omitted.
 */
export function formatLocalTime(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/** Keep the last `limit` UTF-8 bytes of a string without splitting a character. */
function tailBytes(text, limit) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return { text, cut: 0 }
  let start = bytes.length - limit
  // Skip UTF-8 continuation bytes so the cut lands on a character boundary.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return { text: bytes.subarray(start).toString('utf8'), cut: start }
}
