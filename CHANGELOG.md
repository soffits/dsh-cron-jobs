# Changelog

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
