# Design Documents Index

Engineering design records and formal specifications living directly under [`docs/`](../). Like the NIPs, they stay at their current paths (external references from code, tests, and Helm templates) — this page is the index.

These are **design records**, not user documentation: they capture the reasoning behind a feature at the time it was built. Where a NIP supersedes one, the NIP is normative.

## Design records

| Document | Status | Summary |
|----------|--------|---------|
| [`bridge-channel-window.md`](../bridge-channel-window.md) | superseded by NIP | Engineering record of the `/query` channel-window extension. **[NIP-CW](../nips/NIP-CW.md) is the canonical spec** — read this only for implementation history. |
| [`MCP_DRIVEN_HOOKS.md`](../MCP_DRIVEN_HOOKS.md) | active | MCP-driven lifecycle hooks: MCP tools the agent calls at lifecycle points (see also the [agents guide](../guides/agents.md)). |
| [`multi-tenant-relay.md`](../multi-tenant-relay.md) | draft | Formal specification for a multi-tenant Buzz relay (first-class communities). Prose companion to the TLA+ model below. |
| [`multi-tenant-conformance.md`](../multi-tenant-conformance.md) | active | Source-vs-model checklist for adding communities without changing single-community behavior. Pairs with `crates/buzz-conformance` — see its honest [`LIMITS.md`](../../crates/buzz-conformance/LIMITS.md) and [known limitations](known-limitations.md). |
| [`git-on-object-storage.md`](../git-on-object-storage.md) | draft | Formal specification for serving git refs over object storage. |
| [`mesh-llm-local-build.md`](../mesh-llm-local-build.md) | active | Build prerequisites for the embedded mesh-llm native layer (linked into relay and desktop binaries). |

## Formal specifications (`docs/spec/`)

Machine-checked models backing the multi-tenant and git-on-object-storage designs:

| File | Tool | Models |
|------|------|--------|
| [`MultiTenantRelay.tla`](../spec/MultiTenantRelay.tla) / [`.cfg`](../spec/MultiTenantRelay.cfg) | TLA+ (TLC) | Multi-tenant relay ingest/read confinement — the spec the conformance gate checks traces against |
| [`MultiTenantAuth.spthy`](../spec/MultiTenantAuth.spthy) | Tamarin | Multi-tenant authentication protocol |
| [`GitOnObjectStore.tla`](../spec/GitOnObjectStore.tla) / [`.cfg`](../spec/GitOnObjectStore.cfg) | TLA+ (TLC) | Git refs over object storage |

The conformance harness validates *executions* against the TLA+ spec at runtime — it is not a proof. See [known limitations](known-limitations.md#conformance-gate).
