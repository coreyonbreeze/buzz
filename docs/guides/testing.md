# Testing Guide

How to run and write tests. For the full CLI-driven live-relay walkthrough
(build, smoke test, ACP harness), see
[Running a Local Relay](../getting-started/local-relay.md).

## Automated tests

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


## Unit Tests (no infrastructure required)

```bash
just test-unit
```

Unit tests are self-contained and run without Docker. They cover event
parsing, filter matching, auth logic, workflow YAML parsing, and more.

## Integration Tests (requires running infrastructure)

```bash
just test
```

Integration tests spin up the relay and exercise the full stack — WebSocket
connections, NIP-42 auth, event ingestion, search indexing, and workflow
execution. `just test` starts Docker services automatically if they're not
already running.

## End-to-End Tests

End-to-end tests live in `crates/buzz-test-client/tests/`:

- `e2e_relay.rs` — WebSocket relay tests
- `e2e_mcp.rs` — MCP tool tests
- `e2e_nostr_interop.rs` — Nostr protocol interoperability tests
- `e2e_media.rs` — media upload/download tests
- `e2e_media_extended.rs` — extended media tests (GIF, image processing)

Run them with (requires running infrastructure):

```bash
cargo test -p buzz-test-client -- --ignored
```

See `TESTING.md` for the full multi-agent E2E testing guide.

## CI Gate

Before opening a PR, run the full CI gate locally:

```bash
just ci
# Runs: check + unit tests + desktop build + Tauri check + mobile tests
```

This is the same check that runs in CI. PRs that fail `just ci` will not be
merged.


## Desktop tests

The desktop app has Playwright end-to-end tests configured in
[`desktop/playwright.config.ts`](../../desktop/playwright.config.ts) (plus a
perf config, `playwright.perf.config.ts`). Run them from `desktop/` with pnpm.

## Conformance

[`crates/buzz-conformance`](../../crates/buzz-conformance) is a runtime
conformance gate that checks relay ingest/auth/read decisions against the
formal specs in [`docs/spec/`](../spec/). It validates traces from executions
that actually ran — it is **not a proof**; read
[`crates/buzz-conformance/LIMITS.md`](../../crates/buzz-conformance/LIMITS.md)
before treating a green run as more than execution coverage.

## CLI smoke-testing against a live relay

See [Running a Local Relay](../getting-started/local-relay.md) for the
end-to-end sequence (keypair → channel → message → thread), and
[`crates/buzz-cli/TESTING.md`](../../crates/buzz-cli/TESTING.md) for full
coverage of every CLI command.
