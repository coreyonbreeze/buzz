# Crate Reference

The Buzz workspace is a set of focused Rust crates. The relay is the single
source of truth: `buzz-relay` orchestrates every subsystem, and subsystems
never call each other directly. The full member list is in the workspace
[`Cargo.toml`](../../Cargo.toml) (24 crates plus the `countdown-bot` example).

## buzz-core — Shared Types and Verification

**Zero I/O.** The foundation every other crate builds on. Explicitly prohibits tokio, sqlx, redis, and axum in its `Cargo.toml`.

**Key types:**

```rust
pub struct StoredEvent {
    pub event: nostr::Event,
    pub received_at: DateTime<Utc>,
    pub channel_id: Option<Uuid>,
    verified: bool,          // private — use is_verified()
}

pub const ALL_KINDS: &[u32]  // 80 entries (KIND_AUTH excluded — never stored)
```

**Key functions:**

| Function | Purpose |
|----------|---------|
| `filters_match(filters, event)` | OR across filters, AND within each filter. Includes NIP-01 prefix matching on event IDs. |
| `verify_event(event)` | Schnorr signature + SHA-256 ID check. CPU-bound — callers use `spawn_blocking`. |
| `is_private_ip(ip)` | SSRF protection: IPv4 unspecified/loopback/private/link-local/CGNAT/benchmarking/broadcast + IPv6 loopback/ULA/link-local/multicast/documentation + IPv4-mapped IPv6. |

**Does NOT:** store events, make network calls, spawn tasks, or depend on any async runtime.

---

## buzz-auth — Authentication and Authorization

Handles authentication paths, scope enforcement, and token operations.

**Auth paths:**

| Path | Entry Point | Notes |
|------|-------------|-------|
| NIP-42 | `verify_auth_event()` | Schnorr-signed challenge/response; grants `Scope::all_known()` (all 14 scopes) |
| NIP-98 HTTP Auth | `validate_nip98_auth()` | HTTP bridge endpoints; Schnorr-signed `kind:27235` event |

**Key types:**

```rust
pub struct AuthContext { pub pubkey: PublicKey, pub scopes: Vec<Scope>, pub auth_method: AuthMethod }
pub enum AuthMethod { Nip42, Nip98 }
pub enum Scope { MessagesRead, MessagesWrite, ChannelsRead, ChannelsWrite,
                 AdminChannels, UsersRead, UsersWrite, AdminUsers,
                 JobsRead, JobsWrite, SubscriptionsRead, SubscriptionsWrite,
                 FilesRead, FilesWrite, Unknown(String) }
pub trait ChannelAccessChecker: Send + Sync { ... }
pub trait RateLimiter: Send + Sync { ... }
```

**Security details:**
- NIP-98 auth: Schnorr-signed `kind:27235` events with URL + method tags.
- NIP-42 timestamp tolerance: ±60 seconds.
- Dev-only key derivation: `SHA-256("buzz-test-key:{username}")` — gated behind `#[cfg(any(test, feature = "dev"))]`. The `dev` feature must not be enabled in production relay deployments.

**Does NOT:** implement `RateLimiter` beyond a test stub (`AlwaysAllowRateLimiter`, gated behind `#[cfg(any(test, feature = "test-utils"))]`). No Redis-backed rate limiter exists anywhere in the codebase — rate limiting is not currently enforced. `RateLimitConfig` defines 4 tiers (human, agent-standard, agent-elevated, agent-platform) as a design target.

---

## buzz-db — Postgres Event Store

All database access. Uses `sqlx::query()` (runtime, not compile-time macros) — no `.sqlx/` offline cache required.

**Key operations:**

| Module | Responsibility |
|--------|---------------|
| `event.rs` | `insert_event` (ON CONFLICT DO NOTHING), `query_events` (QueryBuilder), `get_event_by_id` |
| `channel.rs` | Channel CRUD, membership management, role enforcement (transactional) |
| `feed.rs` | `query_mentions` (INNER JOIN event_mentions), `query_needs_action`, `query_activity` |
| `workflow.rs` | Full workflow/run/approval CRUD; SHA-256 hashed approval tokens |
| `partition.rs` | Monthly range partitioning for `events` and `delivery_log` tables |
| `dm.rs` | DM channel management |
| `reaction.rs` | Reaction storage and retrieval |
| `thread.rs` | Thread/reply tracking |
| `user.rs` | User profile storage |
| `error.rs` | Database error types |

