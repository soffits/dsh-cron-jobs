# dsh-cron-jobs

Scheduled jobs for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): shell commands, agent prompts, or both.

DSH's built-in Schedule delivers a prompt to an agent session, so every tick starts a model turn. That is wasteful for jobs that are only a script, or for a check that usually finds nothing. This plugin runs jobs inside the DSH Host process, so they start and stop with DSH:

- A **command job** runs a shell command and never touches a model.
- A **gated job** runs its command first and wakes an agent only when the output says there is something to do.
- An **agent job** has no command: every run sends its prompt to an agent, like a scheduled task.

A job's result can be **delivered**: the woken agent's final answer, or a command's output and failures, is handed to another plugin that sends it on, such as a chat bot. This plugin knows no channel itself; any plugin that provides a small `send` method can be one (see [Result delivery](#result-delivery)).

Jobs run on cron expressions, RFC 5545 RRULE schedules, or once at a given time, and they can also run on **events** instead of polling: any script, hook or CLI can emit one with `dsh-cron-event <channel>`, and the plugin can keep long-running **watchers** (a mailbox push stream, a notification feed) whose output lines are events (see [Events](#events)). Jobs come from the plugin config, or an agent creates them from a conversation with the plugin's tools ("remind me here tomorrow at 9", "check this every Monday until January"). A **Cron tasks** page in the Web GUI shows every job and its recent runs, and lets you run a job now, pause it, or delete one an agent created.

## Install

Install it into the `web` profile from npm:

```sh
dsh plugin --profile web add @soffits/dsh-cron-jobs
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

The bundle adds two rows: `cron-jobs`, the scheduler, and `cron-jobs-tools`, which gives every agent the tools described in [Jobs created from a conversation](#jobs-created-from-a-conversation). To give the tools to one agent preset only, disable the `cron-jobs-tools` row and mount `@soffits/dsh-cron-jobs/tools` in that preset instead.

Built and tested against DSH 0.2.2-rc.1 (`engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0`). Commands run with `bash -c`, or `sh -c` when bash is missing, so the Host needs a POSIX shell. The plugin needs DSH's storage domain service (`@deepseek-ai/dsh-storage-domain`, part of every standard DSH composition) for run history and pause state.

## Configure

Config jobs live in the config of the `cron-jobs` row. Add an override to your profile's `cordis.patch.yml` (or edit the row on the plugin's settings page). An override replaces the whole `config`, so list every job in it.

```yaml
- id: cron-jobs
  config:
    # Optional: send every job's result here unless the job says otherwise.
    deliver:
      via: telegramTopics
      to: notify
    jobs:
      # Plain job: runs the command, logs the result, nothing else.
      - name: Nightly backup
        cron: '30 2 * * *'
        timeZone: Europe/Berlin
        command: ./backup.sh >> backup.log 2>&1
        cwd: /srv/backups
        timeoutSeconds: 1800

      # Gated job: wakes an agent only when the command prints something.
      # Its agent's final answer goes to the row's deliver target.
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
        deliver: false   # the answer stays in the session
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
| `cron` | Cron expression: 5 fields, or 6 with seconds first. Parsed by [croner](https://github.com/hexagon/croner), which handles daylight-saving changes like Vixie cron: a fixed time skipped by a spring forward runs at the first valid time after the gap, a fixed time repeated by a fall back runs once, and patterns with several hours, minutes or seconds run on both repeated occurrences. Set exactly one of `cron`, `rrule` and `at`, or none when the job has `on`. |
| `on` | Event channel patterns that start a run, such as `[mail.sakina, alerts.*]`. See [Events](#events). |
| `rrule` | RFC 5545 schedule: a `DTSTART` line and an `RRULE` line. The time zone comes from `DTSTART` (`TZID=...`, or `Z` for UTC). See [Schedules](#schedules). |
| `at` | Run once at this time: ISO 8601 with an offset, or a local date-time read in `timeZone`. |
| `timeZone` | IANA time zone for the cron expression or an `at` without offset. The Host's zone when empty. |
| `command` | Shell command line. Leave it out for an agent job. |
| `cwd` | Working directory of the command. The Host process directory when empty. |
| `timeoutSeconds` | Stop the command (and everything it started) after this long. Default 3600; `0` means no limit. |
| `enabled` | `false` keeps the job in the config without scheduling it. Default `true`. |
| `deliver` | Where the job's result is sent: `{ via: <service name>, to: <address> }`, or `false` for nothing. Unset: the row's `deliver`, except for jobs with `agent.sessionId`, which send nothing. See [Result delivery](#result-delivery). |
| `agent.prompt` | With a command, makes the job a gated job; without one, an agent job. The prompt sent to the session. |
| `agent.sessionId` | Send the prompt into this existing session instead of opening a new one. Such a session is never auto-archived. |
| `agent.preset` | Agent preset of the new session. The Host default when empty. |
| `agent.cwd` | Working directory of the woken session; it joins the workspace registered at that path. When empty: the row's `defaultAgentCwd`, then the job's `cwd`, then the Host default. |
| `agent.autoArchive` | Archive the woken session once its turn ends (see below). The row's `autoArchive` when unset. |
| `agent.reuseWithinHours` | Send the prompt into the job's previous woken session when that session was opened less than this many hours ago (see below). `0` always opens a new session. The row's `reuseWithinHours` when unset. |
| `agent.model.provider`, `agent.model.model` | Model of the new session, with the same provider and model ids the model picker uses. Both must be set; otherwise the preset's or the Host's default model applies. |
| `agent.model.reasoningEffort` | Reasoning effort id for that model. The model's default when empty. |
| `agent.answerCheck` | Command that checks the agent's final answer before its turn closes (see [Answer checks](#answer-checks)). No check when empty. |

Next to `jobs`, the row also takes:

| Field | Meaning |
|---|---|
| `defaultAgentCwd` | Working directory of woken sessions for jobs without `agent.cwd`. |
| `autoArchive` | Default for `agent.autoArchive`. Default `true`. |
| `reuseWithinHours` | Default for `agent.reuseWithinHours`. Default `0`. |
| `deliver` | Default delivery target, `{ via, to }`, for jobs that do not set `deliver`. Unset: results are not delivered. |
| `historyRecords` | Runs kept per job for the Cron tasks page. Default 50, at most 1000. |
| `runLog` | Optional JSON Lines file of run starts and ends, see below. |
| `watchers` | Long-running commands whose output lines are events: `[{ id, channel, command, cwd, enabled }]`. See [Watchers](#watchers). |
| `events.coalesceSeconds` | Events for one job that arrive within this many seconds of the first start one run. Default 30. |
| `events.maxRunsPerHour` | Most event-started runs of one job in any hour; past that, events wait and run together. Default 6; `0` means no cap. |

## How runs work

- One run of a job at a time: if a tick arrives while the previous run is still going, the tick is skipped and logged.
- Start, exit status, duration and a short tail of stdout and stderr go to the DSH log under `cron-jobs`. Sending the result anywhere else is what [Result delivery](#result-delivery) is for.
- Set `runLog` (next to `jobs`) to a file path to also keep that record as JSON Lines: one `start` line per run, one `end` line with `status`, `outcome`, `exitCode`, `durationMs`, the output tails and the delivery state, a `delivery` line when a result waits for its channel (`waiting`), is left for the next start (`pending`), or has been delivered or not (`sent`, `silent`, `failed`), a `skipped` line for a skipped tick, an `overdue` line (with `dueAt` and `lateMs`) when a tick did not start on time and the watchdog ran it late, and `scheduler-start` / `scheduler-stop` lines (with `job: null`) when the scheduler starts or stops, so a gap in the log can be told apart from a lost tick. Events add an `event` line per event (`channel`, `source`, the `matched` job ids, or `duplicate`), and watchers `watcher-start`, `watcher-exit` (exit code, run time, stderr tail), `watcher-down` and `watcher-up` lines. An event run's `start` line has `trigger: event` and the events' count and channels. A `start` with no `end` means DSH stopped during the run. The file is only appended to; rotate it yourself if it grows.
- Ticks of config jobs missed while DSH is down are not caught up; the next tick runs normally. While DSH runs, a watchdog checks every minute that each job's next run is not more than a minute in the past; a tick whose timer was lost runs late instead of being missed. (Jobs created from a conversation catch up once, see below.)
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

## Result delivery

A job with a delivery target sends its result when a run is over:

- **Agent and gated jobs**: when the woken session's turn ends, its final answer (the text of the last assistant message of the turn the prompt started) is sent. An empty answer, or exactly `[SILENT]`, sends nothing, so a check that found nothing stays quiet. The prompt tells the agent this in one line, so job prompts don't have to.
- **Command jobs**: non-empty stdout is sent. If the command fails (non-zero exit, timeout, killed, or could not start), a short note is sent instead, after any stdout: `⚠️ <job> failed (exit <code>)` (or `timed out after <n>s`, ...) followed by the last 15 lines of stderr.
- **Gated jobs** whose command fails send the same failure note, and a wake that fails sends `⚠️ <job>: could not wake the agent: <reason>`. A gate that decides not to wake sends nothing.
- Lines of the form `MEDIA:<path>` in the result are taken out of the text and sent as files. Relative paths are read from the job's directory (the session directory for agent answers), and `~` is the home directory.

Where results go is decided per job: its own `deliver` (or `false`), otherwise nothing for jobs that post into an existing session (`agent.sessionId`, or the tools' `this_session` / `sessionId`), since the answer is already in that conversation, otherwise the row's `deliver`. A run stopped because DSH is shutting down delivers nothing.

Each run's delivery shows on the Cron tasks page and in the run log: not sent yet (waiting for the answer or for the channel), sent, nothing to send, or not sent with the reason. A delivery still waiting when DSH stops or the plugin reloads, whether for a turn that is still running or for a channel that is not there, is picked up and delivered after the next start.

### Answer checks

A job can name a command, `agent.answerCheck` (or `answerCheck` in the tools), that looks at the agent's final answer while the turn can still change it. When the turn that the job's prompt started is about to close, the command runs with the answer on stdin, in the session's working directory, with a 60-second limit. Empty stdout passes the answer. Anything it prints goes back into the same turn as a message asking for a rewrite, and the agent's next answer is the one delivered. Each run is steered at most once, so a check that never passes cannot keep a turn going. Empty answers, `[SILENT]` and answers with only `MEDIA:` lines are not checked. A command that fails or times out lets the answer through.

Use it for checks that are cheap to script and costly to miss, such as the answer's language or a format the channel needs. The run log gets an `answer-check` line per check (`passed`, `steered` or `error`) and, after a rewrite, an `answer-recheck` line saying whether the delivered answer passed (`fixed` or `still-flagged`).

It works on DSH's `agent/turn-stopping` hook: a listener that steers a message there makes the agent loop run one more step in the same turn.

### Delivery channels

A delivery target is `{ via, to }`: `via` names a DSH service, `to` is an address that service understands (a chat topic, a mailbox, a webhook name; it can be empty). When a result is ready, the plugin looks the service up by name with `ctx.get(via)` and calls:

```js
await service.send({
  to,           // string: the target's address
  text,         // string: the message, may be empty when files are attached
  files,        // string[]: absolute file paths
  from: {
    job,        // string: the job's name
    sessionId,  // string, agent and gated jobs only: the session that wrote the answer
  },
})
```

The promise resolves when the message is sent and rejects with an `Error` when it is not. A rejected send is tried again twice (after 5 and 30 seconds). A service that is not running (for example while its plugin reloads or is stuck unloading) is not a failed try: the delivery waits for it, looking again every 10 seconds for up to an hour, and a restart in that time leaves it pending for the next start, which waits again. Set `retryable: false` on the error to stop the retries for a failure that will not go away, such as an unknown address. The return value is ignored. A send that still fails is recorded in the run's history and the run log; the job itself carries on.

To make a plugin a delivery channel, provide a service with that method:

```js
export function apply(ctx) {
  ctx.provide('myChannel', {
    async send({ to, text, files, from }) {
      // deliver it, or throw
    },
  })
}
```

and point a job at it with `deliver: { via: myChannel, to: <address> }`.

## Schedules

- **cron**: a cron expression, read in the job's time zone.
- **rrule**: one `DTSTART` line and one `RRULE` line, for example `DTSTART;TZID=America/Toronto:20261109T100000` and `RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261215T150000Z` (every three days at 10:00 Toronto time until mid-December). A `TZID` rule keeps local clock time across daylight-saving changes. `RRULE:FREQ=DAILY;COUNT=1` runs once. A `DTSTART` in the past is fine; runs start with the first occurrence after the job is armed. Rules are evaluated by DSH's own bounded RRULE engine ([`@deepseek-ai/dsh-util-time`](https://www.npmjs.com/package/@deepseek-ai/dsh-util-time), built on [rrule](https://github.com/jkbrzt/rrule)), the same one the built-in Schedule uses, so a rule behaves the same in both, with the same limits (no `SECONDLY`, `COUNT` at most 1000, and so on).
- **at**: one run at a fixed time.

When an RRULE or one-time schedule has no more runs, the job's state becomes **ended**. It stays listed until it is deleted (or, for config jobs, removed from the config).

## Events

A job can run when something happens instead of checking on a timer. Give it `on`, a list of channel patterns, with or without a schedule:

```yaml
- name: Mailbox
  on: [mail.me]
  cron: '0 */2 * * *'      # slow safety net in case an event is missed
  command: ./mail-gate.sh
  agent:
    prompt: Handle the new mail.
```

**Channels** are dot-separated names of letters, digits, `_`, `:` and `-`, such as `mail.me`, `ci.run.123` or `dsh.started`. In a pattern, `*` matches any characters, dots included, so `alerts.*` matches `alerts.disk` and `alerts.komodo.down`.

**Emitting an event.** The package installs a small CLI:

```sh
dsh-cron-event ci.run.123 --data '{"conclusion": "success"}'
gh run watch 123 --exit-status; dsh-cron-event ci.run.123 --data "{\"exit\": $?}"
echo '{"subject": "hi"}' | dsh-cron-event mail.me --data -
```

It writes one file into the plugin's inbox, `$DSH_HOME/cron-jobs/events/` (mode 700), and waits up to ten seconds for DSH to take it, printing the ids of the jobs it matched. No port, token or network path into DSH is needed, and an event written while DSH is down waits there and is taken at the next start. `--id <key>` drops a second event with the same channel and key within an hour; `--no-wait` returns at once; `--text` sends plain text instead of JSON. Exit code 3 means DSH did not take it in time (it stays queued). The CLI is in the profile's `node_modules/.bin`; link it somewhere on `PATH` to call it by name.

**What a run sees.** Events for one job that arrive within `events.coalesceSeconds` (30 s) of the first one are gathered, and the job runs once with all of them:

- The command gets them on stdin as one JSON document, `{"trigger": "event", "events": [{"channel", "at", "data" or "text", "key", "source"}], "dropped": 0}`, and every command gets `DSH_CRON_TRIGGER` (`schedule`, `manual` or `event`) and `DSH_CRON_JOB` in its environment. A gate still decides whether to wake the agent.
- The agent prompt gets the events appended, one JSON line each, in a block marked as untrusted data from outside DSH. An event is a hint: the job should read the truth from its source (the mailbox, the CI run), so a forged or garbled event costs one wasted run, and a message's subject never reaches the agent as an instruction.

If the job is still running when its batch is ready, it runs once more as soon as the current run ends, with every event gathered meanwhile. A scheduled tick that finds the job running is still skipped as before. At most `events.maxRunsPerHour` (6) event runs of one job start in any hour; past that, events wait and run together when the oldest of those runs is an hour old, so a stuck feed cannot start hundreds of runs. A paused, ended or disabled job ignores events. The run history and the Cron tasks page show event runs with their channels.

**`once`** (tools only) ends a job after its first run that was not started by hand. With `on: [dsh.started]` it waits for the next DSH start.

**Built-in event.** `dsh.started` is emitted once per DSH process, when the scheduler first starts (not on a plugin reload). A one-off "check DSH after the restart" job becomes `on: [dsh.started], once: true`, instead of a guessed time.

**Delivery and safety.** An inbox file is kept (as `.processing`) until every run it started has begun, so a restart in between reads it again. Events from watchers are not kept; each watcher catches up from its own cursor when it starts (below). Either way the job's slower schedule is the safety net for anything missed.

### Watchers

A watcher is a long-running command the plugin starts with the scheduler, restarts when it exits, and stops on unload. Each stdout line is an event on the watcher's channel:

- a JSON object line is the event's data, and its string `id` field, if any, is the dedupe key;
- any other non-empty line is the event's text;
- `{"wakeAgent": false}` lines are ignored.

A watcher that exits is restarted after 1 s, doubling up to 5 minutes, and back to 1 s once a run lasted a minute. If it has not managed to stay up for a minute in 15 minutes, one note goes to the row's `deliver` target, and one more when it works again; exits, stderr tails and these notes are in the run log. The command runs with `bash -c` in its own process group, with `DSH_CRON_WATCHER` (its id), `DSH_CRON_CHANNEL` and `DSH_CRON_STATE_DIR` (`$DSH_HOME/cron-jobs/watchers/<id>`, a directory for its cursor) in its environment.

Watchers come from the row's `watchers` list, or from a conversation with the `cron_job_watch` tool (`create`, `delete`, `list`), which keeps them in DSH storage. A tool-made watcher can be `once`: it runs one time and removes itself when it exits, for a one-off wait that has to survive a DSH restart:

```
cron_job_watch create id=ci-123 channel=ci.123 once=true
  command='gh run watch 123 --exit-status >/dev/null; echo "{\"exit\": $?}"'
cron_job_create title="Report CI 123" target=this_session on=["ci.123"] once=true prompt="CI run 123 finished; check it and tell me."
```

A good watcher keeps a cursor (a JMAP state string, an IMAP UIDNEXT, a feed's last message id) in `DSH_CRON_STATE_DIR`, prints one line at startup when something changed while it was down, and exits on any error or a connection that went silent, leaving the restart to the plugin. Some sources that fit:

- **JMAP mail** (RFC 8620 EventSource, served by Stalwart, Fastmail and others): stream `eventSourceUrl` with `types=EmailDelivery` and print a line per `state` push.
- **IMAP IDLE**: [goimapnotify](https://gitlab.com/shackra/goimapnotify) with `onNewMail: echo new`.
- **ntfy**: `curl -sN 'https://ntfy.sh/<topic>,<topic>/json?since=<last id>'`, printing the `message` events.

## Jobs created from a conversation

The `cron-jobs-tools` row registers five tools. Their names start with `cron_job` by default; the row's `prefix` setting changes that (`prefix: schedule` gives `schedule_create` and so on, the names of DSH's built-in Schedule tools, for use in its place).

| Tool | What it does |
|---|---|
| `cron_job_create` | Create a job: a title, a prompt and/or a command, one of `cron`, `rrule` and `at` (with `timeZone` where needed) and/or `on` (event channels), where the prompt goes, and optionally `once`, where the result is delivered and which model its sessions use. |
| `cron_job_edit` | `update` the given fields, `pause`, `resume` (continues from now), or `delete` a job by id. An empty `cron`, `rrule` or `at` removes the schedule of a job with `on`; an empty `on` removes its subscriptions. |
| `cron_job_list` | Every job, from the config and from tools, with its id, state, schedule, next run, target and last run. |
| `cron_job_view` | One job's full definition and its five latest runs. |
| `cron_job_watch` | `create`, `delete` or `list` [watchers](#watchers). |

A new job takes the calling session's working directory and agent preset, so a job created from a session in `/home/me/project` runs its command there and opens its sessions there. `cwd` sets another directory.

Where the prompt goes (`target`):

- `new` (default): a new session for every run, with the row's auto-archive and session reuse settings, like a gated config job.
- `new_once`: one new session, opened by the first run; every later run posts into it.
- `this_session`: the session that created the job, for reminders and follow-ups to the conversation. `sessionId` names another existing session instead.

`deliver` takes `<service>:<address>` (such as `telegramTopics:notify`) or `none`; the service must be running when the job is created. Left out, the job uses the row's default target, or delivers nothing when its prompt goes to an existing session. On `cron_job_edit`, an empty `deliver` goes back to the default.

`answerCheck` sets the job's [answer check](#answer-checks) command; on `cron_job_edit`, an empty string removes it.

`model` is an object, `{ "provider": "anthropic", "model": "claude-sonnet-4-5", "reasoningEffort": "high" }`, with the same ids the model picker uses; `provider` and `model` are required together and `reasoningEffort` is optional. The sessions the job opens start on that model, like `agent.model` on a config job; left out, the preset's or host default applies. `cron_job_edit` with `model` sets it on an existing job, and an empty object (`{}`) clears it. `cron_job_list` and `cron_job_view` show the model when one is set. A job that posts into an existing session (`this_session`, `sessionId`) does not open a session, so its model has no effect.

The prompt arrives as a scheduled message from the user, with the job's title and id, so the agent can look the job up or delete it when it is done. A message for an existing session is queued behind a turn that is still running. It is delivered even if the session is pinned or a person is using it, since that is what the job was created for; an archived target session is unarchived first. Target sessions are never auto-archived.

Jobs created with the tools are kept in DSH storage (see below) and survive restarts. Each one remembers its next run, so a run missed while DSH was down happens once when it starts again (only once, however many were missed). If DSH stops in the middle of a run, that run happens again at startup. Jobs from the plugin config cannot be changed with the tools; `cron_job_edit` says so instead.

A delegated subagent can use the tools, but its own session cannot be a target, since it ends with its task.

## Cron tasks page

The Web GUI gets a **Cron tasks** entry in the sidebar, laid out like DSH's own Automation tasks page:

- The list shows every job with its state (active, paused, off in config, invalid, or ended), its schedule and time zone, the next run, and the result of the last run. Jobs an agent created are marked "Created by an agent". Filter by state or search by name, command or prompt. The page refreshes every few seconds while it is visible.
- Selecting a job opens its detail. **Settings** shows the job read-only (schedule, what it does, command, directory, time limit, where the prompt goes, where the result is delivered, and for jobs with a prompt the agent preset, session directory and where it came from, auto-archive, session reuse and prompt; for jobs an agent created, when and from which session). **Runs** lists the saved runs, newest first: start time, what started it (schedule, Run now, or events with their channels), duration, exit code or other outcome, the woken session with a link that opens it, whether the session was reused, its archive state, the delivery result, and the tails of stdout and stderr.
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
  "deliver": { "via": "telegramTopics", "to": "notify" },
  "model": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
  "status": "active",
  "scheduledAt": "2026-11-09T15:00:00.000Z",
  "createdAt": "2026-11-08T17:00:00.000Z",
  "updatedAt": "2026-11-08T17:00:00.000Z",
  "createdBy": "session-0123"
}
```

`schedule` is `{ "kind": "cron", "expression", "timeZone" }`, `{ "kind": "rrule", "rrule" }` or `{ "kind": "at", "at" }` (a UTC instant); `target` is `{ "kind": "new" }`, `{ "kind": "new_once", "sessionId"? }` or `{ "kind": "session", "sessionId" }`; `status` is `active`, `paused` or `ended`; `command`, `timeoutSeconds`, `model` (`{ "provider", "model", "reasoningEffort"? }`) and `deliver` (`{ "via", "to" }` or `false`; the default when missing) are optional. `scheduledAt` is the next run.

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

1. If it failed (non-zero exit, killed, timed out, or could not start), the failure is logged (and delivered, when the job has a delivery target) and no agent is woken.
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
