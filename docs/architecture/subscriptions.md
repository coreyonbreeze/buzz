# Subscription System

How `REQ` subscriptions are indexed, access-checked, and fanned out. The
registry lives in `crates/buzz-relay/src/subscription.rs`; Redis-backed
cross-node fan-out is in [`crates/buzz-pubsub`](../../crates/buzz-pubsub).

## SubscriptionRegistry

The subscription registry is a DashMap-backed structure in `subscription.rs`:

```rust
pub struct SubscriptionRegistry {
    subs: DashMap<ConnId, HashMap<SubId, SubEntry>>,
    channel_kind_index: DashMap<IndexKey, Vec<(ConnId, SubId)>>,
    channel_wildcard_index: DashMap<Uuid, Vec<(ConnId, SubId)>>,
}

pub struct IndexKey {
    pub channel_id: Uuid,
    pub kind: Kind,
}
```

## Three-Tier Fan-Out

When an event arrives, `fan_out` consults three indexes in order:

| Tier | Index | Key | Use Case |
|------|-------|-----|---------|
| 1 | `channel_kind_index` | `(channel_id, kind)` | Subs with explicit channel + kind filter — O(1) lookup |
| 2 | `channel_wildcard_index` | `channel_id` | Subs with channel but no `kinds` constraint |
| 3 | `subs` (linear scan) | — | Global subs (no channel_id) — fallback scan |

Global subs (tier 3) are checked for non-channel-scoped events only. Channel-scoped events are delivered exclusively to subscriptions that carry a matching `channel_id` — global subscriptions are explicitly excluded from channel fan-out as a security boundary.

## NIP-01 Edge Cases

- `kinds: []` (explicit empty array) means "match nothing" — NOT a wildcard. Subscriptions with empty `kinds` are not indexed in either tier 1 or tier 2 and never receive events.
- `kinds` absent (no field) means "match all kinds" — indexed in tier 2 (channel wildcard) or tier 3 (global).

## REQ Handler Access Control

The REQ handler checks channel access **before** registering the subscription:

```
1. Parse filters, extract channel_id
2. Load accessible_channel_ids for this connection's pubkey
3. If channel_id not in accessible_channels → send CLOSED "restricted: not a channel member"
4. Only then: sub_registry.register(conn_id, sub_id, filters, channel_id)
```

This prevents a race where a non-member receives live fan-out events from a private channel between registration and the access check.

## Historical Query (EOSE)

After registering, the REQ handler queries Postgres for stored events matching the filters (up to 500 per filter, hard cap). These are sent as `["EVENT", sub_id, event]` frames before `["EOSE", sub_id]`. New events arriving after EOSE are delivered via the fan-out path.