**Channel types:** `Stream`, `Forum`, `Dm`, `Workflow`  
**Member roles:** `Owner`, `Admin`, `Member`, `Guest`, `Bot`  
**Workflow statuses:** `Active`, `Disabled`, `Archived`  
**Run statuses:** `Pending`, `Running`, `WaitingApproval`, `Completed`, `Failed`, `Cancelled`

**Key behaviors:**
- `ON CONFLICT DO NOTHING` for event dedup — returns `(StoredEvent, was_inserted: bool)`.
- Rejects `KIND_AUTH` (22242) and ephemeral (20000–29999) with distinct error variants.
- Transactional role enforcement in `add_member`/`remove_member`/`create_channel` — TOCTOU-safe.
- Soft-delete for channel members: `remove_member` sets `removed_at`; re-adding reverses it.
- Feed hard cap: `FEED_MAX_LIMIT = 100` rows regardless of caller-requested limit.
- `query_mentions` uses `INNER JOIN event_mentions` — normalized table with composite index on `(pubkey_hex, created_at)`.
- Approval tokens: `create_approval` receives the raw token and hashes it internally with SHA-256.
- DDL injection protection in partition manager: allowlist of table names + strict suffix/date validators.

**Does NOT:** cache queries, implement connection pooling logic (delegated to sqlx), or make network calls outside Postgres.

---

## buzz-pubsub — Redis Pub/Sub, Presence, Typing

Manages Redis pub/sub fan-out, presence tracking, and typing indicators. In multi-community mode all tenant-visible keys are prefixed or otherwise partitioned by community (`buzz:{community}:...`) so channel fan-out, presence, typing, and cache invalidation cannot cross hosts.

**Architecture:**

```
Publisher  → pool connection   → PUBLISH buzz:channel:{uuid}
Subscriber → dedicated PubSub  → PSUBSCRIBE buzz:channel:*
                                  → broadcast::channel(4096)
```

The subscriber uses a **dedicated** `redis::aio::PubSub` connection — not from the pool. This is intentional: pool connections cannot hold `PSUBSCRIBE` state.

**Current state:** The subscriber loop is spawned in `buzz-relay/src/main.rs` and populates the broadcast channel. A consumer task subscribes via `pubsub.subscribe_local()`, calls `sub_registry.fan_out()` on each received event, and delivers matches to local WebSocket connections via `conn_manager.send_to()`. Multi-node fan-out is now wired end-to-end. Local-echo deduplication is implemented via `AppState.local_event_ids` — events published by the local relay instance are tracked and skipped when received via the Redis round-trip.

**Reconnection:** exponential backoff 1s → 30s (`backoff_secs * 2`). Backoff resets to 1s only after a clean stream end, not on each reconnect attempt.

**Presence:** `SET buzz:presence:{pubkey_hex} {status} EX 90` — 90-second TTL (3× the 30-second heartbeat interval). Single missed heartbeat does not cause presence flap.

**Typing indicators:**
```
ZADD buzz:typing:{channel_id} {now_unix} {pubkey_hex}
ZREMRANGEBYSCORE buzz:typing:{channel_id} -inf {now - 5.0}
EXPIRE buzz:typing:{channel_id} 60
```
5-second activity window. 60-second key TTL prevents orphaned empty sets.

**Does NOT:** implement the rate limiter. Does NOT store events. `PubSubManager` is not `Clone` — callers use `Arc<PubSubManager>`.

---

## buzz-search — Postgres FTS Integration

Full-text search via Postgres FTS. Events are searchable through the
`events.search_tsv` generated `tsvector` column (populated on insert, indexed
by a GIN index) — there is no separate search service or out-of-band indexer.
Privacy-sensitive kinds are excluded at the storage level (the `search_tsv`
`CASE WHEN kind IN (...)` yields `NULL`, which never matches `@@`). In
multi-community mode every query filter includes `community_id`, so the shared
`events` table is infrastructure, not a cross-community result space; the relay
re-authorizes every candidate hit before returning it.

**Key behaviors:**
- `SearchService::new(pool)` wraps a `PgPool`; `search(&SearchQuery)` runs a
  parameterized FTS query against the `events.search_tsv` GIN index and returns
  `SearchResult` (candidate `SearchHit`s).
- `ChannelScope` makes the channel constraint explicit (`Any` /
  `ChannelLessOnly` / `Channels` / `ChannelsOrChannelLess`), closing the
  ambiguity the old `Option<Vec<Uuid>> + bool` matrix could not express.
- Every query carries `community_id`; the FTS predicate is BitmapAnd-ed with
  the community-leading btree filters so a query never crosses tenants.
