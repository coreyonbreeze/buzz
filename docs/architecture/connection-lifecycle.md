# Connection Lifecycle

Every WebSocket connection to the relay follows the same sequence: community
binding, capacity check, NIP-42 challenge, authentication, active loops, and
cleanup. Client-side reconnection behavior lives in
[`crates/buzz-ws-client`](../../crates/buzz-ws-client); the relay side is
[`crates/buzz-relay`](../../crates/buzz-relay).

Every WebSocket connection follows this exact sequence:

## Step 0: Community Binding

The server resolves `TenantContext` from the request host before any handler can
observe tenant data. The URL/domain is authoritative for the community, matching
today's "the relay URL is the workspace" behavior. In single-community mode the
configured host maps to the default community. In multi-community mode, an
unknown or unmapped host rejects generically and never falls through to a default
tenant. Client-supplied `#h` tags are still channel identifiers; they must resolve
to a channel inside the host-derived community.

## Step 1: Semaphore Acquire

`state.conn_semaphore.try_acquire_owned()` — if the relay is at connection capacity, the connection is rejected immediately before any data is read. The permit is held for the entire connection lifetime and dropped on cleanup.

## Step 2: NIP-42 Challenge

The relay immediately sends `["AUTH", "<challenge>"]`. The challenge is a random string. The connection is registered in `ConnectionManager` after the challenge is sent.

## Step 3: Authentication

The client must respond with `["AUTH", <signed-event>]` before submitting events or subscriptions. Authentication paths:

| Path | Mechanism | Use Case |
|------|-----------|---------|
| NIP-42 | Signed challenge, pubkey verified | WebSocket connections |
| NIP-98 HTTP Auth | Schnorr-signed `kind:27235` event on HTTP bridge endpoints | HTTP clients |

On success, `ConnectionState.auth_state` transitions from `Pending` → `Authenticated(AuthContext)`. On failure → `Failed`. Unauthenticated EVENT/REQ messages are rejected with `["CLOSED", ...]` or `["OK", ..., false, "auth-required: ..."]`.

## Step 4: Active Loops

Three concurrent tasks run for the lifetime of the connection:

- **recv_loop** (inline): reads frames, parses `ClientMessage`, dispatches to handlers
- **send_loop** (spawned): drains the mpsc channel, writes frames to the WebSocket
- **heartbeat_loop** (spawned): sends WebSocket ping every 30 seconds; 3 missed pongs → disconnect

A `CancellationToken` coordinates shutdown across all three loops.

Slow clients: `ConnectionState::send()` uses `try_send` — if the send buffer is full, a grace counter increments. After `SLOW_CLIENT_GRACE_LIMIT` (3) consecutive full-buffer events, the connection is cancelled. A successful send resets the counter.

## Step 5: Cleanup

On disconnect (any cause):
1. `cancel.cancel()` — signals all loops
2. Await send_loop and heartbeat_loop tasks
3. `sub_registry.remove_connection(conn_id)` — removes all subscriptions from the DashMap indexes
4. `conn_manager.deregister(conn_id)` — removes from the send-channel map
5. `drop(permit)` — releases the connection semaphore slot

