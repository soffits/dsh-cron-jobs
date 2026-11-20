# Changelog

## 0.22.1

- A job's answer that ends in `[SILENT]` after some text ("Nothing new today. [SILENT]") sends no text; it used to be delivered with the marker in it. The answer and the silent marker now follow the rule of the Telegram and Matrix bridges (`@soffits/dsh-channel-core`), so the text a model wrote between tool calls is never delivered as a job's answer either.

## 0.22.0

- `dsh-cron-run <job id>` starts one run of a job now from a shell, the same as Run now on the page: refused while a run is going, recorded in the job's history and run log as a manual run, schedule untouched. It goes through the request inbox like `dsh-cron-apply` and withdraws a request DSH does not take in time.
- `@deepseek-ai/schemastery` is a peer dependency, so updating the plugin never moves a private copy of it.

## 0.21.2

- The tool descriptions, the row config and the README no longer advise keeping a slower schedule next to `on` as a safety net: a timer there hides a lost event and wakes the job twice. They say to add a schedule only when the clock is part of the work or the source cannot send events.

## 0.21.1

- Fixed: a job with a clock and an event trigger (or two events a moment apart) woke a second agent session for the same work while the first was still on its turn. A job now counts as working until the session it woke ends its turn. A scheduled tick in that time is skipped (logged as `skipped`, `reason: session-working`), and events wait and run together once the turn ends, so a gate sees what the first session already handled. Run now and reruns are not held.
- Fixed: a tick skipped this way (or because a run was going) no longer ends a `once` job.

## 0.21.0

