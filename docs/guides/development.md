# Development Guide

Setting up a dev environment, code style, and the PR workflow. The root
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) is the canonical contributor entry
point (code of conduct, CLA); this page is the day-to-day engineering detail.

## Environment setup

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Rust | 1.88+ | Install via [rustup](https://rustup.rs/) |
| Node.js | 24+ | Required for desktop app commands and `just ci` |
| pnpm | 10+ | Required for desktop app commands and `just ci` |
| Flutter | 3.41+ | Required for mobile app — install via [flutter.dev](https://docs.flutter.dev/get-started/install) |
| Docker | 24+ | For Postgres, Redis, MinIO |
| `just` | latest | Task runner — `cargo install just` |
| `lefthook` | latest | Optional; run `lefthook install` for local Git hooks |
| `sqlx` migrations | workspace crate | `just migrate` applies embedded migrations from `migrations/` |

This repo uses [Hermit](https://cashapp.github.io/hermit/) for toolchain
pinning. Activate it once per shell session:

```bash
. ./bin/activate-hermit
```

Hermit pins Rust, `just`, Node, pnpm, and other tools to the versions in
`bin/`. Each tool is downloaded on first use. You can also run `just bootstrap`
(which `just setup` calls automatically) to pre-download all required tools
upfront. If you don't use Hermit, ensure your toolchain meets the minimum
versions in the table above.

## First-Time Setup

```bash
# 1. Clone the repo
git clone https://github.com/block/buzz.git
cd buzz

# 2. Activate Hermit (optional but recommended)
. ./bin/activate-hermit

# 3. Bootstrap tools + infrastructure
just setup

# 4. Install Git hooks (optional, recommended)
just hooks
```

`just setup` runs `just bootstrap` first — it copies `.env.example` to `.env`
if it doesn't already exist, and invokes `cargo`, `node`, and `pnpm` to trigger
Hermit's lazy tool download (each tool is fetched once on first invocation and
cached thereafter). You can also run `just bootstrap` independently at any time;
it is safe to re-run.

`just setup` then starts Docker services (Postgres on `:5432`, Redis on `:6379`,
Adminer on `:8082`, Keycloak on `:8180` for local OAuth/OIDC testing, MinIO on
`:9000` for media storage, and Prometheus on `:9090` for metrics) and runs all
pending database migrations.

## Running the Relay and Desktop App

```bash
just dev   # starts the relay + desktop app in one command
```

`just dev` builds all agent tools, starts the relay (`ws://localhost:3000`) in
the background, and launches the Tauri desktop app. The relay process is
automatically killed when you quit the app or press Ctrl+C.

For a split-terminal workflow (relay logs visible separately from Vite output):

```bash
just relay        # terminal 1 — relay on ws://localhost:3000
just desktop-dev  # terminal 2 — Vite dev server only (no Tauri shell)
```

## Stopping / Resetting

```bash
just down    # Stop Docker services, keep data
just reset   # ⚠️  Wipe all data and recreate the environment
```


## Repo layout

A Rust workspace of focused crates (see the
[Crate Reference](../architecture/crates.md)), plus `desktop/` (Tauri + React),
`web/`, `mobile/` (Flutter), `deploy/` (Compose bundle + Helm chart),
`migrations/`, and `examples/`. Task automation lives in the
[`Justfile`](../../Justfile); Git hooks in [`lefthook.yml`](../../lefthook.yml);
TS lint/format in [`biome.json`](../../biome.json).

## Code style

## Formatting

We use `rustfmt` with default settings. Format your code before committing:

```bash
cargo fmt --all
```

To check without modifying:

```bash
cargo fmt --all -- --check
```

## Linting

We use `clippy` with warnings-as-errors:

```bash
cargo clippy --all-targets --all-features -- -D warnings
```

Fix all clippy warnings before submitting a PR. If you believe a warning is
a false positive, add a targeted `#[allow(...)]` with a comment explaining
why.

## No Unsafe Code

All crates enforce `#![deny(unsafe_code)]`. Do not add unsafe blocks. If you
believe unsafe is genuinely necessary, open an issue first to discuss the
approach.

## Error Handling

- Use `thiserror` for library error types.
- Use `anyhow` for binary / application-level error propagation.
- Do not use `unwrap()` or `expect()` in production code paths. Use `?` or
  explicit error handling. `unwrap()` is acceptable in tests.

## Logging and Tracing

Use the `tracing` crate for all instrumentation. Prefer structured fields
over string interpolation:

```rust
// Good
tracing::info!(channel_id = %id, event_kind = kind, "Event ingested");

// Avoid
tracing::info!("Event ingested: channel={id} kind={kind}");
```

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(mcp): add get_feed_actions tool
fix(auth): reject expired NIP-42 challenges
docs(agents): document workflow MCP tools
refactor(db): extract channel queries into channel.rs
test(workflow): add approval gate integration test
```

The type prefix (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`) is
required. The scope (in parentheses) is optional but encouraged.


## Making a pull request

## Before You Start

- Check open issues and PRs to avoid duplicate work.
- For significant changes, open an issue first to discuss the approach.
- For small fixes (typos, doc improvements, obvious bugs), go ahead and open
  a PR directly.

## What a Good PR Looks Like

1. **Focused** — one logical change per PR. If you're fixing a bug and
   refactoring a module, split them into two PRs.

2. **Tested** — new behavior has tests. Bug fixes include a regression test.
   If a test is impractical, explain why in the PR description.

3. **Documented** — public APIs, new event kinds, new MCP tools, and new
   config variables are documented. Update `README.md`, `AGENTS.md`, or
   `VISION.md` as appropriate.

4. **CI passing** — `just ci` passes locally before you push.

5. **Clear description** — the PR description explains:
   - What problem this solves (or what feature it adds)
   - How it was implemented (key decisions, trade-offs)
   - How to test it manually (if applicable)
   - Any follow-up work deferred to a future PR

## PR Checklist

```
- [ ] `just ci` passes (fmt + clippy + unit tests + mobile)
- [ ] Integration tests pass (`just test`)
- [ ] New public APIs / tools / endpoints are documented
- [ ] No new `unwrap()` in production code paths
- [ ] No new `unsafe` blocks
```

## Review Process

- A maintainer will review your PR within a few business days.
- Address review comments by pushing new commits (don't force-push during
  review; it makes it hard to see what changed).
- Once approved, a maintainer will squash-merge your PR.


## License and CLA

Buzz is licensed under the **Apache License, Version 2.0**. See
[LICENSE](../../LICENSE) for the full text.

By submitting a pull request, you agree that your contribution is licensed
under the Apache 2.0 license and that you have the right to submit it.

If your employer has rights to intellectual property you create, you may need
their sign-off. When in doubt, check with your legal team.

---

*Thank you for contributing to Buzz. Every bug report, documentation fix,
and code contribution makes the project better for everyone. 🐝*
