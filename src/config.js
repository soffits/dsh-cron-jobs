import z from '@deepseek-ai/schemastery'
import { DEFAULT_HISTORY_RECORDS } from './history.js'
import { DEFAULT_COALESCE_SECONDS, DEFAULT_MAX_RUNS_PER_HOUR } from './events.js'

/** Default limit for one run of a job's command. */
export const DEFAULT_TIMEOUT_SECONDS = 3600

const Model = z.object({
  provider: z.string().description('Model provider id, as in the model picker (for example deepseek). Leave provider and model empty to use the preset or host default.'),
  model: z.string().description('Model id within that provider.'),
  reasoningEffort: z.string().description('Reasoning effort id for that model. The model\'s default when empty.'),
}).description('Model of the new session. Used only when both provider and model are set; otherwise the preset or host default applies.')

const DeliveryTarget = z.object({
  via: z.string().description('Name of the DSH service that sends results, such as telegramTopics; it must have a send({ to, text, files, from }) method. Empty: no delivery.'),
  to: z.string().description('Address the service understands, such as a topic name or a chat id.'),
})

const Agent = z.object({
  prompt: z.string().role('textarea')
    .description('Prompt sent to an agent session when the command asks for it, or at every run of a job without a command. Leave empty for a plain job.'),
  preset: z.string().description('Agent preset of the new session. The host default when empty.'),
  cwd: z.string().description('Working directory of the woken session; the session joins the workspace registered there. Empty: the plugin\'s defaultAgentCwd, then the job\'s cwd, then the host default.'),
  sessionId: z.string().description('Send the prompt into this existing session instead of opening a new one. Empty: open a new session.'),
  model: Model,
  autoArchive: z.boolean().description('Archive the woken session once its turn ends, unless it is pinned or a person has sent it a message (such a session is also never reused). The plugin\'s autoArchive when unset.'),
  answerCheck: z.string().description('Command that reads the agent\'s final answer on stdin before the turn closes. Empty output passes it; any output is sent back into the turn as a request to rewrite the answer (once per run). Empty: no check.'),
  reuseWithinHours: z.number().min(0).description('Send the prompt into this job\'s previous woken session instead of opening a new one, when that session was opened within this many hours. 0 always opens a new session. The plugin\'s reuseWithinHours when unset.'),
}).description('Wake an agent: run the command as a gate and open a new session only when its output asks for it.')

const Job = z.object({
  name: z.string().required().description('Job name, used in logs and session titles.'),
  cron: z.string().description('Cron expression (5 fields, or 6 with seconds first). Set at most one of cron, rrule and at; a job with on needs none.'),
  rrule: z.string().role('textarea').description('RFC 5545 schedule: a DTSTART line and an RRULE line, such as "DTSTART;TZID=Europe/Berlin:20260901T080000" and "RRULE:FREQ=WEEKLY;BYDAY=MO". The zone comes from DTSTART.'),
  at: z.string().description('Run once at this time: ISO 8601 with an offset, or a local date-time read in timeZone.'),
  timeZone: z.string().description('IANA time zone for the cron expression or an at without offset, such as Europe/Berlin. The host zone when empty (an at without offset needs it).'),
  on: z.array(z.string()).default([]).description('Event channels that start a run, such as mail.sakina or alerts.* (* matches any characters). Events arriving close together run the job once; the gate command gets them as JSON on stdin and the prompt gets them appended. Keep a slower schedule as a safety net.'),
  command: z.string().role('textarea').description('Shell command, run with bash (or sh when bash is missing). Leave empty for an agent-only job, which sends agent.prompt at every run.'),
  cwd: z.string().description('Working directory of the command. The host process directory when empty.'),
  timeoutSeconds: z.natural().default(DEFAULT_TIMEOUT_SECONDS)
    .description('Stop the command after this many seconds. 0 means no limit.'),
  enabled: z.boolean().default(true).description('Run this job on schedule.'),
  deliver: z.union([z.const(false), DeliveryTarget]).description('Where the job\'s result is sent: the woken agent\'s final answer, or the command\'s output and failures. false sends nothing. Unset: the plugin\'s deliver, except for jobs with agent.sessionId, which send nothing.'),
  agent: Agent,
})

const Watcher = z.object({
  id: z.string().required().description('Watcher id (letters, digits, _ . -), shown in logs and alerts.'),
  channel: z.string().required().description('Channel each output line is emitted on, such as mail.sakina.'),
  command: z.string().role('textarea').required().description('Long-running shell command, run with bash. Each stdout line is an event: a JSON object line is its data, any other line its text; {"wakeAgent": false} lines are ignored. It is restarted with backoff when it exits.'),
  cwd: z.string().description('Working directory. The host process directory when empty.'),
  enabled: z.boolean().default(true).description('Run this watcher.'),
})

const Events = z.object({
  coalesceSeconds: z.natural().default(DEFAULT_COALESCE_SECONDS).description('Events for one job that arrive within this many seconds of the first one start a single run.'),
  maxRunsPerHour: z.natural().default(DEFAULT_MAX_RUNS_PER_HOUR).description('Most event-started runs of one job in any hour; past that, events wait and run together. 0 means no cap.'),
})

export const Config = z.object({
  jobs: z.array(Job).default([]).description('Scheduled jobs.'),
  watchers: z.array(Watcher).default([]).description('Long-running commands whose output lines are events (see a job\'s on). Watchers can also be added from a conversation with the watch tool.'),
  events: Events.description('How events are batched into runs.'),
  defaultAgentCwd: z.string().description('Working directory of woken sessions for jobs whose agent.cwd is empty. Sessions are only found by session search from the same directory, so this is usually the main workspace.'),
  autoArchive: z.boolean().default(true).description('Archive woken sessions once their turn ends, for jobs that do not set agent.autoArchive. Archived sessions leave the sidebar\'s active list but stay in DSH and in session search.'),
  reuseWithinHours: z.number().min(0).default(0).description('Reuse window for jobs that do not set agent.reuseWithinHours: send the prompt into the job\'s previous woken session when it was opened within this many hours. 0 always opens a new session.'),
  deliver: DeliveryTarget.description('Default delivery target for jobs that do not set deliver. Jobs that post into an existing session do not use it. Unset: results are not delivered.'),
  historyRecords: z.natural().min(1).max(1000).default(DEFAULT_HISTORY_RECORDS)
    .description('Runs kept per job for the Cron tasks page (start, duration, exit code, woken session, output tails). Older runs are dropped.'),
  runLog: z.string().description('JSON Lines file that gets one line when a run starts and one when it ends (outcome, exit code, duration, output tails), so past runs can be checked later. Directories are created as needed. No file when empty.'),
})
