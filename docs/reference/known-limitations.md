# Known Limitations

Verified gaps in the current implementation — not design aspirations. The goal of this page is **no surprises** for operators and contributors: if something is stubbed, unenforced, or drifted, it's listed here. Primary source: [`ARCHITECTURE.md` §9](../../ARCHITECTURE.md), cross-checked against code.

## Relay

| # | Limitation | Detail |
|---|-----------|--------|
| 1 | **Rate limiting is not enforced** | The `RateLimiter` trait exists in `buzz-auth`, but the only implementation is `AlwaysAllowRateLimiter` — a test stub gated behind `#[cfg(any(test, feature = "test-utils"))]`. `RateLimitConfig` defines 4 tiers (human, agent-standard, agent-elevated, agent-platform) but none are enforced. Operators should not rely on relay-side rate limiting; put limits at the proxy layer if needed. |
| 2 | **No sqlx offline query cache** | The codebase uses `sqlx::query()` (runtime-checked) rather than `sqlx::query!()` (compile-time-checked); there is no `.sqlx/` directory. SQL errors surface at runtime, not build time. |
| 3 | **No dedicated typing REST endpoint** | Typing indicators (kind 20002) are delivered via local fan-out and Redis pub/sub, but there is no REST endpoint to query current typers — `/api/presence` returns online/away status only. |
| 4 | **Huddle recording/tracks not built** | Voice, room lifecycle, and join/leave/end events are wired. Recording and per-track publishing have reserved event kinds but no producer yet. |

## Workflows

| # | Limitation | Detail |
|---|-----------|--------|
| 5 | **Approval gates not wired end-to-end (🚧 WF-08)** | The executor returns `StepResult::Suspended` and the relay has grant/deny API endpoints with DB CRUD, but the engine intercepts before creating `WaitingApproval` rows — a run that hits an approval gate is marked **Failed**. `buzz workflows approve` exists but has nothing to approve yet. |
| 6 | **`send_dm` / `set_channel_topic` actions stubbed (🚧 WF-07)** | Both actions are accepted by the workflow YAML schema but return `NotImplemented` at execution — a run that reaches one fails. Use the other five actions (see the [workflows guide](../guides/workflows.md)). |

## Conformance gate

The runtime conformance harness (`crates/buzz-conformance`) is **observation, not proof**. Its own [`LIMITS.md`](../../crates/buzz-conformance/LIMITS.md) is the authoritative statement; headline caveats:

- Coverage is **execution coverage** — a code path that never runs during a traced execution is invisible to the gate.
- It is armed only at the ingest/auth/read accept-reject boundary; DB-layer leaks the projection doesn't read, cross-pod leaks, timing-dependent bugs, pub/sub fan-out, and spec bugs are all out of scope.
- The read-seam half of the gate is **not yet armed** (pending a design decision on per-row community labeling).
- Production default is `NoopTracer` — the gate off loses observability only, never correctness.

## Documentation debt

| Item | Detail |
|------|--------|
| **`crates/buzz-cli/README.md` has drifted** | It documents 13 command groups / 60 subcommands and exit codes 0–4; the CLI actually ships 18 groups / 87 subcommands and exit codes 0–5 (adds `emoji`, `notes`, `patches`, `issues`, `pr`, `mem`, `pack`; exit 5 = write conflict). The [CLI reference](cli.md) is verified against `--help` and source. |
| **`GOVERNANCE.md` is a one-line pointer** | It contains only a link to the Block-wide [organization governance doc](https://github.com/block/.github/blob/main/GOVERNANCE.md) — there is no project-specific governance yet. |
| **Root doc originals retained during migration** | `ARCHITECTURE.md`, `NOSTR.md`, `TESTING.md`, `RELEASING.md`, and `VISION*.md` were migrated into `docs/` but the originals remain at the repo root with pointer notes. Deletion is a follow-up decision — until then, `docs/` is canonical for migrated content. |
| **`docs/nips/`, `docs/spec/`, and loose design docs not relocated** | 55 external references (code, tests, migrations, Helm templates) point at their current paths. They are indexed from [`nips.md`](nips.md) and [`design-docs.md`](design-docs.md) in place. |

## Vision vs. reality

The [`vision/`](../vision/README.md) section describes aspirational direction, not current behavior. Anything described only there should be assumed unimplemented unless this page or the architecture docs say otherwise.
