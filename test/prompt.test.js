import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentPrompt, formatLocalTime, sessionTitle, MAX_PROMPT_OUTPUT_BYTES } from '../src/prompt.js'

test('formats local time in the job time zone', () => {
  const date = new Date('2026-07-01T23:30:00Z')
  assert.equal(formatLocalTime(date, 'UTC'), '2026-07-01 23:30')
  assert.equal(formatLocalTime(date, 'Asia/Tokyo'), '2026-07-02 08:30')
  assert.equal(formatLocalTime(new Date('2026-07-01T00:05:00Z'), 'UTC'), '2026-07-01 00:05')
})

test('session title joins name and time', () => {
  assert.equal(sessionTitle('Feed check', '2026-07-01 08:00'), 'Feed check · 2026-07-01 08:00')
})

test('prompt has the job prompt and a labelled output block', () => {
  const text = buildAgentPrompt({ jobName: 'feeds', prompt: 'Summarize.\n', stdout: 'a\nb\n\n', firedAt: '2026-07-01 08:00' })
  assert.equal(text, [
    'This is a scheduled message from the user, sent by the cron job "feeds" (run at 2026-07-01 08:00).',
    '',
    'Summarize.',
    '',
    "--- Output of the job's command (stdout) ---",
    'a\nb',
    '--- End of command output ---',
  ].join('\n'))
})

test('long output keeps the tail and says how much was cut', () => {
  const stdout = 'é'.repeat(MAX_PROMPT_OUTPUT_BYTES) + 'END'
  const text = buildAgentPrompt({ jobName: 'j', prompt: 'p', stdout, droppedBytes: 10, firedAt: 't' })
  assert.match(text, /\[\d+ earlier bytes omitted\]/)
  assert.ok(text.includes('END\n--- End of command output ---'))
  assert.ok(!text.includes('\uFFFD'))
  const omitted = Number(text.match(/\[(\d+) earlier/)[1])
  assert.ok(omitted > 10)
})
