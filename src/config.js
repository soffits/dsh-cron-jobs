import z from '@deepseek-ai/schemastery'
import { DEFAULT_HISTORY_RECORDS } from './history.js'

/** Default limit for one run of a job's command. */
export const DEFAULT_TIMEOUT_SECONDS = 3600

const Agent = z.object({
  prompt: z.string().role('textarea')
    .description('Prompt sent to a new agent session when the command asks for it. Leave empty for a plain job.'),
  preset: z.string().description('Agent preset of the new session. The host default when empty.'),
  cwd: z.string().description('Working directory of the new session. The job\'s cwd, then the host default, when empty.'),
}).description('Wake an agent: run the command as a gate and open a new session only when its output asks for it.')

const Job = z.object({
  name: z.string().required().description('Job name, used in logs and session titles.'),
  cron: z.string().required().description('Cron expression (5 fields, or 6 with seconds first).'),
  timeZone: z.string().description('IANA time zone for the cron expression, such as Europe/Berlin. The host zone when empty.'),
  command: z.string().role('textarea').required().description('Shell command, run with bash (or sh when bash is missing).'),
  cwd: z.string().description('Working directory of the command. The host process directory when empty.'),
  timeoutSeconds: z.natural().default(DEFAULT_TIMEOUT_SECONDS)
    .description('Stop the command after this many seconds. 0 means no limit.'),
  enabled: z.boolean().default(true).description('Run this job on schedule.'),
  agent: Agent,
})

export const Config = z.object({
  jobs: z.array(Job).default([]).description('Scheduled jobs.'),
  historyRecords: z.natural().min(1).max(1000).default(DEFAULT_HISTORY_RECORDS)
    .description('Runs kept per job for the Cron tasks page (start, duration, exit code, woken session, output tails). Older runs are dropped.'),
  runLog: z.string().description('JSON Lines file that gets one line when a run starts and one when it ends (outcome, exit code, duration, output tails), so past runs can be checked later. Directories are created as needed. No file when empty.'),
})
