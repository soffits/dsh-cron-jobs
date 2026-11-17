# Changelog

## Unreleased

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
