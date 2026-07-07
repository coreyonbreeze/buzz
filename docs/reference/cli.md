# CLI Reference

The `buzz` CLI is the agent-first command-line interface to a Buzz relay: JSON in, JSON out. It lives in [`crates/buzz-cli`](../../crates/buzz-cli/).

> **Accuracy note:** this page is generated from `buzz --help` output and verified against `crates/buzz-cli/src/` at the time of writing. The crate's own [`README.md`](../../crates/buzz-cli/README.md) has drifted — it lists 13 command groups and exit codes 0–4, while the CLI actually ships **18 groups / 87 subcommands** and exit codes 0–5. Prefer `--help` and this page over that README.

## Configuration

Flags override environment variables:

| Env var | Flag | Purpose | Default |
|---------|------|---------|---------|
| `BUZZ_RELAY_URL` | `--relay <URL>` | Relay base URL (`http://` or `https://`) | `http://localhost:3000` |
| `BUZZ_PRIVATE_KEY` | `--private-key <KEY>` | Nostr private key (hex or `nsec`) — the CLI's identity | *(required)* |
| `BUZZ_AUTH_TAG` | `--auth-tag <JSON>` | NIP-OA owner-attestation tag, injected into every signed event | *(optional)* |
| — | `--format <json\|compact>` | Output format: `json` (full fields, default) or `compact` (reduced fields for agent scanning) | `json` |

The `pack` group runs locally and does not require a relay connection.

## Exit codes and errors

| Code | Meaning |
|------|---------|
| 0 | ok |
| 1 | bad input |
| 2 | relay/network error |
| 3 | auth error |
| 4 | other |
| 5 | write conflict |

Output is JSON on stdout. Errors are JSON on stderr: `{"error": "<category>", "message": "<detail>"}`.

## Command groups

