# Changelog

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