- Built-in events `dsh.turn.started` and `dsh.turn.ended` (any session's turn, `data.sessionId`), sent only while a job listens, so a view of what is running can follow the sessions instead of polling them.

## 0.20.0

- A job can have its own `maxRunsPerHour` (in `schedule_create` / `schedule_edit`, declared sets and config jobs): the cap on event-started runs in any hour, replacing the row's `events.maxRunsPerHour` for that job; `0` lifts it, `-1` on edit goes back to the row's value. Shown in the list and view as `maxRunsPerHour`.

## 0.19.0

- `dsh-cron-apply --set <name> --release` lets go of a declared set: its members become ordinary stored jobs (same ids, history, schedules and pause state), nothing is deleted, and the tools edit them as any other job. `--dry-run` lists them first.

## 0.18.0

- A built-in `command` channel: `deliver: { via: command, to: <command line> }` (or `command:<command line>` in the tools and declared sets) hands a job's result to a shell command instead of a plugin, so a notification router, a mailer or any CLI can take job results. The command gets the same JSON a channel service gets on stdin, runs in the directory the result came from, and exit 0 counts as sent; other exits are retried like a failing service. See "The command channel" in the README.
- Deliveries now carry `runId` in `from`, the run the result belongs to, so a channel can tell a resent result from a new one.

## 0.17.1

- Fixed: a woken session was never archived once another agent session or job had sent it a follow-up (`prompt_session`, `open_session`). DSH marks those messages with source kind `user` like a person's, and the plugin took them for a person taking the session over. It now reads `source.principal` and ignores the agent kinds `dsh-session`, `cron-job` and `external` (the shared kinds `dsh-message-context` tells apart); only the owner in the Web UI or a channel's signed-in sender keeps a session. The session is archived after the turn the follow-up causes.

## 0.17.0

- Declared sets: `dsh-cron-apply --set <name> --file <jobs.json>` makes a group of stored jobs match a list kept in a file, like `kubectl apply --prune`. New keys are created, changed fields are updated (and only those), members that left the list are removed, and nothing outside the set is touched. `--dry-run` prints the plan. An entry can `adopt` an existing tool-made job so its id and run history carry over. Members show `declared` in the list, view and page data. See "Declared sets" in the README.
- Stored jobs can now carry `timeoutSeconds` and `preset` from a declared set; the tools are unchanged.

## 0.16.0

- Ended jobs clean themselves up. A job made with the tools whose schedule has run out (a one-time `at`, a bounded RRULE, a `once` job that has fired) is removed, with its run history, `endedRetentionHours` after it ended. The new row setting defaults to 24; `0` keeps ended jobs until they are deleted by hand, as before, and fractions such as `0.5` work. The check runs every minute and at startup, so a job that expired while DSH was down is removed on the next start. Config jobs, paused jobs and active jobs are never removed, and neither is a job whose last run is still going or still waiting to deliver its result.
- Jobs that ended under an older version have no saved end time; their retention starts when this version first sees them, so an upgrade does not clear them all at once.
- Each removal is logged at info level (title and id) and, with `runLog` set, written as a `removed` line. `cron_job_list` and `cron_job_view` show `removesAt` for an ended job.
- **Behaviour change:** with the default of 24 hours, ended jobs that used to stay listed for ever are now removed. Set `endedRetentionHours: 0` to keep the old behaviour.

## 0.15.1

- On touch screens the filter tabs, buttons, menu items and the footer link are at least 40px tall.

## 0.15.0

- A row-level `problems` setting decides where failure notes go: `problems.channel` emits each one (failed command or gate, failed wake or rerun, watcher down or back) as an event an agent job can take with `on`, and `problems.deliver` sends them to their own target, or with `false` nowhere once a job took the event. Unset, notes go to the job's target as before.
- A job that wakes an agent right after a DSH start (a catch-up run, a watcher event) waits for the session services instead of failing with "no sessionController service". Opening a session and posting into an existing one now wait the way archiving and answer lookup already did, for every service they use.

## 0.14.0

- Removed answer checks (`agent.answerCheck`, the `answerCheck` tool field and the `answer-check` / `answer-recheck` run-log lines). A command that rewrites an agent's answer after the fact hides why the answer was wrong instead of fixing the prompt that produced it, and no job used it. A stored job that still names one keeps running; the field is dropped at its next edit.

## 0.13.1

- A watcher's down note could lose the stderr of the run that failed: it read the tail of the run restarted meanwhile. The tail is kept with the last exit.
- A job's session whose turn DSH's stop cut off is no longer auto-archived: it is unfinished, and dsh-restart-resume (which leaves archived sessions alone) could not hand it back for the rerun. The rerun's own run archives it when it ends.

## 0.13.0

- A run whose turn a DSH restart cut off is rerun when dsh-restart-resume (0.4.0 or later) hands the cut turn back, instead of by the plugin's own timer 30 s after start. One plugin now finds every cut turn, from DSH's log; this one keeps the rerun limits and the delivery. Without dsh-restart-resume, cut-off runs are recorded but not rerun.

## 0.12.0

- A job can have its own event window: `coalesceSeconds` on `cron_job_create`, `cron_job_edit` (a negative number removes it) and config jobs, shown by `cron_job_view`, `cron_job_list` and the Cron tasks page. Without it the job uses `events.coalesceSeconds`, as before. A mailbox job can gather a quarter of an hour of mail into one run while an alert job still runs at once.

## 0.11.0

- `cron_job_edit` takes `prompt_replace` and `command_replace`: lists of literal `{old, new, replace_all?}` replacements applied in order, so a one-sentence change no longer means resending the whole text. Each `old` must match exactly once unless `replace_all` is set; an error names the failing item and nothing is changed.

## 0.10.0

- Each scheduled prompt names its job on `source.principal`.

## 0.9.0

- A turn that DSH cut off (restart) runs once more, as a follow-up in its own session.

## 0.8.0

- Event triggers: the `dsh-cron-event` inbox CLI, jobs that run on events (`on`, `once`), supervised watchers and the watch tool.

## 0.7.1

- A missing delivery channel is waited for instead of dropping the result.

## 0.7.0

- Answer checks that steer a rewrite before the turn closes.

## 0.6.0

- Published as `@soffits/dsh-cron-jobs`; the last text block is a job's final answer.

## 0.5.0 and earlier

- RRULE and one-time schedules, stored jobs and the tools to manage them, delivery through any service with `send`, per-job model, the Cron tasks page, a watchdog for lost ticks.