- Permission filtering is **caller's responsibility** — `buzz-search` returns
  candidate hits; the relay re-authorizes each one (channel membership, `#p`,
  owner gates) before delivering it.

**Does NOT:** enforce channel membership or access control. Does NOT write
events (indexing is the `search_tsv` generated column on the `events` insert).

---

## buzz-audit — Hash-Chain Audit Log

Tamper-evident append-only log with SHA-256 hash chaining.

**Hash chain:** each entry stores `prev_hash` (hash of the previous entry). In multi-community mode audit heads/chains are per-community; operator metrics may aggregate, but tenant-readable audit verification walks one community chain. `verify_chain()` walks entries and recomputes hashes to detect tampering. Genesis entry uses `GENESIS_HASH` (64 zeros).

**Hash covers:** seq (big-endian bytes), timestamp (RFC3339), event_id, event_kind (big-endian), actor_pubkey, action string, channel_id (16 bytes or 16 zero bytes if None), canonical metadata JSON (BTreeMap for deterministic key ordering), prev_hash.

**Single-writer guarantee:** `pg_advisory_lock` before each transaction. Lock released in all branches including panic (`catch_unwind`).

**10 audit actions:** `EventCreated`, `EventDeleted`, `ChannelCreated`, `ChannelUpdated`, `ChannelDeleted`, `MemberAdded`, `MemberRemoved`, `AuthSuccess`, `AuthFailure`, `RateLimitExceeded`.

**Does NOT:** log `KIND_AUTH` (22242) events — returns `AuditError::AuthEventForbidden` immediately. Does NOT log ephemeral events (they never reach the audit pipeline).

---

## buzz-workflow — YAML-as-Code Automation Engine

Parses, validates, and executes channel-scoped workflow definitions. In multi-community mode workflow definitions, runs, approvals, webhook routes, and schedules inherit the host-derived community and evaluate triggers only against events in that community.

**Workflow definition structure:**
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

Note: Both `TriggerDef` and `ActionDef` use serde internally-tagged enums. Triggers use `on:` as the tag field; actions use `action:` as the tag field. Fields are flattened into the parent struct, not nested.

**5 trigger types:** `message_posted`, `reaction_added`, `diff_posted`, `schedule` (cron or interval), `webhook` — see [Workflows](../guides/workflows.md)

**7 action types:**

| Action | Description |
|--------|-------------|
| `send_message` | Post to the workflow's channel (or override channel) |
| `send_dm` | Direct message to a user (pubkey hex or `{{trigger.author}}`) |
| `set_channel_topic` | Update channel topic |
| `add_reaction` | React to the trigger message |
| `call_webhook` | HTTP POST to external URL (SSRF-protected, redirects disabled, 1 MiB response cap) |
| `request_approval` | Suspend execution; fields: `from`, `message`, `timeout` (default 24h) |
| `delay` | Pause execution (max 300 seconds) |

**Template variables:** `{{trigger.text}}`, `{{trigger.author}}`, `{{steps.ID.output.FIELD}}`. Single-pass resolution (not recursive). Unknown variables left as literal text.

**Condition evaluation:** `evalexpr` with `HashMapContext`. Dot notation converted to underscores (`trigger.text` → `trigger_text`). Custom functions registered: `str_contains`, `str_starts_with`, `str_ends_with`, `str_len`. 100ms timeout prevents adversarial expressions from blocking.

**Concurrency:** `Arc<Semaphore>` with 100 permits. `try_acquire()` — returns `CapacityExceeded` immediately rather than queuing.

**Approval gates:** `request_approval` action returns `StepResult::Suspended` with a generated UUID token, but the engine does not yet persist the token or resume execution — runs that hit an approval gate are marked as failed (🚧 WF-08). `execute_from_step()` exists for future resumption support.

**Cron scheduler:** loop ticks every 60 seconds, evaluates cron expressions with window-based matching, and creates workflow runs for matched triggers. Fully implemented.

**Does NOT:** recursively resolve templates (single-pass only). Does NOT queue workflow runs when at capacity — returns `CapacityExceeded` immediately.

---

## Huddle Audio — WebSocket Opus Relay

Real-time voice lives inside `buzz-relay` (`src/audio/`), not a separate crate. A WebSocket endpoint (`wss://.../huddle/{channel_id}/audio`) authenticates each participant with a NIP-42 challenge, checks channel membership, admits them to an in-memory room, and forwards opaque Opus frames between peers. No external SFU.