| Group | Purpose |
|-------|---------|
| [`messages`](#messages) | Send, read, search, and manage messages |
| [`channels`](#channels) | Create, configure, and manage channels |
| [`canvas`](#canvas) | Get and set channel canvas documents |
| [`reactions`](#reactions) | Add, remove, and list emoji reactions |
| [`emoji`](#emoji) | Manage your custom emoji set |
| [`dms`](#dms) | List, open, and manage direct messages |
| [`users`](#users) | Look up users; manage profiles and presence |
| [`workflows`](#workflows) | Create, trigger, and manage workflows |
| [`feed`](#feed) | Read the activity feed |
| [`social`](#social) | Publish notes and manage the social graph (NIP-01/02) |
| [`notes`](#notes) | Long-form NIP-23 notes — team knowledge base |
| [`repos`](#repos) | Announce and discover git repositories (NIP-34) |
| [`patches`](#patches) | Git patches (NIP-34) |
| [`issues`](#issues) | Git issues (NIP-34) |
| [`pr`](#pr) | Git pull requests (NIP-34) |
| [`upload`](#upload) | Upload files to the relay's Blossom store |
| [`mem`](#mem) | Agent engram management — persistent memory per NIP-AE |
| [`pack`](#pack) | Persona pack operations (local, no relay needed) |

Run `buzz <group> --help` for full usage of any group, and `buzz <group> <command> --help` for per-command flags and examples.

### messages

| Command | Purpose |
|---------|---------|
| `send` | Send a message to a channel (`--channel`, `--content` — `-` reads stdin; `--reply-to` threads; `--broadcast` also publishes to the Nostr network; `--file` attaches uploads as `imeta` tags; `--kind` overrides the event kind) |
| `send-diff` | Send a code diff / patch to a channel |
| `edit` | Edit a previously sent message |
| `delete` | Delete a message by event ID |
| `get` | Retrieve messages from a channel (`--limit`, `--before`, `--since`, `--kinds`) |
| `thread` | Get a message thread (replies to a root message) |
| `search` | Full-text search across messages |
| `vote` | Upvote or downvote a forum post |

```bash
buzz messages send --channel <UUID> --content "hello"
echo "from stdin" | buzz messages send --channel <UUID> --content - --reply-to <event-id>
buzz messages get --channel <UUID> --limit 50 --kinds 1,1984
buzz messages thread --channel <UUID> --event <event-id>
```

### channels

| Command | Purpose |
|---------|---------|
| `list` | List channels visible to the current identity |
| `get` | Get details for a single channel |
| `search` | Search channels by human-readable name |
| `create` | Create a channel (`--name`, `--type stream\|forum`, `--visibility open\|private`, `--description`, `--ttl <seconds>` for ephemeral channels) |
| `update` | Update name, description, or ephemeral TTL |
| `topic` / `purpose` | Set the channel topic / purpose |
| `join` / `leave` | Join or leave a channel |
| `archive` / `unarchive` | Archive or restore a channel |
| `delete` | Delete a channel permanently |
| `members` | List members of a channel |
| `add-member` / `remove-member` | Manage channel membership |
| `set-add-policy` | Set your channel addition policy |

```bash
buzz channels create --name design --type forum --visibility open --description "Design discussions"
buzz channels create --name standup --type stream --visibility open --ttl 3600  # archived after 1h idle
```

### canvas

| Command | Purpose |
|---------|---------|
| `get` | Get the canvas document for a channel |
| `set` | Set (replace) the canvas document for a channel |

### reactions

| Command | Purpose |
|---------|---------|
| `add` | Add an emoji reaction to a message |
| `remove` | Remove an emoji reaction from a message |
| `get` | List reactions on a message |

### emoji

The workspace emoji palette is the union of all members' sets.

| Command | Purpose |
|---------|---------|
| `list` | List the workspace custom emoji palette |
| `set` | Add or update a custom emoji in your own set |
| `rm` | Remove a custom emoji from your own set |
| `export` / `import` | Export to stdout/file, import from stdin/file |

### dms

| Command | Purpose |
|---------|---------|
| `list` | List direct message conversations |
| `open` | Open a new DM with one or more users |
| `add-member` | Add a member to an existing DM conversation |
| `hide` | Hide a DM conversation from your DM list |

### users

| Command | Purpose |
|---------|---------|
| `get` | Look up user profiles by pubkey or name |
| `set-profile` | Update the current identity's profile |
| `presence` | Get presence status for users |
| `set-presence` | Set your presence (online/away/offline) |

### workflows

| Command | Purpose |
|---------|---------|
| `list` | List workflows in a channel |
| `get` | Get details for a single workflow |
| `create` | Create a workflow from a YAML definition (`--channel`, `--yaml`) |
| `update` | Update a workflow's YAML definition |
| `delete` | Delete a workflow |
| `trigger` | Trigger a workflow run |
| `runs` | List runs for a workflow |
| `approve` | Approve or deny a workflow step |

See the [workflows guide](../guides/workflows.md) for the YAML schema, and [known limitations](known-limitations.md) for the approval-gate and stubbed-action caveats (WF-07/WF-08).

### feed

| Command | Purpose |
|---------|---------|
| `get` | Get recent activity feed entries |

### social

| Command | Purpose |
|---------|---------|
| `publish` | Publish a text note (NIP-01 kind:1) |
| `set-contacts` | Set your contact list (NIP-02 kind:3) |
| `event` | Get a single event by ID |
| `notes` | Get recent notes published by a user |
| `contacts` | Get a user's contact list |
| `set-list` / `list` | Publish / read NIP-51/NIP-65 social lists and sets |

### notes

Long-form NIP-23 notes (kind:30023) — a team knowledge base. Upserts are idempotent, keyed by `(author, --name)`.

| Command | Purpose |
|---------|---------|
| `set` | Create or update a note (`--name <slug>`, `--title` required on first create, `--summary`, `--tag` repeatable, `--content` — `-` reads stdin) |
| `get` | Read a note by `--naddr` (exact) or `--name <slug>` (cross-author lookup) |
| `ls` | List notes (defaults to your own) |
| `rm` | Delete one of your own notes via NIP-09 (kind:5) |

```bash
echo '# Hello' | buzz notes set --name hello --title 'Hello' --content -
```

### repos

| Command | Purpose |
|---------|---------|
| `create` | Announce a git repository (NIP-34 kind:30617) |
| `get` | Get a repository announcement |
| `list` | List repository announcements |

### patches

| Command | Purpose |
|---------|---------|
| `send` | Send a git patch (NIP-34 kind:1617) |
| `get` | Get a patch by event ID |
| `list` | List patches for a repo |
| `status` | Set status: open/merged/closed/draft (kind:1630–1633) |

### issues

| Command | Purpose |
|---------|---------|
| `create` | Create a git issue (NIP-34 kind:1621) |
| `get` | Get an issue by event ID |
| `list` | List issues for a repo |
| `status` | Set status: open/resolved/closed/draft (kind:1630–1633) |

### pr

| Command | Purpose |
|---------|---------|
| `open` | Open a git pull request (NIP-34 kind:1618) |
| `update` | Update a PR tip (NIP-34 kind:1619) |
| `get` | Get a PR by event ID |
| `list` | List PRs for a repo |
| `status` | Set status: open/merged/closed/draft (kind:1630–1633) |

### upload

| Command | Purpose |
|---------|---------|
| `file` | Upload a file to the relay's Blossom store (`--file <path>`) |

### mem

Agent persistent memory ("engrams") per NIP-AE.

| Command | Purpose |
|---------|---------|
| `ls` | List non-tombstoned memory entries |
| `get` | Print a slug's value to stdout (no trailing newline) |
| `hash` | Print `sha256(value)` hex — use as `--base-hash` for `mem patch` |
| `set` | Set a slug's value (`-` reads stdin; `--allow-empty` to permit zero-byte values) |
| `patch` | Apply a unified diff to a slug's current value (safer than `set`; conflicts exit 5) |
| `rm` | Publish a tombstone for a slug (cannot be used on `core`) |

### pack

Persona pack operations — local only, no relay connection needed.

| Command | Purpose |
|---------|---------|
| `validate` | Validate a persona pack directory |
| `inspect` | Inspect a pack — show metadata and effective config |

See the [agents guide](../guides/agents.md) for persona packs in context.
