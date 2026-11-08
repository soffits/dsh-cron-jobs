# dsh-cron-jobs

Cron-scheduled shell commands for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

DSH's built-in Schedule delivers a prompt to an agent session, so every tick starts a model turn. That is wasteful for jobs that are only a script, or for a check that usually finds nothing. This plugin runs commands on a cron schedule inside the DSH Host process, so jobs start and stop with DSH and never touch a model. A job can also act as a gate: its command runs first, and a new agent session is opened only when the command's output says there is something to do. A **Cron tasks** page in the Web GUI shows every job, its recent runs, and lets you run a job now or pause its schedule.

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

Built and tested against DSH 0.2.2-rc.1 (`engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0`). Commands run with `bash -c`, or `sh -c` when bash is missing, so the Host needs a POSIX shell. The plugin needs DSH's storage domain service (`@deepseek-ai/dsh-storage-domain`, part of every standard DSH composition) for run history and pause state.

## Configure

Jobs live in the config of the `cron-jobs` row. Add an override to your profile's `cordis.patch.yml` (or edit the row on the plugin's settings page). An override replaces the whole `config`, so list every job in it.

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
```

| Field | Meaning |
|---|---|
| `name` | Job name, used in logs and session titles. Must be unique. |
| `cron` | Cron expression: 5 fields, or 6 with seconds first. Parsed by [croner](https://github.com/hexagon/croner). |
| `timeZone` | IANA time zone for the expression. The Host's zone when empty. |
| `command` | Shell command line. |
| `cwd` | Working directory of the command. The Host process directory when empty. |
| `timeoutSeconds` | Stop the command (and everything it started) after this long. Default 3600; `0` means no limit. |
| `enabled` | `false` keeps the job in the config without scheduling it. Default `true`. |
| `agent.prompt` | Makes the job a gated job. The prompt sent to the new session. |
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
- Ticks missed while DSH is down are not caught up; the next tick runs normally.
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

## Cron tasks page

The Web GUI gets a **Cron tasks** entry in the sidebar, laid out like DSH's own Automation tasks page:

- The list shows every configured job with its state (active, paused, off in config, or invalid schedule), its cron expression and time zone, the next run, and the result of the last run. Filter by state or search by name or command. The page refreshes every few seconds while it is visible.
- Selecting a job opens its detail. **Settings** shows the job's config read-only (command, directory, time limit, and for gated jobs the agent preset, session directory and where it came from, auto-archive, session reuse and prompt). **Runs** lists the saved runs, newest first: start time, what started it (schedule or Run now), duration, exit code or other outcome, the woken session with a link that opens it, whether the session was reused, its archive state, and the tails of stdout and stderr.
- The pause button pauses or resumes the job's schedule. **Run now** in the `⋯` menu starts one run immediately; it is refused while the job is already running. A gated job's footer links to its latest woken session.

Jobs are still defined only in the config; the page does not create, edit or delete them.

### Run history and pause state

Both are kept in DSH's storage domain service under the domain `cron_jobs` (with the default JSON backend, `<DSH_HOME>/storages/cron_jobs.json`), one record per job name, so they survive restarts:

- Each run is saved when it starts and completed when it ends. Only the newest `historyRecords` runs of a job are kept, and each saved run keeps the last 1000 characters of stdout and of stderr. A run still marked running when DSH starts again is shown as interrupted.
- Pausing holds the job's cron timer and saves the pause, so the job stays paused after a restart until you resume it. A paused job can still be run now.
- `enabled: false` in the config always wins: such a job is never scheduled, whatever its saved pause state, and pause and resume are unavailable for it. A pause saved earlier applies again once the job is enabled. Run now still works.
- History and pause state are keyed by job name. Renaming a job starts a fresh record; the old name's record stays in storage but is no longer shown.

If the storage domain cannot be opened, jobs still run and the page says that history is kept in memory only.

### How the page talks to the Host

The page calls the Host with POST requests to `/api/dsh-cron-jobs/<endpoint>`, exact routes the plugin adds to DSH's shared `/api` channel. They are authenticated like the rest of the Web GUI, and DSH lets only the owner reach them, since Run now executes shell commands. The page's styles use only DSH theme tokens, and its layout and icons are copied from DSH's own pages (DSH is MIT-licensed), so it follows light and dark themes and the interface language (English and Chinese).

## Wake rule for gated jobs

After the command finishes:

1. If it failed (non-zero exit, killed, timed out, or could not start), the failure is logged and no agent is woken.
2. If stdout is empty or only whitespace, no agent is woken.
3. If the last non-empty line of stdout is a JSON object whose `wakeAgent` is exactly `false`, such as `{"wakeAgent": false}`, no agent is woken. This is the gate convention of Hermes Agent cron jobs, so existing gate scripts work unchanged. Any other value, a missing key, or a non-JSON last line wakes.
4. Otherwise a new session is opened (or the previous one reused, see Session reuse) with the job's preset, directory and model, titled `<job name> · <YYYY-MM-DD HH:mm>` in the job's time zone, and sent the prompt followed by the command's stdout in a labelled block. The message is marked as a scheduled message, so the Web GUI shows it like a scheduled run.

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
