# Event Pipeline

What happens when the relay receives `["EVENT", <event>]`: the ordered
pipeline from auth check to workflow trigger, plus the ephemeral sub-pipeline
for kinds 20000–29999. Handlers live in
[`crates/buzz-relay/src/handlers/`](../../crates/buzz-relay/src/handlers/).

When the relay receives `["EVENT", <event>]`, the handler in `handlers/event.rs` runs this pipeline in order:

```
1. AUTH CHECK        — AuthState::Authenticated? MessagesWrite scope?
2. PUBKEY MATCH      — event.pubkey == auth_context.pubkey?
3. KIND_AUTH REJECT  — kind == 22242 (AUTH events never stored)
4. EPHEMERAL ROUTE   — kind 20000–29999 → ephemeral sub-pipeline (see below)
5. VERIFY            — spawn_blocking(verify_event) — Schnorr sig + ID hash
6. MEMBERSHIP        — channel_id in event tags? → check_channel_membership
7. DB INSERT         — db.insert_event (ON CONFLICT DO NOTHING — idempotent)
8. REDIS PUBLISH     — pubsub.publish_event (if channel-scoped)
9. FAN-OUT           — sub_registry.fan_out → conn_manager.send_to
10. SEARCH INDEX     — search_index_tx.send (bounded worker queue, non-blocking)
11. AUDIT LOG        — audit.log (spawned async, non-blocking)
12. WORKFLOW TRIGGER — wf.on_event (spawned async, excludes kinds 46001–46012)
```

Steps 10–12 are fire-and-forget. Search indexing is sent to a bounded worker queue (`search_index_tx`, capacity 1000); audit and workflow triggers are spawned as independent async tasks. A failure in any of these does not fail the event submission. The client receives `["OK", <id>, true, ""]` at the end of the pipeline, not immediately after DB insert.

Step 9 (fan-out) explicitly **excludes** global subscriptions (no `channel_id` constraint) from channel-scoped events — global subscriptions do NOT receive events from private channels, regardless of filter match. This is a deliberate security boundary: only subscriptions scoped to an accessible `channel_id` receive those events.

Workflow loop prevention: workflow execution kinds (46001–46012), relay-signed messages with `buzz:workflow` tag, and `KIND_GIFT_WRAP` are excluded from triggering workflows. All other stored events (including kind 9 stream messages) trigger workflow evaluation.

## Ephemeral Sub-Pipeline (kinds 20000–29999)

Ephemeral events bypass DB storage, audit, and search. Two sub-paths:

**Presence events (kind 20001):**
```
1. VERIFY            — spawn_blocking(verify_event)
2. REDIS PRESENCE    — set_presence() or clear_presence() based on content
3. LOCAL FAN-OUT     — sub_registry.fan_out → conn_manager.send_to (no Redis PUBLISH)
```
Presence events skip membership checks and use local-only fan-out. Multi-node presence fan-out would require Redis pub/sub (documented as future work).

**Other ephemeral events (e.g., typing indicators):**
```
1. VERIFY            — spawn_blocking(verify_event)
2. MEMBERSHIP        — check_channel_membership (if channel-scoped)
3. MARK LOCAL        — state.mark_local_event (dedup before Redis round-trip)
4. REDIS PUBLISH     — pubsub.publish_event (no DB write)
5. LOCAL FAN-OUT     — sub_registry.fan_out → conn_manager.send_to
```

Ephemeral events are never stored in Postgres and never appear in REQ historical queries.

## Handler Semaphore

Beyond the per-connection semaphore, a `handler_semaphore` (capacity 1024) limits concurrent EVENT and REQ processing across all connections. CLOSE is not rate-limited.

