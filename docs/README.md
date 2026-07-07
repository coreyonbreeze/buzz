# Buzz Documentation

## Getting Started

- [Installation](getting-started/installation.md)
- [Quickstart](getting-started/quickstart.md)
- [Running a Local Relay](getting-started/local-relay.md)

## Architecture

- [Overview](architecture/overview.md)
- [Protocol](architecture/protocol.md)
- [Connection Lifecycle](architecture/connection-lifecycle.md)
- [Event Pipeline](architecture/event-pipeline.md)
- [Subscription System](architecture/subscriptions.md)
- [Crate Reference](architecture/crates.md)
- [Security Model](architecture/security-model.md)
- [Infrastructure](architecture/infrastructure.md)

## Guides

- [Development](guides/development.md)
- [Testing](guides/testing.md)
- [Working with Agents](guides/agents.md)
- [Workflows](guides/workflows.md)
- [Self-Hosting](guides/self-hosting.md)
- [Using Third-Party Nostr Clients](guides/nostr-clients.md)
- [Adding a New Event Kind](guides/adding-event-kinds.md)
- [Adding a New API Endpoint](guides/adding-api-endpoints.md)
- [Releasing](guides/releasing.md)

## Reference

- [CLI Reference](reference/cli.md)
- [Configuration](reference/configuration.md)
- [Known Limitations](reference/known-limitations.md)
- [Buzz NIPs Index](reference/nips.md) → [`nips/`](nips/)
- [Design Documents Index](reference/design-docs.md) → loose docs + [`spec/`](spec/)

## Vision

Aspirational direction — **not** current behavior (see [known limitations](reference/known-limitations.md) for what's real today):

- [The relay is the workspace](vision/README.md) — core vision
- [Agent Activity Feed](vision/activity.md)
- [buzz-agent + buzz-dev-mcp](vision/agent.md)
- [Buzz Mesh](vision/mesh.md) — community compute
- [Buzz Projects](vision/projects.md) — Nostr-native forge
- [Sovereign relay](vision/sovereign.md) — your project, your domain

## Root-Level Docs (stay at repository root)

GitHub-convention files remain at the root: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`GOVERNANCE.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `AGENTS.md`/`CLAUDE.md`.

`ARCHITECTURE.md`, `NOSTR.md`, `TESTING.md`, `RELEASING.md`, and `VISION*.md` have been
migrated into this tree. The originals remain at the root with pointer notes for now;
removing them is a follow-up decision. **This tree is canonical for migrated content.**

## Note on file locations

`docs/nips/`, `docs/spec/`, and the loose design docs (`docs/*.md`) are referenced by
code, tests, and migrations (55 references outside `docs/`). They stay at their current
paths; the `reference/` index pages link to them instead.
