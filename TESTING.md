# Testing

## Automated Tests

```bash
just test-unit          # unit tests — no infrastructure needed
just test               # unit + integration (starts Docker if needed)
```

`just test` runs unit tests plus integration tests against Postgres and Redis
(started automatically if not already running). Neither task runs the E2E suites in
`buzz-test-client` — those are marked `#[ignore]` and require a running relay:

```bash
# Start a relay first (see below), then:
cargo test -p buzz-test-client -- --ignored
```

---

## Search Backend Test Matrix

NIP-50 search runs behind the `BUZZ_SEARCH_BACKEND` flag (`typesense` |
`postgres` | `disabled`, **default `postgres`**). The relay enforces two
non-negotiable gates that must hold *identically across all three backends*:

- **Gate #1 — no visibility widening.** A search must never return an event
  the caller couldn't otherwise read. The auth/`#p` gates in `handle_req` run
  *before* the backend call, and `handle_search_req` re-applies `filters_match`
  to every hit, so the post-filter is backend-independent by construction.
- **Gate #2 — `disabled` fails closed.** With `BUZZ_SEARCH_BACKEND=disabled`,
  every NIP-50 query returns empty — no content leaks regardless of how well it
  would otherwise match.

The e2e search suite lives in
[`crates/buzz-test-client/tests/e2e_nostr_interop.rs`](crates/buzz-test-client/tests/e2e_nostr_interop.rs)
(all `#[ignore]`, require a running relay). The relay's backend is surfaced to
the test process via `BUZZ_TEST_BACKEND`; backend-specific tests early-return
(skip) when it doesn't match, so the same suite is safe against any backend.

| Test | typesense | postgres | disabled | Proves |
|------|:---------:|:--------:|:--------:|--------|
| `test_nip50_search_returns_results_and_eose` | ✅ | ✅ | skip¹ | search finds a matching message; one-shot (no live events post-EOSE) |
| `test_nip50_search_relevance_order` | ✅ | ✅ | skip¹ | rank-based ordering (proximity beats recency) |
| `test_nip50_search_cross_author_isolation` | ✅ | ✅ | skip¹ | **gate #1**: outsider gets 0 hits from a *private* channel |
| `test_nip17_gift_wrap_not_searchable` | ✅ | ✅ | skip¹ | **gate #1**: kind:1059 never surfaces via search; kind:9 control does |
| `test_nip50_search_disabled_fails_closed` | skip² | skip² | ✅ | **gate #2**: a would-match query returns empty under `disabled` |
| `test_nip50_search_empty_results` | ✅ | ✅ | ✅ | a non-matching query yields EOSE with no events |
| `test_nip50_search_mixed_filters_rejected` | ✅ | ✅ | ✅ | mixed search + non-search filters → CLOSED |
| `test_nip17_gift_wrap_accepted` / `_requires_p_filter` / `_recipient_receives` | ✅ | ✅ | ✅ | NIP-17 accept/auth paths (backend-independent) |

¹ Hit-dependent — asserts a non-empty result, so it is only run against a real
backend. ² Asserts empty — only meaningful, and only run, under `disabled`.

To exercise the matrix, launch a relay per backend (set `BUZZ_SEARCH_BACKEND`)
and run the suite with `BUZZ_TEST_BACKEND` set to match. For a real backend:

```bash
BUZZ_SEARCH_BACKEND=postgres buzz-relay &        # or typesense / disabled
RELAY_URL=ws://localhost:3000 BUZZ_TEST_BACKEND=postgres \
  cargo test -p buzz-test-client --test e2e_nostr_interop -- --ignored
```

For `disabled`, run only the fail-closed + result-independent tests — the
hit-dependent ones skip themselves, so a full `--ignored` run is also safe but
exercises fewer assertions.

---

## Live Local Relay

The fastest way to exercise the relay end-to-end is to build the release
binaries once, run `buzz-relay`, and drive it with the `buzz` CLI. The
CLI signs every request with NIP-98, so you don't need `nak` or hand-rolled
`curl`.

### 1. Setup

```bash
. ./bin/activate-hermit          # activate pinned toolchain
cp .env.example .env             # one-time
just setup                       # start Docker services, run migrations
```

> **Already running Buzz Desktop?** Desktop uses the same Docker container
> names (`buzz-postgres`, `buzz-redis`, `buzz-typesense`) and the same
> default ports (`:5432`, `:6379`, `:8108`). `just setup` will reuse those
> services, so **your test relay writes into Desktop's database**. That's
> fine for read/write smoke tests, but: `just reset` wipes Desktop's data
> along with yours. If you need isolation, stop Desktop first or run the
> dev stack on a different Compose project
> (`COMPOSE_PROJECT_NAME=buzz-dev docker compose …`).

