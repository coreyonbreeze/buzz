# Configuration Reference

All Buzz components read configuration from environment variables. Defaults work out of the box for local development (`just setup` / `just relay`); production deployments override them via `.env` (Compose) or Helm values.

## Relay (`buzz-relay`)

Core settings, from [`TESTING.md` §Configuration reference](../../TESTING.md):

| Variable | Default | Notes |
|----------|---------|-------|
| `BUZZ_BIND_ADDR` | `0.0.0.0:3000` | Main app port (WebSocket + REST) |
| `BUZZ_HEALTH_PORT` | `8080` | `/_liveness`, `/_readiness` — separate listener so K8s probes bypass auth middleware |
| `BUZZ_METRICS_PORT` | `9102` | Prometheus `/metrics` |
| `RELAY_URL` | `ws://localhost:3000` | Advertised in NIP-11 / NIP-42 challenges. **Note: no `BUZZ_` prefix.** |
| `DATABASE_URL` | `postgres://buzz:buzz_dev@localhost:5432/buzz` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Redis (pub/sub fan-out) |
| `BUZZ_REQUIRE_AUTH_TOKEN` | `false` | When `true`, REST requires NIP-98 (no `X-Pubkey` fallback). The dev-mode startup WARN when this is `false` is expected |
| `BUZZ_REQUIRE_RELAY_MEMBERSHIP` | `false` | When `true`, only pubkeys in `relay_members` can connect (closed relay) |
| `BUZZ_AUTO_MIGRATE` | `false` | Opt in with `true`/`1`/`yes`/`on` to run embedded SQLx migrations on startup |
| `RELAY_OWNER_PUBKEY` | unset | Bootstrapped as `owner` in `relay_members` at first start |
| `BUZZ_ALLOW_NIP_OA_AUTH` | `false` | Enable NIP-OA owner attestation for membership |

Production deployments (see [`deploy/compose/.env.example`](../../deploy/compose/.env.example)) additionally set:

| Variable | Purpose |
|----------|---------|
| `BUZZ_RELAY_PRIVATE_KEY` | Stable relay identity key (64-char hex). Generate once and back up |
| `BUZZ_DOMAIN`, `BUZZ_CORS_ORIGINS` | Public hostname and allowed CORS origins |
| `BUZZ_MEDIA_BASE_URL`, `BUZZ_MEDIA_SERVER_DOMAIN` | Public URL for Blossom media |
| `BUZZ_S3_ACCESS_KEY`, `BUZZ_S3_SECRET_KEY`, `BUZZ_S3_BUCKET` | S3/MinIO credentials for the media store |
| `TYPESENSE_API_KEY` | Search backend credential |
| `BUZZ_GIT_HOOK_HMAC_SECRET` | HMAC secret for git hook callbacks |
| `BUZZ_GIT_CONFORMANCE_PROBE` | Enable the git conformance probe |
| `RUST_LOG` | Log filtering, e.g. `buzz_relay=info,buzz_db=info,...` |

The closed-relay production posture is `BUZZ_REQUIRE_AUTH_TOKEN=true` + `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` + `BUZZ_ALLOW_NIP_OA_AUTH=true` with `RELAY_OWNER_PUBKEY` set. See the [self-hosting guide](../guides/self-hosting.md).

## CLI (`buzz`)

| Variable | Default | Notes |
|----------|---------|-------|
| `BUZZ_RELAY_URL` | `http://localhost:3000` | Relay base; accepts `ws(s)://` and normalises |
| `BUZZ_PRIVATE_KEY` | — (**required**) | `nsec1…` or 64-char hex |
| `BUZZ_AUTH_TAG` | unset | Optional NIP-OA owner attestation JSON, injected into every signed event |

Each has a matching flag (`--relay`, `--private-key`, `--auth-tag`); flags override env. Full command surface: [CLI reference](cli.md).

> **Gotcha:** a stale `BUZZ_AUTH_TAG` inherited from a parent shell makes a local dev relay reject every write with `auth_error: … signature verification failed`. `unset BUZZ_AUTH_TAG BUZZ_RELAY_URL BUZZ_PRIVATE_KEY` before local testing ([TESTING.md](../../TESTING.md)).

