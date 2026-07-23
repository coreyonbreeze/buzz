# Buzz evaluation — notes for Mike

**Author:** Corey (via Claude Code, deep read of this repo + our repos)
**Date:** 2026-07-23
**Status:** parked — first pass done, decision not made yet

This folder is our working notes on whether to adopt [block/buzz](https://github.com/block/buzz) for CrossBeam. It's a fork so we can scribble in it. Everything below is grounded in the actual Rust/TS in this repo (with `file:line` cites) and Block's own open issues — not the announcement copy. Where I cite a `#NNNN`, that's a real open issue on block/buzz.

---

## TL;DR (the 6 lines for a slammed person)

1. **Your instinct is right — it's "open-source AI multiplayer."** People and agents as equal members of the same signed event log. That part is real and genuinely well-built (222k lines of Rust, formal TLA+ specs, 3,491 tests).
2. **Use it as a conversation/coordination layer, NOT as a GitHub Actions/CI replacement.** Its workflow engine can't run a command or invoke an agent (7 actions, 2 are stubs). Our whole CI/CD, Vercel, Cloud Run, nightly loops **stay exactly where they are.** Buzz sits beside them.
3. **The one thing it clearly fixes for us: the Corey↔Mike handoff.** It's the Transponder idea done right — my agent signs a message, p-tags your agent, the relay notifies it. Blocked-ask latency goes from "email he never sees" to "next time his agent wakes."
4. **Agents run on our existing Claude/Codex logins — no per-seat license, no API key required.** That's the answer to the Claude Tag economics problem: Buzz is BYO-model, you pay Anthropic directly for what you already have.
5. **On the crypto you were skeptical about:** the keypairs buy *attribution* (every action is signed + traceable), NOT *authorization* (it does not sandbox an agent — every principal gets full scope). Good to know going in so we don't over-trust it.
6. **It's 4.5 months old, announced the day before I looked at it, ~20 contributors all Block.** Real breaking-change and ops risk. So: try it on a side surface, host the relay on our GCP, don't bet the shipping pipeline on it yet.

**Recommendation: worth a time-boxed trial for the handoff use case. Don't migrate anything.**

---

## What it actually is

A self-hostable [Nostr](https://github.com/nostr-protocol/nostr) relay where every message, reaction, patch, PR, review, workflow step, and approval is a **signed event in one Postgres table**. Humans and agents both get their own keypair and the same command surface. Ships with a Tauri desktop app (Slack-like), a web client, and Flutter mobile (early). Apache 2.0, no CLA.

The pitch is "one context instead of seven tabs" — chat + forge + CI + search + audit in one substrate. The reality is that the **chat + identity + audit + git-forge** parts are real, and the **CI + approval-gate + agent-scoping** parts are aspirational or stubbed. See the honest breakdown below.

---

## The verdict, by claim (what held up under a code read)

| Claim from the announcement | Reality in the code |
|---|---|
| "A feature branch becomes a channel; patches, CI, review, merge live in one thread" | Git forge is real (Smart-HTTP + object storage + a Tauri PR/diff/approve UI, ~15k LOC, behind a `projects` preview flag). **But there is no CI** — no push trigger, no check-run concept. And `canMerge` never consults approvals; only the repo-announcing key can merge. |
| "Agents search six months of history" | Search is Postgres FTS on `to_tsvector('simple', content)` — **no stemming** ("permit" misses "permits"), capped at 100 hits, no pagination. Code-review notes and git blobs aren't in the index. It's keyword search over message bodies, not semantic recall. |
| "An agent is an equal member with its own keys and audit trail" | **True for attribution.** Each agent = its own secp256k1 keypair, actions signed + traceable. |
| "…scoped by identity, not permission flags" | **False for authorization.** Every authenticated principal (human or agent) gets `Scope::all_known()` (`buzz-auth/src/lib.rs:134`). Read access = your channels ∪ *every open channel*. ACP defaults to `bypass-permissions` and auto-approves every permission request. The crypto is provenance, not a sandbox. |
| "YAML workflows with approval gates" | 7 actions total (`buzz-workflow/src/schema.rs:92`): send_message, send_dm, set_channel_topic, add_reaction, call_webhook, request_approval, delay. `send_dm` + `set_channel_topic` return `NotImplemented`. `request_approval` marks the run **Failed** (approval gates not wired — ARCHITECTURE.md §9). Working set = send_message + call_webhook + delay. It's Slack Workflow Builder with cron, not CI. |
| "Self-sovereign, run your own relay" | Real, and cheaper than it looks — see hosting notes. But ops is hands-on: migrations were edited in-place post-ship so upgrades can brick a DB (#2472); a partition roller is documented as "cron" with no cron (#2396); git GC was merged then reverted so object storage grows forever; backups are a shell script that prints a checklist. |

---

## How we'd use it (the actual fit)

**Replace Transponder with a Buzz channel.** Our cross-agent delegation system worked (19 of 31 delegations resolved) but died because it lived in a repo we stopped opening, with ~12 delegations still open. Buzz maps onto it cleanly:

- delegation entry → a thread in a `#corey-mike` channel, `@`-tagging the other's agent (the relay actually notifies)
- Transponder status line → `buzz feed get --types needs_action` (a real, durable, server-side query)
- status transitions → signed, timestamped replies + reactions
- separate the **digests** (weekly reports, lead approvals, warmup pings) into a `#feed` channel with no agent, so `needs_action` stays a real queue instead of inbox archaeology

**What it fixes that email doesn't:** blocking asks and bot digests currently land in the same inbox and look identical, so the asks get buried. Splitting channels + agent notification is the whole win.

**What it does NOT fix:** if only one person can grant a Supabase permission, Buzz shortens the queue — it doesn't delegate the credential. That's a separate decision.

---

## Agents: how they run, what they cost

- Buzz **does not inject a model credential** for Claude Code or Codex. It spawns the ACP adapter (`claude-agent-acp` / `codex-acp`), which wraps the CLI **already logged in on that machine.** `provider_locked: true` for Claude precisely because Claude Code owns its own auth (`managed_agents/discovery.rs:98`). Whatever your CLI is logged into (Pro/Max subscription **or** an API key) is what the agent bills to.
- **So: no per-seat license, no new API key required.** This is the direct answer to why Claude Tag economics didn't work for us — Tag is per-seat; Buzz is BYO-model.
- Goose and Block's own `buzz-agent` runtime *do* need provider keys; Claude Code and Codex don't.
- **Cost model is per-triggered-turn, not idle.** The harness uses a persistent WebSocket + a **lazy LLM pool** — the Claude process isn't spawned until an event passes your filter (`pool_lifecycle.rs`, "warm sockets, lazy LLM pool" #2122). A loud channel with no matching events costs nothing. Filters (`--respond-to owner-only` default + evalexpr rules) run *before* the model wakes.

---

## The laptop question (this is the setup we landed on)

We do **not** want an always-on cloud agent. Target: relay always-on; each of our agents lives on our own laptop; when we reopen, the agent catches up.

- **Relay → host on our GCP (Onbreeze project), always-on.** It's just a server. Close either laptop and it stays up with full history. Both install the desktop app and point at `wss://relay.getonbreeze.com`. (Needs a stable hostname + TLS — the relay derives the workspace from the HTTP Host header, so pin ONE hostname everywhere. See `hosting-plan.md`.)
- **Agents → on our laptops, off overnight, no cloud cost.** When Mike closes the lid his agent is done for the day. That's fine.
- **Catch-up on reopen → works, with one config flag.** The "what did I miss" list is durable server-side (relay computes `feed needs_action` from Postgres — it doesn't care that the agent was offline). The ACP base prompt tells a booting agent to run `buzz feed get` and sweep the backlog. The gap: a lazy agent only wakes on a *new* event, so if nothing new is posted it may sit idle on the backlog (open #1743). **Fix: set `--heartbeat-interval` (default off)** so the agent wakes itself on a timer and drains the backlog reliably. That's the knob that makes "open laptop → agent catches up" dependable.

---

## Setup effort (measured, not guessed)

I actually stood the relay up locally end-to-end (posted + read a message through the CLI) and tore it down.

- Hermit pulls the entire pinned toolchain in **53 seconds**, zero prompts.
- `docker compose up` cold: **4m17s**. `cargo check -p buzz-cli` cold: **46s**.
- **Zero external accounts for the relay** — no SMTP, no push, no cloud S3 (local MinIO), no LLM key. Of 233 lines in `.env.example`, 12 are live and all have localhost defaults.
- Headless relay + CLI + one agent posting: **45–75 minutes.** The 260KB of top-level markdown + 7 VISION docs make it look far scarier than it is — almost none of it is required reading.
- Real traps (all nameable): the `owner-only` ACP gate silently drops every event until an owner is registered — use `--respond-to anyone` for a 2-person relay; a doc'd `buzz-admin mint-token` command that doesn't exist (use `generate-key`); a broken keycloak healthcheck that makes `docker compose up --wait` exit 1 on a stack that's actually fine.

---

## Real risks (Block's own open issues)

- **#2444** (open vs current release): desktop spawns agents at `ws://127.0.0.1:3000` while the community is `ws://localhost:3000`; host-header tenancy makes those two isolated worlds — agents online, zero channels, no error. *Pin one hostname from the start.*
- **#2412**: closing the desktop window (X, not minimize) kills the app and every child agent process. No tray mode.
- **#2472**: shipped migrations edited in place → sqlx checksum refuses to start → one deployer dropped their schema. *Pin the relay image version; never float `:main`.*
- **#2396**: partition roller documented as cron with no cron; staging dumped 43% of events into a catch-all partition.
- **#1743**: @mentions silently lost when target agent is offline (the catch-up gap — mitigated by `--heartbeat-interval`).
- **#2526**: bold-wrapped `**@Name**` sends zero p-tags → no notification. *Convention: plain `@Name`, never formatted.*
- No desktop auto-updater (`"updater": {"endpoints": []}`) with ~23 releases in 8 days → manual reinstall on both machines.

---

## Worth stealing even if we never adopt Buzz

Ranked by value/effort. These drop into our existing stack.

1. **`crates/buzz-acp/src/base_prompt.md`** (133 lines) — the best artifact in the repo. Publish-or-it-didn't-happen doctrine, a banned-acknowledgement list, mandatory callback `@mention` on completed delegated work. Drops into our agent prompts unchanged.
2. **Owner-reviewed drafts.** An agent can't create an agent — it opens a draft the human saves, and is *required* to report "ready for review, never created." Generalize our `letter_versions` table (already has the one-open-proposal trick) into `agent_proposals` so reviewer-loop ACT mode stops being PR-or-drop.
3. **Token budgets from `buzz-dev-mcp/src/shell.rs`** — `MAX_BYTES 50KB`, 8KB tail, spill-to-artifact, `truncated:true` flag so the model *knows* it was cut. Our 8 MCP tools return whatever Supabase returns.
4. **`ln -s AGENTS.md CLAUDE.md`** + share one skill tree across `.claude`/`.agents`/`.codex` so a Codex session sees our real skills, not 12 unrelated ones. 15 minutes.
5. **The screenshot hash gate** — `shasum` every PR screenshot; identical hashes fail the check. They built it because agents posted byte-identical screenshots as "proof."

---

## Open questions for when we pick this back up

- Has *anyone* outside Block self-hosted this successfully? (No public evidence either way.)
- Does Block run the OSS relay, or only their internal pre-wired build?
- Do we want an always-on Claude Code agent turn-per-mention against a *subscription*, or is that a case for API/Vertex billing? (I'm on GCP so Vertex is the clean headless path if we ever move an agent server-side.)
- Trigger to re-evaluate seriously: a third human joins, OR Block ships a pinned relay release with a tested upgrade path + server-side agent hosting.

---

## Files in this folder

- `README.md` — this doc
- `hosting-plan.md` — concrete GCP setup for the always-on relay + laptop agents
- `try-it-in-an-afternoon.md` — the shortest path to seeing it work, if you want to poke at it
