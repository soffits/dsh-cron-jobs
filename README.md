# dsh-cron-jobs

Scheduled jobs for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): shell commands, agent prompts, or both.

DSH's built-in Schedule delivers a prompt to an agent session, so every tick starts a model turn. That is wasteful for jobs that are only a script, or for a check that usually finds nothing. This plugin runs jobs inside the DSH Host process, so they start and stop with DSH:

- A **command job** runs a shell command and never touches a model.
- A **gated job** runs its command first and wakes an agent only when the output says there is something to do.
- An **agent job** has no command: every run sends its prompt to an agent, like a scheduled task.

Jobs run on cron expressions, RFC 5545 RRULE schedules, or once at a given time. They come from the plugin config, or an agent creates them from a conversation with the plugin's tools ("remind me here tomorrow at 9", "check this every Monday until January"). A **Cron tasks** page in the Web GUI shows every job and its recent runs, and lets you run a job now, pause it, or delete one an agent created.

## Install

Install it into the `web` profile straight from GitHub:

```sh
dsh plugin --profile web add github:soffits/dsh-cron-jobs
```

Then restart `dsh web` (or enable it on the Plugins page). To work on it locally instead, clone the repository, install its dependencies, and install the directory as a bundle:

```sh
git clone https://github.com/soffits/dsh-cron-jobs.git
cd dsh-cron-jobs
npm install
```

Then ask the agent to install it, or call the plugin manager yourself:

```
plugin_manager install_bundle /absolute/path/to/dsh-cron-jobs
```

The bundle adds two rows: `cron-jobs`, the scheduler, and `cron-jobs-tools`, which gives every agent the tools described in [Jobs created from a conversation](#jobs-created-from-a-conversation). To give the tools to one agent preset only, disable the `cron-jobs-tools` row and mount `dsh-cron-jobs/tools` in that preset instead.

Built and tested against DSH 0.2.2-rc.1 (`engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0`). Commands run with `bash -c`, or `sh -c` when bash is missing, so the Host needs a POSIX shell. The plugin needs DSH's storage domain service (`@deepseek-ai/dsh-storage-domain`, part of every standard DSH composition) for run history and pause state.

## Configure

Config jobs live in the config of the `cron-jobs` row. Add an override to your profile's `cordis.patch.yml` (or edit the row on the plugin's settings page). An override replaces the whole `config`, so list every job in it.

```yaml
- id: cron-jobs
  config:
    jobs:
      # Plain job: runs the command, logs the result, nothing else.
      - name: Nightly backup
        cron: '30 2 * * *'
        timeZone: Europe/Berlin
        command: ./backup.sh >> backup.log 2>&1
        cwd: /srv/backups
        timeoutSeconds: 1800

      # Gated job: wakes an agent only when the command prints something.
      - name: New issues
        cron: '*/15 * * * *'
        command: ./scripts/new-issues.sh
        cwd: /home/me/project
        agent:
          prompt: Triage the new issues listed below and label them.
          preset: standard
          cwd: /home/me/project
          # Optional: keep feeding one session for 6 hours instead of opening a new one each time.
          reuseWithinHours: 6
          # Optional: the model of the woken session.
          model:
            provider: deepseek
            model: deepseek-chat
            reasoningEffort: high

      # Agent job: no command, the prompt goes out at every run.
      - name: Weekly review
        rrule: |
          DTSTART;TZID=Europe/Berlin:20260907T090000
          RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20270101T000000Z
        agent:
          prompt: Review last week's notes and plan this week.
          # Optional: post into this existing session instead of opening a new one.
          sessionId: session-0123
```

