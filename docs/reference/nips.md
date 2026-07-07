# Buzz NIPs Index

Buzz extends Nostr with custom NIPs (Nostr Implementation Possibilities) that live in [`docs/nips/`](../nips/). They stay at that path because code, tests, migrations, and Helm templates reference it directly — this page is the index.

All 13 are currently **`draft` `optional`**; those marked *relay* require relay-side support.

## Agent NIPs

| NIP | Title | Relay? | One-liner |
|-----|-------|--------|-----------|
| [NIP-OA](../nips/NIP-OA.md) | Owner Attestation | — | An `auth` tag by which an owner key authorizes an agent key to publish events under the agent's own authorship. The foundation of Buzz's agent identity model (`BUZZ_AUTH_TAG`). |
| [NIP-AA](../nips/NIP-AA.md) | Agent Authentication | relay | Agents whose owner is a relay member gain implicit relay access by presenting a NIP-OA `auth` tag during NIP-42 auth — no explicit enrollment needed. |
| [NIP-AE](../nips/NIP-AE.md) | Agent Engrams | — | Persistent agent memory as addressable `kind:30174` events, NIP-44-encrypted between agent and owner. Backs `buzz mem`. |
| [NIP-AP](../nips/NIP-AP.md) | Agent Personas | — | `kind:30175` persona events — public, addressable "blueprints" from which agents are spawned (identity, system prompt, model, runtime, name pool). |
| [NIP-AO](../nips/NIP-AO.md) | Agent Observability | — | Ephemeral, encrypted event kinds streaming internal session telemetry from agent processes to their owners' desktop clients. |
| [NIP-AM](../nips/NIP-AM.md) | Agent Turn Metrics | relay | Durable, encrypted event kind recording per-turn token usage and cost. |

## Relay-projection NIPs

| NIP | Title | Relay? | One-liner |
|-----|-------|--------|-----------|
| [NIP-CW](../nips/NIP-CW.md) | Channel Window | relay | **Canonical spec** for the channel window: a relay-computed, cursor-paged view of a channel's top-level timeline (kinds 39005/39006) served through an extended NIP-01 filter. The earlier engineering record [`docs/bridge-channel-window.md`](../bridge-channel-window.md) defers to this NIP as normative. |
| [NIP-DV](../nips/NIP-DV.md) | DM Visibility | relay | Per-viewer DM hide state as a single relay-signed, parameterized-replaceable event — hide a conversation without leaving it. |
| [NIP-RS](../nips/NIP-RS.md) | Cross-Device Read State Sync | — | Synchronizing a user's own per-context read state across devices. |
| [NIP-IA](../nips/NIP-IA.md) | Identity Archival | relay | Relay-scoped archiving of identities: hidden from active-member and autocomplete surfaces, history preserved. |
| [NIP-ER](../nips/NIP-ER.md) | Event Reminders | relay | Encrypted, author-only reminders as `kind:30300` addressable events, with a public `not_before` due tag. |
| [NIP-WP](../nips/NIP-WP.md) | Workspace Profile | relay | Relay-scoped workspace icon set by admin command (`kind:9033`) and served via the NIP-11 `icon` field. |

## Git NIPs

| NIP | Title | Relay? | One-liner |
|-----|-------|--------|-----------|
| [NIP-GS](../nips/NIP-GS.md) | Git Object Signing with Nostr Keys | — | Signature format and verification protocol for signing git objects with Nostr keys. |

## Standard NIPs

Buzz also implements a range of upstream NIPs (NIP-01 events/filters, NIP-02 contacts, NIP-09 deletion, NIP-11 relay info, NIP-23 long-form, NIP-34 git, NIP-42/98 auth, NIP-44 encryption, NIP-51/65 lists, and others). See [architecture: protocol](../architecture/protocol.md) for how they're used.
