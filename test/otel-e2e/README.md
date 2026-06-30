# OTEL E2E Harness

Local end-to-end validation for the Buzz relay's observability export surfaces
(PR #1398 — `crates/buzz-relay` OTEL migration).

## What it proves

| Assertion | What's checked |
|-----------|---------------|
| **(a) Prometheus scrape** | `GET :9102/metrics` contains `buzz_ws_connections_total`, `buzz_events_received_total`, `buzz_auth_attempts_total` with **non-zero values**; does **not** contain `target_info` (suppressed via `.without_target_info()`) |
| **(b) OTLP traces** | The otel-collector received spans named `ws.auth` and `ws.event` carrying a `conn_id` attribute; `service.name=buzz-relay` verified **structurally** via `resource.attributes` key/value (not substring) |
| **(d) OTLP-disabled control** | With `OTEL_EXPORTER_OTLP_ENDPOINT` unset the relay still serves `/metrics` correctly; the collector receives **nothing** |

OTLP metrics export is out of scope — the relay emits metrics via the Prometheus `:9102` scrape only; OTLP carries traces only.

## Prerequisites

- Docker (for compose services: postgres, redis, minio, otel-collector)
- Rust toolchain (builds the relay + test binary)
- `psql` on PATH, or it falls back to `docker exec` into the postgres container
- Ports available: `3000` (relay WS), `4317` (OTLP gRPC), `5432`, `6379`, `9000`, `9102`

## One-command run

```bash
just otel-e2e
```

Or directly:

```bash
./test/otel-e2e/run.sh
```

Pass `--skip-build` to reuse an existing `target/ci/buzz-relay` binary:

```bash
just otel-e2e --skip-build
```

To test against a relay built from the `duncan/otel-migration` branch (PR #1398):

```bash
# Build the OTEL relay binary first:
cd /path/to/buzz/.worktrees/duncan-otel-migration
cargo build --profile ci -p buzz-relay

# Run the harness pointing at that binary:
RELAY_BINARY=/path/to/buzz/.worktrees/duncan-otel-migration/target/ci/buzz-relay \
  just otel-e2e --skip-build
```

## Architecture

```
┌─────────────────────── HOST ──────────────────────────────────┐
│                                                                │
│  buzz-relay (host process)                                     │
│    • WS :3000       ← test driver connects here               │
│    • health :8080                                              │
│    • Prometheus :9102  ← test scrapes here                    │
│    • OTLP gRPC → http://localhost:4317 (collector below)      │
│                                                                │
└───────────────────────────────────────────────────────────────┘
          │ OTLP gRPC                 │ psql/redis/s3
          ▼                           ▼
┌─────── DOCKER (buzz-net) ──────────────────────────────────────┐
│                                                                 │
│  otel-collector :4317  ←── relay pushes traces here            │
│    exports to: debug stdout + /tmp/otelcol-output/             │
│                                                                 │
│  postgres :5432  redis :6379  minio :9000                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The relay runs on the host (matching the existing `host.docker.internal`
Prometheus pattern in `docker-compose.yml`). Only the backing services and the
collector run in Docker. This avoids a slow full-image rebuild on each test run.

## Files

| File | Purpose |
|------|---------|
| `run.sh` | Main driver: boots stack, starts relay twice (OTLP on/off), runs assertions |
| `compose.otel-e2e.yml` | Compose overlay — adds `otel-collector` to the existing dev stack |
| `otelcol-config.yml` | Collector config: OTLP gRPC receiver on :4317, debug + file exporter |
| `README.md` | This file |

The Rust assertions live in:

```
crates/buzz-test-client/tests/e2e_otel.rs
```

All four tests are `#[ignore]` by default and selected by `run.sh`.

## Running individual tests manually

> **Note:** The Rust tests in `crates/buzz-test-client/tests/e2e_otel.rs` are
> **harness internals**.  They depend on the two-relay sequence orchestrated by
> `run.sh` (OTLP-enabled run first, then OTLP-disabled run), and the OTLP trace
> assertions read collector output written during the first relay's run.  Running
> the tests in isolation will fail or produce misleading results unless you
> manually replicate the same sequence.  Use `just otel-e2e` as the canonical
> entry point.

For development/debugging, you can reproduce the harness sequence manually:

```bash
# Start the stack first (per-run output dir is required):
export BUZZ_OTEL_OUTPUT_DIR=$(mktemp -d)
docker compose -f docker-compose.yml -f test/otel-e2e/compose.otel-e2e.yml \
  up -d postgres redis minio minio-init otel-collector

# Start relay with OTLP enabled (no OTEL_SERVICE_NAME — relay defaults it):
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz \
REDIS_URL=redis://localhost:6379 \
RELAY_URL=ws://localhost:3000 \
BUZZ_REQUIRE_AUTH_TOKEN=false \
  ./target/ci/buzz-relay &

# Run the Prometheus + OTLP trace assertions:
RELAY_URL=ws://localhost:3000 \
METRICS_URL=http://localhost:9102/metrics \
OTEL_COLLECTOR_OUTPUT=${BUZZ_OTEL_OUTPUT_DIR}/telemetry.json \
  cargo test -p buzz-test-client --test e2e_otel \
    test_prometheus_contains_buzz_metrics test_otlp_traces -- --ignored

# Teardown:
docker compose -f docker-compose.yml -f test/otel-e2e/compose.otel-e2e.yml down -v
```

## Relationship to the relay source

This harness is **read-only with respect to `crates/buzz-relay/src/**`**.  The
relay binary is built from the `duncan/otel-migration` branch (PR #1398) which
is gate-cleared and frozen.  This harness lives on a separate branch
(`duncan/otel-e2e-harness`) and adds only:

- `test/otel-e2e/` — this directory
- `crates/buzz-test-client/tests/e2e_otel.rs` — the Rust assertions
- `Justfile` — `just otel-e2e` target
