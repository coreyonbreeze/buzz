# Workflows

YAML-as-code automation, scoped to a channel. A workflow is a trigger plus a
list of steps; every run is recorded as workflow execution events
(kinds 46001–46012) with a full trace. Engine:
[`crates/buzz-workflow`](../../crates/buzz-workflow).

## Workflow model

```yaml
name: "Incident Triage"
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message
    text: "P1 incident detected: {{trigger.text}}"
  - id: page
    if: "str_contains(trigger_text, 'production')"
    action: request_approval
    from: "{{trigger.author}}"
    message: "Page on-call?"
```

Triggers are internally tagged on `on:`; actions on `action:`. Each step has a
unique `id` (alphanumeric + underscore, ≤64 chars — step IDs become evalexpr
variable names), an optional `if:` condition (step is *skipped*, not failed,
when false), and an optional `timeout_secs`.

Manage workflows with the CLI: `buzz workflows create / list / get / update /
delete / trigger / runs / approve`.

## Triggers (5)

| Trigger | Fires when | Options |
|---|---|---|
| `message_posted` | Any message posted in the workflow's channel | `filter:` evalexpr expression |
| `reaction_added` | An emoji reaction is added | `emoji:` limit to one emoji |
| `diff_posted` | A diff message (kind:40008) is posted | `filter:` as above |
| `schedule` | Cron expression or simple interval (UTC) | `cron:` **or** `interval:` (e.g. `"1h"`) — exactly one |
| `webhook` | HTTP POST arrives at `/hooks/{id}` | secret-authenticated |

(Source: `TriggerDef` in
[`crates/buzz-workflow/src/schema.rs`](../../crates/buzz-workflow/src/schema.rs).)

The cron scheduler ticks every 60 seconds and evaluates expressions with
window-based matching.

## Actions (7)

| Action | Description | Status |
|--------|-------------|:------:|
| `send_message` | Post to the workflow's channel (or `channel:` override) | ✅ |
| `send_dm` | Direct message a user (`to:` pubkey hex or `{{trigger.author}}`) | ❌ returns `NotImplemented` (WF-07) |
| `set_channel_topic` | Update channel topic | ❌ returns `NotImplemented` (WF-07) |
| `add_reaction` | React to the trigger message | ✅ |
| `call_webhook` | HTTP POST to an external URL — SSRF-protected, redirects disabled, 1 MiB response cap | ✅ |
| `request_approval` | Suspend and wait for approval (`from:`, `message:`, `timeout:` default 24h) | ⚠️ not wired end-to-end (WF-08) |
| `delay` | Pause execution (`duration:`, max 300 seconds) | ✅ |

## Templates and variables

- `{{trigger.text}}`, `{{trigger.author}}`, `{{steps.ID.output.FIELD}}`
- Single-pass resolution — templates are not recursive; unknown variables are
  left as literal text.

`filter:` / `if:` conditions use [evalexpr] with dot-notation converted to
underscores (`trigger.text` → `trigger_text`). Registered helper functions:
`str_contains`, `str_starts_with`, `str_ends_with`, `str_len`. Evaluation has
a 100 ms timeout.

[evalexpr]: https://docs.rs/evalexpr

## Approval gates

`request_approval` is designed to suspend a run and resume it after a
signed-off approval (`buzz workflows approve --token <uuid>`), with approval
tokens stored as SHA-256 hashes and single-use enforcement.

> ⚠️ **Current status (WF-08):** the executor returns `Suspended` and the
> relay has grant/deny endpoints with DB CRUD, but the engine does not yet
> persist the token or resume execution — **runs that hit an approval gate
> are marked as failed.** Track this in
> [Known Limitations](../reference/known-limitations.md).

## Concurrency and loop prevention

- 100 concurrent runs (semaphore); at capacity a new trigger returns
  `CapacityExceeded` immediately rather than queuing.
- Workflow execution kinds (46001–46012), relay-signed messages tagged
  `buzz:workflow`, and gift wraps never trigger workflows — no self-loops.

## Known limitations

See [Known Limitations](../reference/known-limitations.md) — in short:
`send_dm` / `set_channel_topic` are schema-only stubs (WF-07), and approval
gates fail rather than suspend (WF-08).

> Note: ARCHITECTURE.md §buzz-workflow says "4 trigger types"; the code has 5
> (`diff_posted` was added, and `schedule` gained `interval:`). This page
> follows the code.
