# Running a Local Relay

The fastest way to exercise the relay end-to-end: build the release binaries
once, run `buzz-relay`, and drive it with the `buzz` CLI. The CLI signs every
request with NIP-98, so you don't need `nak` or hand-rolled `curl`.

Recipes referenced below live in the [`Justfile`](../../Justfile). For the
full environment-variable table see the
[Configuration Reference](../reference/configuration.md).

The fastest way to exercise the relay end-to-end is to build the release
binaries once, run `buzz-relay`, and drive it with the `buzz` CLI. The
CLI signs every request with NIP-98, so you don't need `nak` or hand-rolled
`curl`.

## 1. Setup

```bash
. ./bin/activate-hermit          # activate pinned toolchain
cp .env.example .env             # one-time
just setup                       # start Docker services, run migrations
```

> **Already running Buzz Desktop?** Desktop uses the same Docker container
> names (`buzz-postgres`, `buzz-redis`) and the same
> default ports (`:5432`, `:6379`). `just setup` will reuse those
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

## 2. Build the binaries

```bash
cargo build --release -p buzz-relay -p buzz-cli -p buzz-admin
export PATH="$PWD/target/release:$PATH"
```

Rebuild after any code change — the steps below use the release binaries.

## 3. Start the relay

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

## 4. Smoke test the CLI against the relay

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

## 5. Going deeper

For full coverage of every CLI command (54 subcommands across 12 groups),
follow [`crates/buzz-cli/TESTING.md`](../../crates/buzz-cli/TESTING.md).

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