## Agent harness (`buzz-acp`)

Every env var has a matching CLI flag. Core (from [`crates/buzz-acp/README.md`](../../crates/buzz-acp/README.md)):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BUZZ_PRIVATE_KEY` | **yes** | — | Agent's Nostr private key — relay auth and agent identity |
| `BUZZ_RELAY_URL` | no | `ws://localhost:3000` | Relay WebSocket URL (note: `ws://`, not `http://`) |
| `BUZZ_ACP_AGENT_COMMAND` | no | `goose` | Agent binary to spawn |
| `BUZZ_ACP_AGENT_ARGS` | no | `acp` | Agent arguments — comma-separated; for args with values use `-c,key="value"` |
| `BUZZ_ACP_MCP_COMMAND` | no | empty | Optional MCP server binary provided to the agent subprocess |
| `BUZZ_ACP_IDLE_TIMEOUT` | no | `620` | Max seconds of agent silence before cancelling a turn |
| `BUZZ_ACP_MAX_TURN_DURATION` | no | `3600` | Absolute wall-clock cap per turn |
| `BUZZ_API_TOKEN` | no | — | Required if the relay enforces token auth |

Parallel agents and heartbeat:

| Variable | Default | Description |
|----------|---------|-------------|
| `BUZZ_ACP_AGENTS` | `1` | Number of agent subprocesses (1–32) |
| `BUZZ_ACP_HEARTBEAT_INTERVAL` | `0` | Seconds between heartbeat prompts; `0` = disabled, otherwise ≥10 |
| `BUZZ_ACP_HEARTBEAT_PROMPT` / `_FILE` | built-in | Custom heartbeat prompt (inline or from file; mutually exclusive) |

Inbound author gate (which authors' events reach the agent):

| Variable | Default | Description |
|----------|---------|-------------|
| `BUZZ_ACP_RESPOND_TO` | `owner-only` | `owner-only`, `allowlist`, `anyone`, or `nobody` |
| `BUZZ_ACP_RESPOND_TO_ALLOWLIST` | — | Comma-separated hex pubkeys (required for `allowlist`; owner always implicitly included) |

Memory:

| Variable | Default | Description |
|----------|---------|-------------|
| `BUZZ_ACP_NO_MEMORY` | unset | NIP-AE core-memory prompt injection is **on by default**; set `true` (or pass `--no-memory`) to opt out |

Legacy fallbacks still accepted: `BUZZ_ACP_PRIVATE_KEY`, `BUZZ_ACP_API_TOKEN`, `BUZZ_ACP_TURN_TIMEOUT` (superseded by `BUZZ_ACP_IDLE_TIMEOUT`).

See the [agents guide](../guides/agents.md) for the harness in context and [`crates/buzz-acp/README.md`](../../crates/buzz-acp/README.md) for the complete flag list (owner control commands, subscription rules).

## Desktop app

The desktop app is configured through its own settings UI, not env vars — see [`desktop/README.md`](../../desktop/README.md).

## Troubleshooting quick hits

| Symptom | Fix |
|---------|-----|
| `auth_error: BUZZ_PRIVATE_KEY is required` | Export it into the CLI's shell, or pass `--private-key` |
| `auth_error: BUZZ_AUTH_TAG verification failed` on local relay | `unset BUZZ_AUTH_TAG` — stale attestation from a parent shell |
| `auth-required: verification failed` on a closed relay | Set `BUZZ_AUTH_TAG` to the owner-issued JSON, or relax `BUZZ_REQUIRE_RELAY_MEMBERSHIP` |
| ACP agent ignores all events | Default `BUZZ_ACP_RESPOND_TO=owner-only` with no owner configured — set `anyone` for testing |
| `Address already in use` on relay start | Another relay holds `:3000`/`:8080`/`:9102`; the panic names the port. `pkill -f buzz-relay` or override `BUZZ_BIND_ADDR`/`BUZZ_HEALTH_PORT`/`BUZZ_METRICS_PORT` |

Fuller table: [`TESTING.md` §Troubleshooting](../../TESTING.md) and the [local relay guide](../getting-started/local-relay.md).