**Frame protocol (v2):** 8-byte big-endian header (sequence `u16`, 48 kHz timestamp `u32`, level dBov `i8`, flags `u8`) followed by an opaque Opus payload. Invalid `level_dbov` values are clamped rather than dropped — losing a metric beats losing audio.

**Room state:** an admission guard synchronizes joins against the room's ended flag; soft cap 25 peers (hard cap 255 via `u8` peer index). Per-peer audio uses a bounded channel (drop-on-full); the control channel is separate and never drops join/leave.

**Lifecycle events:** the relay emits Nostr events for participant joined / left and huddle ended; the desktop client emits huddle started and guidelines. When the last peer leaves, the room ends and the channel archives atomically.

**Not yet built:** recording and per-track publishing (the corresponding kinds are reserved, no producer exists).

---

## buzz-relay — The Server

Axum WebSocket server. Ties all other crates together. The only crate that imports and orchestrates all subsystems.

**`AppState`** (Arc-wrapped, shared across all connections — key fields shown, not exhaustive):

```rust
pub struct AppState {
    pub db: Db,
    pub audit: Arc<AuditService>,
    pub pubsub: Arc<PubSubManager>,
    pub auth: Arc<AuthService>,
    pub search: Arc<SearchService>,
    pub sub_registry: Arc<SubscriptionRegistry>,
    pub conn_manager: Arc<ConnectionManager>,
    pub workflow_engine: Arc<WorkflowEngine>,
    pub conn_semaphore: Arc<Semaphore>,       // connection limit
    pub handler_semaphore: Arc<Semaphore>,    // 1024 concurrent handlers
    pub relay_keypair: nostr::Keys,           // relay identity
    pub local_event_ids: moka::sync::Cache,   // local-echo dedup
    pub search_index_tx: mpsc::Sender,        // bounded search worker queue
    // + config, redis_pool, membership_cache, media_storage, shutdown state
}
```

**`ConnectionState`** (per-connection):

```rust
pub struct ConnectionState {
    pub auth_state: RwLock<AuthState>,
    pub subscriptions: Mutex<HashMap<String, Vec<Filter>>>,
    // + send_tx, cancel token
}
pub enum AuthState { Pending { challenge: String }, Authenticated(AuthContext), Failed }
```

**HTTP endpoints:**

| Method | Path | Handler |
|--------|------|---------|
| GET | `/` | WebSocket upgrade or NIP-11 relay info |
| GET | `/info` | NIP-11 relay info |
| GET | `/.well-known/nostr.json` | NIP-05 identity |
| GET | `/health` | Health check |
| GET | `/_liveness` | Liveness probe |
| GET | `/_readiness` | Readiness probe |
| POST | `/events` | Submit a signed Nostr event over HTTP (same ingest path as WebSocket `EVENT`) |
| POST | `/query` | Query Nostr events over HTTP with NIP-01 filters |
| POST | `/count` | Count Nostr events over HTTP with NIP-45 filters |
| POST | `/hooks/{id}` | Workflow webhook trigger (secret-authenticated) |
| PUT | `/media/upload` | Upload media blob (Blossom, 50 MB limit) |
| GET/HEAD | `/media/{sha256_ext}` | Retrieve/probe media blob |
| GET | `/git/{owner}/{repo}/info/refs` | Git smart HTTP advertisement |
| POST | `/git/{owner}/{repo}/git-upload-pack` | Git smart HTTP fetch |
| POST | `/git/{owner}/{repo}/git-receive-pack` | Git smart HTTP push |
| POST | `/internal/git/policy` | Internal git hook policy check |