`just reset` wipes all local data and starts over — **including Buzz
Desktop's data** if its services are sharing your dev stack (see callout
above).

> **Heads up — scrub stale env first.** If your shell inherits any of
> `BUZZ_AUTH_TAG`, `BUZZ_RELAY_URL`, or `BUZZ_PRIVATE_KEY` from a
> prior session (or a staging config), `unset` them before continuing.
> A stale `BUZZ_AUTH_TAG` fails the **local dev relay** with
> `auth_error: signature verification failed` on the first CLI write —
> it is *not* tolerated.
> ```bash
> unset BUZZ_AUTH_TAG BUZZ_RELAY_URL BUZZ_PRIVATE_KEY
> ```

### 2. Build the binaries

```bash
cargo build --release -p buzz-relay -p buzz-cli -p buzz-admin
export PATH="$PWD/target/release:$PATH"
```

Rebuild after any code change — the steps below use the release binaries.

### 3. Start the relay

In a separate terminal (it runs in the foreground):

```bash
buzz-relay                     # release binary from step 2, serves ws://localhost:3000
# alternatives:
# cargo run --release -p buzz-relay     # rebuild + run in release
# just relay                            # DEBUG build — fast to launch on a hot cache,
#                                       # but mismatched if step 2 left you on release.
#                                       # Use `just relay-release` if you want the recipe.
```

Verify it's up (back in your working terminal):

```bash
curl -s http://localhost:3000/health           # → ok
curl -s http://localhost:8080/_readiness        # → {"status":"ready"}
```

> Health/readiness/liveness live on a **separate port** (default `8080`,
> `BUZZ_HEALTH_PORT`) so K8s probes bypass auth middleware. The main app
> port also exposes `/health` for convenience.

The relay starts in dev mode (`BUZZ_REQUIRE_AUTH_TOKEN=false`). The startup
log emits a WARN about this — that's expected for local testing. See the env
vars table at the bottom if you need to lock it down.

> **Already running Buzz Desktop (or another relay) on `:3000` / `:8080` /
> `:9102`?** Buzz binds three ports — main, health, metrics — and any of
> them can collide. Use a separate terminal per role and export the right
> vars in each:
>
> **In the relay terminal** (before launching `buzz-relay`):
> ```bash
> export BUZZ_BIND_ADDR=0.0.0.0:3030
> export BUZZ_HEALTH_PORT=8088
> export BUZZ_METRICS_PORT=9202
> export RELAY_URL=ws://localhost:3030     # advertised in NIP-42 challenges
> buzz-relay
> ```
>
> **In your working / CLI terminal** (for steps 4+ and the ACP harness):
> ```bash
> export BUZZ_RELAY_URL=http://localhost:3030    # CLI target
> # verify the relay on the overridden ports:
> curl -s http://localhost:3030/health             # → ok
> curl -s http://localhost:8088/_readiness         # → {"status":"ready"}
> ```
>
> Every snippet later in this doc shows the defaults. When you see
> `localhost:3000` / `:8080` in a code block, mentally substitute your
> overrides — or the CLI will end up talking to Buzz Desktop's relay.

> **Ignore `just setup`'s "Next steps" banner.** It still prints
> `just relay` (a debug build). Use `buzz-relay` from step 2 here —
> step 2 already built the release binary.

When you're done, stop the relay (Ctrl-C in its terminal). If it's
backgrounded or you lost the terminal: `pkill -f buzz-relay`. Leaving
it running will collide with the next reviewer who follows this doc on
the same machine.

### 4. Smoke test the CLI against the relay

End-to-end: generate an identity, create a channel, post a message, read it
back. This is the minimum sequence an agent needs to verify a local relay.

```bash
# Generate a keypair
GEN=$(buzz-admin generate-key)
export BUZZ_PRIVATE_KEY=$(echo "$GEN" | awk '/Secret key:/ {print $3}')
PUBKEY=$(echo "$GEN"           | awk '/Public key:/ {print $3}')
echo "pubkey: $PUBKEY"

# Create a channel — the UUID is returned in the response
CHANNEL=$(buzz channels create --name "smoke-$$" --type stream --visibility open | jq -r '.channel_id')
echo "channel: $CHANNEL"

# Send a message and read it back
SEND=$(buzz messages send --channel "$CHANNEL" --content "hello from smoke test")
EVENT_ID=$(echo "$SEND" | jq -r '.event_id')
buzz messages get --channel "$CHANNEL" --limit 5 | jq .

# Fetch the reply chain for a specific message (empty array on a leaf — that's fine)
buzz messages thread --channel "$CHANNEL" --event "$EVENT_ID" | jq .
```

