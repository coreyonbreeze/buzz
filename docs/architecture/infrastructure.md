# Infrastructure

The runtime infrastructure behind a Buzz relay: Postgres, Redis, object
storage, and metrics. Local development uses the root
[`docker-compose.yml`](../../docker-compose.yml); production deployment
options are covered in the [Self-Hosting guide](../guides/self-hosting.md).

Docker Compose provides the full local development stack. All services include health checks and resource limits.

## Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| Postgres | `postgres:17-alpine` | 5432 | Primary event store — events, channels, tokens, workflows, audit; full-text search (`search_tsv` GIN) |
| Redis | `redis:7-alpine` | 6379 | Pub/sub fan-out, presence (SET EX), typing (sorted sets) |
| Adminer | `adminer` | 8082 | DB web UI (dev only) |
| MinIO | `minio/minio` | 9000 (API), 9001 (console) | S3-compatible object storage (media) |
| Prometheus | `prom/prometheus` | 9090 | Metrics collection |

## Postgres Schema (key tables)

| Table | Purpose |
|-------|---------|
| `events` | All stored Nostr events; monthly range-partitioned by `PARTITION BY RANGE` on `created_at`; multi-community mode keys every tenant-visible event by `community_id` |
| `channels` | Channel records (type, visibility, canvas, topic); `community_id` is immutable after creation in multi-community mode |
| `channel_members` | Membership with roles; soft-delete via `removed_at` |
| `workflows` | Workflow definitions (YAML stored as canonical JSON); scoped by community in multi-community mode |
| `workflow_runs` | Execution records with trigger context and trace |
| `workflow_approvals` | Approval gates (token stored as SHA-256 hash) |
| `audit_log` | Hash-chain audit entries; per-community chain/head in multi-community mode |
| `delivery_log` | Delivery tracking (partitioned; Rust module pending) |

## Redis Key Patterns

| Pattern | Type | TTL | Purpose |
|---------|------|-----|---------|
| `buzz:channel:{uuid}` | Pub/Sub channel | — | Event fan-out (single-community form; shared multi-community Redis must use `buzz:{community}:channel:{uuid}` or equivalent) |
| `buzz:presence:{pubkey_hex}` | String | 90s | Online/away status (single-community form; shared multi-community Redis must scope by community) |
| `buzz:typing:{channel_uuid}` | Sorted Set | 60s | Active typers (5s window; shared multi-community Redis must scope by community) |

## Full-Text Search (Postgres FTS)

Search runs over the `events.search_tsv` generated `tsvector` column on the
`events` table (no separate collection or service). The column is populated on
insert — `to_tsvector('simple', content)` — and excludes privacy-sensitive
kinds via `CASE WHEN kind IN (1059, 30300, 30622) THEN NULL`, so those rows are
storage-level unsearchable (a `NULL` tsvector never matches `@@`). A GIN index
(`idx_events_search_tsv`) backs the `@@` probe; in multi-community mode the
community-leading btree filters BitmapAnd with the GIN probe so every query is
fenced to its `community_id`.

