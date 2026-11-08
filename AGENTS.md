# Maintainer notes

## Layout

- `index.js`: the scheduler plugin (`cron-jobs` row). Opens storage, starts `CronJobs`, provides the `cronJobs` service, serves the page routes.
- `tools.js`: the model-facing tools (`cron-jobs-tools` row, `dsh-cron-jobs/tools`). Looks up `cronJobs` at call time instead of injecting it, so a reload of the scheduler row (any config change) never unregisters the tools. DSH sessions on some providers fail for good when a tool they used disappears.
- `src/controller.js`: all jobs, timers, pause, create/update/delete of stored jobs, read model.
- `src/job.js`: one run (command, wake rule, delivery to a new, reused or target session, auto-archive).
- `src/schedule.js`: parsing of cron / rrule / at, and `ScheduleTimer`.
- `src/store.js`, `src/history.js`: the `cron_jobs` storage domain (`jobs` = history and pause state, `tasks` = stored jobs).
- `client.js`: the Cron tasks page, plain JS in DSH's client module format.

## Decisions

- **RRULE engine: `@deepseek-ai/dsh-util-time` (pinned to the DSH version we build against).** It is what DSH's built-in Schedule uses (MIT, wraps `rrule` 2.8.1 and the Temporal polyfill, adds DST handling and cost limits), so a rule copied from a built-in task behaves identically. The plain `rrule` package handles TZID poorly on its own; writing our own would repeat solved work. Its instant helpers also parse the `at` input.
- **Cron stays on croner** for config jobs, so their behaviour did not change in 0.4. Stored cron jobs compute occurrences with croner too, but run on `ScheduleTimer`, which can start from a saved past occurrence (catch-up).
- **Tool shapes follow `@deepseek-ai/dsh-tool-schedule`**: create/edit/list/view, targets `this_session` / `new_once` / `new`, caller cwd from `agent.session.header.cwd`, preset from `agentPresets.composedPreset(agent.ctx)`, delegation depth from the session header and `agent.options.subagentDepth`, `new_once` saving the session opened by the first run. Differences: a command can be part of a job; cron and one-time schedules are accepted besides RRULE; edit has explicit `pause`/`resume`; an explicit `sessionId`; no "only at the user's explicit request" system-prompt line.
- **Tool definitions are plain objects with JSON Schema**, not `defineTool` from `@deepseek-ai/dsh-tools`, whose runtime imports pull in most of DSH. `checkArgs` in tools.js validates arguments; the schemas use only DSH's supported subset (type/properties/required/additionalProperties/enum), and tool errors come back as `{ code, message }` results.
- **Stored jobs catch up one missed run at startup; config jobs don't.** Stored jobs replace DSH scheduled tasks, which catch up; config jobs kept their 0.3 behaviour. The next run is saved after each scheduled run ends, so a run cut off by a restart happens again (same as the built-in).
- **Explicit target sessions ignore the "person took over" hold and are unarchived if needed**, because posting there is the job's purpose; they are never auto-archived.

## Checks before a release

`npm test`, `npm run check`, then CI on push. The page has no automated test; render it once with stored, config, ended and agent-only jobs before releasing a page change.