A successful run prints `{"event_id":"…","accepted":true,"message":""}` for
the send, and the message body in the `get` output. `thread` returns `[]`
for a leaf message — populated only after a reply comes in (see §5).

### 5. Going deeper

For full coverage of every CLI command (54 subcommands across 12 groups),
follow [`crates/buzz-cli/TESTING.md`](crates/buzz-cli/TESTING.md).

The relay's HTTP bridge accepts three endpoints — useful if you're testing
a client other than `buzz-cli`:

| Endpoint        | Purpose                            |
|-----------------|------------------------------------|
| `POST /events`  | Submit a signed Nostr event        |
| `POST /query`   | NIP-01 filter query (returns events) |
| `POST /count`   | NIP-45 count query                 |

All three accept NIP-98 auth (recommended) or, in dev mode, an `X-Pubkey`
header fallback. There is no REST API for fetching message threads — use
`POST /query` with an `#e` filter, or `buzz messages thread`.

---

## ACP Harness (optional, end-to-end with a real agent)

`buzz-acp` connects an ACP-speaking agent (goose, codex, claude code,
buzz-agent) to the relay. The harness listens for events, drives the
agent over stdio, and the agent replies through MCP tools.

Minimum recipe — assumes the relay from step 3 is running and the channel
`$CHANNEL` from step 4 still exists. The agent identity must be **different**
from the sender identity (`BUZZ_ACP_RESPOND_TO=anyone` still skips events
the agent signed itself).

```bash
cargo build --release -p buzz-acp
export PATH="$PWD/target/release:$PATH"

# 1. Save your sender identity from step 4 — you'll need it to @mention the agent
SENDER_SK="$BUZZ_PRIVATE_KEY"

# 2. Mint a fresh agent identity and capture its pubkey
AGENT_GEN=$(buzz-admin generate-key)
AGENT_SK=$(echo "$AGENT_GEN" | awk '/Secret key:/ {print $3}')
AGENT_PUBKEY=$(echo "$AGENT_GEN" | awk '/Public key:/ {print $3}')

# 3. Add the agent as a member of $CHANNEL — still using the sender identity.
#    Skip this and the agent boots to "discovered 0 channel(s) → agent will
#    sit idle" and silently ignores every mention.
buzz channels add-member --channel "$CHANNEL" --pubkey "$AGENT_PUBKEY" --role member

# 4. Switch to the agent identity and start it.
#    buzz-acp wants ws:// (not http://). If you set BUZZ_RELAY_URL to an
#    http:// URL in step 3, set the ws:// equivalent here — same host/port.
export BUZZ_PRIVATE_KEY="$AGENT_SK"
export BUZZ_RELAY_URL=ws://localhost:3000   # match step 3 (e.g. ws://localhost:3030 if overridden)
export BUZZ_ACP_RESPOND_TO=anyone           # default is owner-only; opens the gate for testing
# NIP-AE core-memory prompt injection is on by default; set BUZZ_ACP_NO_MEMORY=true to opt out.
export GOOSE_MODE=auto                        # must be 'auto' or goose hangs on prompts

buzz-acp                                    # foreground; logs to stdout (run in a separate terminal)

# Optional: turn on per-turn tracing if the default log is too quiet.
# RUST_LOG=buzz_acp=debug buzz-acp
```

> **Using a different ACP agent?** The default recipe assumes `goose` is on
> `$PATH` and configured (`goose --version` should print). For codex / claude
> code / buzz-agent, set `BUZZ_ACP_AGENT_COMMAND` and `BUZZ_ACP_AGENT_ARGS`
> accordingly — see `crates/buzz-acp/README.md`. Without these, buzz-acp
> will fail to spawn the agent subprocess on startup.

If you started the agent before adding it to the channel, just run the
`add-member` afterwards — it picks up the membership notification live and
subscribes without restart (`membership notification: subscribing to new channel …`).

The justfile also ships `just goose key="$AGENT_NSEC"` (foreground) and
`just goose-bg key="$AGENT_NSEC"` (background screen session) which set the
same env. See `crates/buzz-acp/README.md` for parallel agents, heartbeats,
respond-to gates, and forum subscriptions.

Send the agent a task — switch your shell back to the **sender** identity
from step 4 and @mention the agent:

```bash
export BUZZ_PRIVATE_KEY=$SENDER_SK          # the key from step 4
buzz messages send --channel "$CHANNEL" \
  --content "Hey agent, reply PONG only."

# Wait 10–90s, then read the channel — the agent's reply is a kind:9 from
# AGENT_PUBKEY. The current ACP build is quiet on stdout during a turn, so
# `buzz messages get` is how you confirm it ran.
buzz messages get --channel "$CHANNEL" --limit 5 | jq '.[] | {pubkey, content}'
```

