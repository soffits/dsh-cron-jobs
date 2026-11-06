# dsh-cron-jobs

Cron-scheduled shell commands for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

DSH's built-in Schedule delivers a prompt to an agent session, so every tick starts a model turn. That is wasteful for jobs that are only a script, or for a check that usually finds nothing. This plugin runs commands on a cron schedule inside the DSH Host process, so jobs start and stop with DSH and never touch a model. A job can also act as a gate: its command runs first, and a new agent session is opened only when the command's output says there is something to do.

## Install

Clone the repository, install its dependencies, and install the directory as a bundle:

```sh
git clone https://github.com/soffits/dsh-cron-jobs.git
cd dsh-cron-jobs
npm install
```

Then ask the agent to install it, or call the plugin manager yourself:

```
plugin_manager install_bundle /absolute/path/to/dsh-cron-jobs
```

Built and tested against DSH 0.2.2-rc.1 (`engines.dsh` is `>=0.2.2-rc.1 <0.3.0-0`). Commands run with `bash -c`, or `sh -c` when bash is missing, so the Host needs a POSIX shell.

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
| `agent.cwd` | Working directory of the new session. The job's `cwd`, then the Host default, when empty. |

## How runs work

- One run of a job at a time: if a tick arrives while the previous run is still going, the tick is skipped and logged.
- Start, exit status, duration and a short tail of stdout and stderr go to the DSH log under `cron-jobs`. Delivering the output anywhere else is the command's job.
- Set `runLog` (next to `jobs`) to a file path to also keep that record as JSON Lines: one `start` line per run, one `end` line with `status`, `outcome`, `exitCode`, `durationMs` and the output tails, and a `skipped` line for a skipped tick. A `start` with no `end` means DSH stopped during the run. The file is only appended to; rotate it yourself if it grows.
- Ticks missed while DSH is down are not caught up; the next tick runs normally.
- Unloading the plugin (stopping DSH or changing its config) stops the timers and terminates running commands.

## Wake rule for gated jobs

After the command finishes:

1. If it failed (non-zero exit, killed, timed out, or could not start), the failure is logged and no agent is woken.
2. If stdout is empty or only whitespace, no agent is woken.
3. If the last non-empty line of stdout is a JSON object whose `wakeAgent` is exactly `false`, such as `{"wakeAgent": false}`, no agent is woken. This is the gate convention of Hermes Agent cron jobs, so existing gate scripts work unchanged. Any other value, a missing key, or a non-JSON last line wakes.
4. Otherwise a new session is opened with the job's preset and directory, titled `<job name> · <YYYY-MM-DD HH:mm>` in the job's time zone, and sent the prompt followed by the command's stdout in a labelled block. The message is marked as a scheduled message, so the Web GUI shows it like a scheduled run.

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
