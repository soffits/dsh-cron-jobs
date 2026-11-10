# Maintainer notes

## Layout

- `index.js`: the scheduler plugin (`cron-jobs` row). Opens storage, starts `CronJobs`, provides the `cronJobs` service, serves the page routes.
- `tools.js`: the model-facing tools (`cron-jobs-tools` row, `dsh-cron-jobs/tools`). Looks up `cronJobs` at call time instead of injecting it, so a reload of the scheduler row (any config change) never unregisters the tools. DSH sessions on some providers fail for good when a tool they used disappears.
- `src/controller.js`: all jobs, timers, pause, create/update/delete of stored jobs, read model.
- `src/job.js`: one run (command, wake rule, delivery to a new, reused or target session, auto-archive).
- `src/deliver.js`: result delivery (target resolution, MEDIA lines, failure notes, final-answer lookup in the session log, `send` with retries). `src/session.js` `waitForAnswer` waits for the woken turn.
- `src/schedule.js`: parsing of cron / rrule / at, `ScheduleTimer`, and `CronTimer` (config cron jobs).
- `src/store.js`, `src/history.js`: the `cron_jobs` storage domain (`jobs` = history and pause state, `tasks` = stored jobs).
- `client.js`: the Cron tasks page, plain JS in DSH's client module format.

## Decisions

- **RRULE engine: `@deepseek-ai/dsh-util-time` (pinned to the DSH version we build against).** It is what DSH's built-in Schedule uses (MIT, wraps `rrule` 2.8.1 and the Temporal polyfill, adds DST handling and cost limits), so a rule copied from a built-in task behaves identically. The plain `rrule` package handles TZID poorly on its own; writing our own would repeat solved work. Its instant helpers also parse the `at` input.
- **croner (11+) computes cron occurrences; it does not run the timers.** Every job runs on `ScheduleTimer` (config cron jobs through `CronTimer`, a croner-shaped wrapper). croner 10's own timer lost the first tick of a freshly armed job now and then (seen 2026-11-08 after plugin reloads and restarts): when its timeout woke a little early, it computed the due time again from a "now" that had passed it and moved on to the next occurrence, with no trace. croner 11.0.0 fixed that upstream (the target is fixed when the timer is armed) and also stopped `nextRun()` from answering a past time inside the repeated hour of a DST fall back, which on our timer meant firing in a loop; so croner is pinned to `^11`. We still keep our own timer rather than going back to croner's, because one timer serves every kind of schedule and the watchdog needs a timer whose `nextRun()` stays on a due occurrence until it has fired (croner's moves on to the future after a lost tick, so a loss could not be seen). Stored jobs can also start from a saved past occurrence (catch-up). The repro of the croner 10 loss is the `CronTimer keeps a due tick` test.
- **A watchdog backs up the timers**: once a minute, a job whose next run is more than a minute in the past (not paused) gets an `overdue` run-log line and runs late. The run log also gets `scheduler-start` / `scheduler-stop` lines, because the plugin's logger output is not kept anywhere by DSH.
- **Tool shapes follow `@deepseek-ai/dsh-tool-schedule`**: create/edit/list/view, targets `this_session` / `new_once` / `new`, caller cwd from `agent.session.header.cwd`, preset from `agentPresets.composedPreset(agent.ctx)`, delegation depth from the session header and `agent.options.subagentDepth`, `new_once` saving the session opened by the first run. Differences: a command can be part of a job; cron and one-time schedules are accepted besides RRULE; edit has explicit `pause`/`resume`; an explicit `sessionId`; no "only at the user's explicit request" system-prompt line.
- **Tool definitions are plain objects with JSON Schema**, not `defineTool` from `@deepseek-ai/dsh-tools`, whose runtime imports pull in most of DSH. `checkArgs` in tools.js validates arguments; the schemas use only DSH's supported subset (type/properties/required/additionalProperties/enum), and tool errors come back as `{ code, message }` results.
- **Stored jobs catch up one missed run at startup; config jobs don't.** Stored jobs replace DSH scheduled tasks, which catch up; config jobs kept their 0.3 behaviour. The next run is saved after each scheduled run ends, so a run cut off by a restart happens again (same as the built-in).
- **Explicit target sessions ignore the "person took over" hold and are unarchived if needed**, because posting there is the job's purpose; they are never auto-archived.
- **Delivery goes through a named service, looked up with `ctx.get(via)` at send time.** No channel code lives here, and nothing is injected, so the channel can load after this plugin, reload, or be missing without unloading the scheduler. The contract (`send({ to, text, files, from })`, `retryable: false`) is in the README; changing it breaks every channel, so treat it as public API.
- **The answer is found by message id**: the runner gives the prompt its own id, and the answer is the last assistant text between that `user/message` event and the next `turn/end`. Pending deliveries keep the id in the run history and resume after a restart, like pending archives.
- **Gate failures and failed wakes are delivered too**, not only command-job failures, so a broken job never goes quiet. A run aborted by an unload delivers nothing.

- **Page transport: exact `/api` Fetch routes for now, RPC later.** `ctx.connection.rpc.handle` throws 'cannot get property webServer without inject' in DSH 0.2.2-rc.1 (see `src/rpc.js`). On each new DSH release, try `rpc.handle` again; once it mounts, move the page back to RPC and drop the Fetch routes in one change (Livia, 2026-11-08: a todo for later).

## Checks before a release

`npm test`, `npm run check`, then CI on push. The page has no automated test; render it once with stored, config, ended and agent-only jobs before releasing a page change.