Replies are kind:9 in the same channel; `buzz messages thread --channel <id>
--event <event_id>` fetches the reply chain for a specific mention.

---

## Configuration reference

The relay reads all configuration from environment variables. Defaults work
out of the box with `just setup` or `just relay`. Common overrides:

| Variable                          | Default                     | Notes |
|-----------------------------------|-----------------------------|-------|
| `BUZZ_BIND_ADDR`                | `0.0.0.0:3000`              | Main app port |
| `BUZZ_HEALTH_PORT`              | `8080`                      | `/_liveness`, `/_readiness` |
| `BUZZ_METRICS_PORT`             | `9102`                      | Prometheus `/metrics` |
| `RELAY_URL`                       | `ws://localhost:3000`       | Advertised in NIP-11 / NIP-42 challenges. **Note: no `BUZZ_` prefix.** |
| `DATABASE_URL`                    | `postgres://buzz:buzz_dev@localhost:5432/buzz` | |
| `REDIS_URL`                       | `redis://localhost:6379`    | |
| `TYPESENSE_URL`                   | `http://localhost:8108`     | Only used when `BUZZ_SEARCH_BACKEND=typesense` |
| `BUZZ_SEARCH_BACKEND`           | `postgres`                  | NIP-50 search backend: `typesense`, `postgres`, or `disabled` (fails closed) |
| `BUZZ_REQUIRE_AUTH_TOKEN`       | `false`                     | When true, REST requires NIP-98 (no `X-Pubkey` fallback) |
| `BUZZ_REQUIRE_RELAY_MEMBERSHIP` | `false`                     | When true, only pubkeys in `relay_members` can connect |
| `BUZZ_AUTO_MIGRATE`             | `false`                     | Opt in with `true`/`1`/`yes`/`on` to run embedded SQLx migrations on relay startup |
| `RELAY_OWNER_PUBKEY`              | unset                       | Bootstrapped as `owner` in `relay_members` at first start |
| `BUZZ_ALLOW_NIP_OA_AUTH`        | `false`                     | Enable NIP-OA owner attestation for membership |

CLI-side, only two matter for testing:

| Variable                | Default                  | Notes |
|-------------------------|--------------------------|-------|
| `BUZZ_RELAY_URL`      | `http://localhost:3000`  | CLI relay base; accepts `ws(s)://` and normalises |
| `BUZZ_PRIVATE_KEY`    | — (**required**)         | `nsec1…` or 64-char hex |
| `BUZZ_AUTH_TAG`       | unset                    | Optional NIP-OA owner attestation JSON |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `relay error 500` or `400: restricted: not a channel member` after a code change | Stale binary | Rebuild and re-export `PATH`; or `cargo run` directly |
| `Address already in use` on relay start (os error 48 on macOS, 98 on Linux) | Another relay (or stale process) holding `:3000` / `:8080` / `:9102` (or your override ports) | The panic line names the failing port — read it first. Then `lsof -iTCP:3000,8080,9102 -sTCP:LISTEN` (or your override equivalents). Kill the offender (`pkill -f buzz-relay`) or use the port-override block in step 3. If you already overrode and *still* collide, a prior reviewer left a relay running on the same alt ports — kill it or pick fresh ports |
| `auth_error: BUZZ_PRIVATE_KEY is required` | Env not exported into the CLI's shell | `export BUZZ_PRIVATE_KEY=...` (or pass `--private-key`) |
| `auth_error: BUZZ_AUTH_TAG verification failed … signature verification failed` | A stale `BUZZ_AUTH_TAG` inherited from a parent shell. The local dev relay rejects it. | `unset BUZZ_AUTH_TAG` (see the scrub block in step 1) |
| `auth-required: verification failed` on a closed relay | NIP-OA attestation needed | Set `BUZZ_AUTH_TAG` to the owner-issued JSON, or relax `BUZZ_REQUIRE_RELAY_MEMBERSHIP` |
| `channels list` empty after `channels create` | The CLI doesn't echo the channel UUID; use the filter shown in step 4 | Or `POST /query` with `{"kinds":[39002]}` |
| ACP agent ignores all events | `BUZZ_ACP_RESPOND_TO=owner-only` (default) with no owner configured | Set `BUZZ_ACP_RESPOND_TO=anyone` for testing |
| ACP logs `discovered 0 channel(s)` / `no channel subscriptions resolved` | Agent identity isn't a member of any channel | `buzz channels add-member --channel "$CHANNEL" --pubkey "$AGENT_PUBKEY" --role member` from another identity |
| `GOOSE_MODE` warning, agent hangs | Not set | `export GOOSE_MODE=auto` |
| Tests pass locally but CI fails | Forgot to run `just ci` | `just ci` runs the gate (fmt, clippy, unit tests, desktop/web builds) |
