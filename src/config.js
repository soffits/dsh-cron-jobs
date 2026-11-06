import z from '@deepseek-ai/schemastery'

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
})