| Field | Meaning |
|---|---|
| `name` | Job name, used in logs and session titles. Must be unique. |
| `cron` | Cron expression: 5 fields, or 6 with seconds first. Parsed by [croner](https://github.com/hexagon/croner). Set exactly one of `cron`, `rrule` and `at`. |
| `rrule` | RFC 5545 schedule: a `DTSTART` line and an `RRULE` line. The time zone comes from `DTSTART` (`TZID=...`, or `Z` for UTC). See [Schedules](#schedules). |
| `at` | Run once at this time: ISO 8601 with an offset, or a local date-time read in `timeZone`. |
| `timeZone` | IANA time zone for the cron expression or an `at` without offset. The Host's zone when empty. |
| `command` | Shell command line. Leave it out for an agent job. |
| `cwd` | Working directory of the command. The Host process directory when empty. |
| `timeoutSeconds` | Stop the command (and everything it started) after this long. Default 3600; `0` means no limit. |
| `enabled` | `false` keeps the job in the config without scheduling it. Default `true`. |
| `agent.prompt` | With a command, makes the job a gated job; without one, an agent job. The prompt sent to the session. |
| `agent.sessionId` | Send the prompt into this existing session instead of opening a new one. Such a session is never auto-archived. |
| `agent.preset` | Agent preset of the new session. The Host default when empty. |
| `agent.cwd` | Working directory of the woken session; it joins the workspace registered at that path. When empty: the row's `defaultAgentCwd`, then the job's `cwd`, then the Host default. |
| `agent.autoArchive` | Archive the woken session once its turn ends (see below). The row's `autoArchive` when unset. |
| `agent.reuseWithinHours` | Send the prompt into the job's previous woken session when that session was opened less than this many hours ago (see below). `0` always opens a new session. The row's `reuseWithinHours` when unset. |
| `agent.model.provider`, `agent.model.model` | Model of the new session, with the same provider and model ids the model picker uses. Both must be set; otherwise the preset's or the Host's default model applies. |
| `agent.model.reasoningEffort` | Reasoning effort id for that model. The model's default when empty. |

Next to `jobs`, the row also takes:

| Field | Meaning |
|---|---|
| `defaultAgentCwd` | Working directory of woken sessions for jobs without `agent.cwd`. |
| `autoArchive` | Default for `agent.autoArchive`. Default `true`. |
| `reuseWithinHours` | Default for `agent.reuseWithinHours`. Default `0`. |
| `historyRecords` | Runs kept per job for the Cron tasks page. Default 50, at most 1000. |
| `runLog` | Optional JSON Lines file of run starts and ends, see below. |

## How runs work

- One run of a job at a time: if a tick arrives while the previous run is still going, the tick is skipped and logged.
- Start, exit status, duration and a short tail of stdout and stderr go to the DSH log under `cron-jobs`. Delivering the output anywhere else is the command's job.
- Set `runLog` (next to `jobs`) to a file path to also keep that record as JSON Lines: one `start` line per run, one `end` line with `status`, `outcome`, `exitCode`, `durationMs` and the output tails, and a `skipped` line for a skipped tick. A `start` with no `end` means DSH stopped during the run. The file is only appended to; rotate it yourself if it grows.
- Ticks of config jobs missed while DSH is down are not caught up; the next tick runs normally. (Jobs created from a conversation catch up once, see below.)
- Unloading the plugin (stopping DSH or changing its config) stops the timers and terminates running commands.

When `agent.model` is set, the model is checked with the Host's LLM service before the session is created, then selected on the new session the same way the model picker does. Unlike the picker, it does not become the Host's default model. A model the Host cannot route fails the wake (shown as "Could not wake the agent" with the reason in the run's output) instead of silently falling back to another model.

### Which workspace woken sessions land in

DSH's session search only finds sessions whose working directory is exactly the caller's. Woken sessions in a separate jobs directory are therefore invisible from your main workspace and the other way round. Pointing `defaultAgentCwd` (or `agent.cwd`) at the main workspace keeps them all searchable together, and auto-archive keeps the sidebar tidy.

### Auto-archive

With auto-archive on, the plugin waits until the woken session's agent is idle (its turn and anything queued behind it have finished, successfully or not), then archives the session with DSH's Workspace registry, the same service behind the sidebar's Archive action. An archived session leaves the sidebar's active list but stays in DSH: it can be opened, unarchived, and is still returned by DSH's session search tools, which filter only by working directory.

- A running session is never archived. DSH itself refuses while a turn, job or subagent is active; the plugin waits for the next idle and tries again.
- A session is left alone when it is pinned, or when a person has sent it a message from any client (a message whose source kind is `user`). Such a session is never reused either.
- The run history shows the result: archive pending, archived, not archived (with the reason), or continued by a later run.
- The tick does not wait for the agent, so the next run of the job is not held up. If the plugin is reloaded or DSH restarts while a session is still working, the archive is picked up again on the next start.

### Session reuse

With `reuseWithinHours` above 0, a gated job sends its prompt into the session it opened earlier instead of opening a new one, as long as that session was first opened less than `reuseWithinHours` ago. The window counts from the first wake, not from the latest reuse, so a frequent job still starts a fresh session every `reuseWithinHours`. Delivery takes the same path as DSH's Schedule for an existing-session target: the session is resumed if needed and the prompt is queued as a new user turn. If the session is busy, the prompt waits for its next turn instead of a second session being opened.

Only sessions the plugin opened for that job are candidates. If the previous session no longer exists, cannot be resumed, is pinned or was taken over by a person, a new session is opened and the run notes why. DSH does not run model steps in an archived session, so with auto-archive on, an archived session is unarchived just before the prompt and archived again after its turn; with auto-archive off, an archived session is not reused. Runs that reused a session say so in the run history.

## Schedules

- **cron**: a cron expression, read in the job's time zone.
- **rrule**: one `DTSTART` line and one `RRULE` line, for example `DTSTART;TZID=America/Toronto:20261109T100000` and `RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261215T150000Z` (every three days at 10:00 Toronto time until mid-December). A `TZID` rule keeps local clock time across daylight-saving changes. `RRULE:FREQ=DAILY;COUNT=1` runs once. A `DTSTART` in the past is fine; runs start with the first occurrence after the job is armed. Rules are evaluated by DSH's own bounded RRULE engine ([`@deepseek-ai/dsh-util-time`](https://www.npmjs.com/package/@deepseek-ai/dsh-util-time), built on [rrule](https://github.com/jkbrzt/rrule)), the same one the built-in Schedule uses, so a rule behaves the same in both, with the same limits (no `SECONDLY`, `COUNT` at most 1000, and so on).
- **at**: one run at a fixed time.

When an RRULE or one-time schedule has no more runs, the job's state becomes **ended**. It stays listed until it is deleted (or, for config jobs, removed from the config).

## Jobs created from a conversation

The `cron-jobs-tools` row registers four tools. Their names start with `cron_job` by default; the row's `prefix` setting changes that (`prefix: schedule` gives `schedule_create` and so on, the names of DSH's built-in Schedule tools, for use in its place).

| Tool | What it does |
|---|---|
| `cron_job_create` | Create a job: a title, a prompt and/or a command, exactly one of `cron`, `rrule` and `at` (with `timeZone` where needed), and where the prompt goes. |
| `cron_job_edit` | `update` the given fields, `pause`, `resume` (continues from now), or `delete` a job by id. |
| `cron_job_list` | Every job, from the config and from tools, with its id, state, schedule, next run, target and last run. |
| `cron_job_view` | One job's full definition and its five latest runs. |

A new job takes the calling session's working directory and agent preset, so a job created from a session in `/home/me/project` runs its command there and opens its sessions there. `cwd` sets another directory.

Where the prompt goes (`target`):

- `new` (default): a new session for every run, with the row's auto-archive and session reuse settings, like a gated config job.
- `new_once`: one new session, opened by the first run; every later run posts into it.
- `this_session`: the session that created the job, for reminders and follow-ups to the conversation. `sessionId` names another existing session instead.

The prompt arrives as a scheduled message from the user, with the job's title and id, so the agent can look the job up or delete it when it is done. A message for an existing session is queued behind a turn that is still running. It is delivered even if the session is pinned or a person is using it, since that is what the job was created for; an archived target session is unarchived first. Target sessions are never auto-archived.

Jobs created with the tools are kept in DSH storage (see below) and survive restarts. Each one remembers its next run, so a run missed while DSH was down happens once when it starts again (only once, however many were missed). If DSH stops in the middle of a run, that run happens again at startup. Jobs from the plugin config cannot be changed with the tools; `cron_job_edit` says so instead.

A delegated subagent can use the tools, but its own session cannot be a target, since it ends with its task.

## Cron tasks page

The Web GUI gets a **Cron tasks** entry in the sidebar, laid out like DSH's own Automation tasks page:

- The list shows every job with its state (active, paused, off in config, invalid, or ended), its schedule and time zone, the next run, and the result of the last run. Jobs an agent created are marked "Created by an agent". Filter by state or search by name, command or prompt. The page refreshes every few seconds while it is visible.
- Selecting a job opens its detail. **Settings** shows the job read-only (schedule, what it does, command, directory, time limit, where the prompt goes, and for jobs with a prompt the agent preset, session directory and where it came from, auto-archive, session reuse and prompt; for jobs an agent created, when and from which session). **Runs** lists the saved runs, newest first: start time, what started it (schedule or Run now), duration, exit code or other outcome, the woken session with a link that opens it, whether the session was reused, its archive state, and the tails of stdout and stderr.
- The pause button pauses or resumes the job's schedule. **Run now** in the `⋯` menu starts one run immediately; it is refused while the job is already running, and it does not move the schedule. **Delete** in the same menu removes a job an agent created, with its run history. A job with a prompt has a footer link to its latest session.

The page does not create or edit jobs: config jobs are edited in the config, the others through the tools.

### Run history, pause state and stored jobs

All three are kept in DSH's storage domain service under the domain `cron_jobs` (with the default JSON backend, `<DSH_HOME>/storages/cron_jobs.json`), so they survive restarts. The `jobs` table holds run history and pause state, one record per job (config jobs by name, other jobs by id); the `tasks` table holds the jobs created with the tools. A stored job looks like this:

```json
{
  "id": "job-1a2b3c4d",
  "title": "Check the parcel",
  "prompt": "Has the parcel arrived? Tell me either way.",
  "schedule": { "kind": "rrule", "rrule": "DTSTART;TZID=America/Toronto:20261109T100000\nRRULE:FREQ=DAILY;COUNT=1" },
  "cwd": "/home/me",
  "preset": "default",
  "target": { "kind": "session", "sessionId": "session-0123" },
  "status": "active",
  "scheduledAt": "2026-11-09T15:00:00.000Z",
  "createdAt": "2026-11-08T17:00:00.000Z",
  "updatedAt": "2026-11-08T17:00:00.000Z",
  "createdBy": "session-0123"
}
```

`schedule` is `{ "kind": "cron", "expression", "timeZone" }`, `{ "kind": "rrule", "rrule" }` or `{ "kind": "at", "at" }` (a UTC instant); `target` is `{ "kind": "new" }`, `{ "kind": "new_once", "sessionId"? }` or `{ "kind": "session", "sessionId" }`; `status` is `active`, `paused` or `ended`; `command` and `timeoutSeconds` are optional. `scheduledAt` is the next run.

For run history and pausing:

- Each run is saved when it starts and completed when it ends. Only the newest `historyRecords` runs of a job are kept, and each saved run keeps the last 1000 characters of stdout and of stderr. A run still marked running when DSH starts again is shown as interrupted.
- Pausing holds the job's timer and saves the pause, so the job stays paused after a restart until you resume it. A paused job can still be run now.
- `enabled: false` in the config always wins: such a job is never scheduled, whatever its saved pause state, and pause and resume are unavailable for it. A pause saved earlier applies again once the job is enabled. Run now still works.
- History and pause state of config jobs are keyed by job name. Renaming a config job starts a fresh record; the old name's record stays in storage but is no longer shown. Deleting a stored job removes its history too.

If the storage domain cannot be opened, config jobs still run, the page says that history is kept in memory only, and jobs created with the tools are lost on restart.

### How the page talks to the Host

The page calls the Host with POST requests to `/api/dsh-cron-jobs/<endpoint>` (`list`, `runs`, `run`, `pause`, `delete`), exact routes the plugin adds to DSH's shared `/api` channel. They are authenticated like the rest of the Web GUI, and DSH lets only the owner reach them, since Run now executes shell commands. The page's styles use only DSH theme tokens, and its layout and icons are copied from DSH's own pages (DSH is MIT-licensed), so it follows light and dark themes and the interface language (English and Chinese).

## Wake rule for gated jobs

After the command finishes:

1. If it failed (non-zero exit, killed, timed out, or could not start), the failure is logged and no agent is woken.
2. If stdout is empty or only whitespace, no agent is woken.
3. If the last non-empty line of stdout is a JSON object whose `wakeAgent` is exactly `false`, such as `{"wakeAgent": false}`, no agent is woken. This is the gate convention of Hermes Agent cron jobs, so existing gate scripts work unchanged. Any other value, a missing key, or a non-JSON last line wakes.
4. Otherwise the prompt goes to the job's session, or a new session is opened (or the previous one reused, see Session reuse) with the job's preset, directory and model, titled `<job name> · <YYYY-MM-DD HH:mm>` in the job's time zone, and sent the prompt followed by the command's stdout in a labelled block. The message is marked as a scheduled message, so the Web GUI shows it like a scheduled run.

A gate script that prints a summary when there is work, and nothing (or `{"wakeAgent": false}`) when there is not, is enough:

```sh
#!/usr/bin/env bash
count=$(gh issue list --label needs-triage --json number --jq length)
if [ "$count" -eq 0 ]; then
  echo '{"wakeAgent": false}'
  exit 0
fi
gh issue list --label needs-triage
```

Up to the last 64 KiB of stdout goes into the prompt; anything earlier is cut and the cut is noted.

## Development

```sh
npm install
npm test
npm run check
```

## License

MIT