**Constants:**

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_FRAME_BYTES` | 65,536 | Max WebSocket frame size |
| `MAX_SUBSCRIPTIONS` | 1024 | Per-connection subscription limit |
| `MAX_HISTORICAL_LIMIT` | 500 | Per-filter historical query cap |
| `handler_semaphore` capacity | 1024 | Concurrent EVENT/REQ handlers |

**Does NOT:** implement business logic — delegates to the appropriate crate for every operation.

---

## buzz-acp — Agent Communication Protocol Harness

Standalone binary that bridges Buzz relay events to AI agents via the [Agent Communication Protocol](https://agentclientprotocol.com/) (ACP).

**Architecture:**

```
Buzz Relay ──WS──→ buzz-acp ──stdio (ACP/JSON-RPC)──→ Agent (goose/codex/claude)
```

`buzz-acp` spawns AI agent subprocesses (1–32, default 1), connects to the relay via WebSocket with NIP-42 auth, discovers channels via REST API, and queues `@mention` events per channel. At most one prompt is in-flight per channel. Queued events are batched into a single prompt sent via `session/prompt` over ACP.

**Key modules:**

| Module | LOC | Responsibility |
|--------|-----|---------------|
| `relay.rs` | 3,143 | WebSocket + REST relay connection, NIP-42 auth |
| `queue.rs` | 2,565 | Per-channel event queue, batching, dedup |
| `main.rs` | 2,457 | Event loop, pool orchestration, heartbeat |
| `pool.rs` | 2,253 | N-agent pool, claim/return lifecycle |
| `config.rs` | 1,903 | CLI/env/TOML configuration |
| `acp.rs` | 1,785 | ACP client, stdio JSON-RPC, timeouts |
| `filter.rs` | 814 | Subscription rules, evalexpr filtering |

**Key behaviors:**
- Pool of 1–32 agent subprocesses with claim/return lifecycle.
- Per-channel queuing: at most one prompt in-flight per channel; subsequent @mentions queue until the agent responds.
- Crash recovery: agent subprocess crashes are detected and the agent is respawned.
- Depends on `buzz-core` (kind constants) and `buzz-sdk` (relay/REST utilities).

**Does NOT:** persist state.

---

## buzz-admin — Operator CLI

Subcommands:

| Subcommand | Purpose |
|------------|---------|
| `add-member` | Add a pubkey to the relay membership list (`--pubkey`, `--role`); accepts npub or hex; publishes kind:13534 roster |
| `remove-member` | Remove a pubkey from the relay membership list (`--pubkey`, optional `--role` guard); publishes kind:13534 roster |
| `list-members` | List all relay members |
| `generate-key` | Generate a new Nostr keypair (for bootstrapping) |
| `reconcile-channels` | Emit kind:39000/39002 discovery events for channels missing them (idempotent) |

The `buzz-admin` binary is shipped in the relay Docker image (`/usr/local/bin/buzz-admin`) and is the recommended way to manage relay membership in production. Use `./run.sh add-member`, `./run.sh remove-member`, and `./run.sh list-members` in Docker Compose deployments.

---

## buzz-test-client — Integration Test Harness

**`BuzzTestClient`** wraps a WebSocket connection with a `VecDeque<RelayMessage>` buffer for message interleaving. Methods: `connect`, `connect_unauthenticated`, `authenticate`, `send_event`, `send_text_message`, `subscribe`, `close_subscription`, `recv_event`, `collect_until_eose`, `disconnect`.

**Test coverage:**

| File | Tests | Scope |
|------|-------|-------|
| `tests/e2e_relay.rs` | 27 | WebSocket protocol (auth, subscriptions, filters, limits, NIP-11) |
| `tests/e2e_media.rs` | 7 | Media upload/download (Blossom) |
| `tests/e2e_media_extended.rs` | 18 | Extended media scenarios |
| `tests/e2e_nostr_interop.rs` | 15 | Nostr interoperability: NIP-50 search, NIP-10 threads, NIP-17 gift wraps, DM discovery |

All e2e tests are `#[ignore]` — require a running relay. Total: **134 e2e tests**.

`src/main.rs` is a manual testing CLI (`buzz-test-cli`) with `--send`, `--subscribe`, `--channel`, `--url`, `--kind` flags.

Defines `parse_relay_message`, `OkResponse`, `RelayMessage` directly in `src/lib.rs`.


## Crates not covered above

- **`buzz-agent`** — native ACP agent (see [`crates/buzz-agent`](../../crates/buzz-agent) and [Working with Agents](../guides/agents.md))
- **`buzz-dev-mcp`** — MCP server exposing shell + file-edit tools to agents
- **`buzz-workflow`** — YAML automation engine (see [Workflows](../guides/workflows.md))
- **`buzz-persona`** — agent persona packs (see [Working with Agents](../guides/agents.md))
- **`buzz-conformance`** — runtime conformance gate against the formal specs (see [`crates/buzz-conformance/LIMITS.md`](../../crates/buzz-conformance/LIMITS.md))
- **`buzz-media`** — Blossom/S3 media storage
- **`buzz-sdk`** — typed Nostr event builders shared by `buzz-cli` and `buzz-acp`
- **`buzz-ws-client`** — WebSocket client used by harness and tools
- **`buzz-pair-relay` / `buzz-pairing-cli`** — relay pairing
- **`git-sign-nostr` / `git-credential-nostr`** — nostr-signed git commits and credentials
- **`sprig`** — supporting utility crate
