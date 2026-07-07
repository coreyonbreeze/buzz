# Adding a New API Endpoint

Prefer a signed Nostr event and the existing WebSocket/`POST /events` ingest
path over adding endpoint-specific JSON APIs. The relay intentionally exposes
only a narrow HTTP surface: NIP-11/NIP-05 metadata, `/events`, `/query`,
`/count`, `/hooks/{id}`, Blossom media, git smart HTTP, git policy hooks, and
health probes.

If an HTTP endpoint is still necessary:

1. **Define the handler** in the appropriate module under
   `crates/buzz-relay/src/api/`. Resolve the request tenant before any auth or
   data lookup, use NIP-98 when the endpoint accepts user credentials, and keep
   community scoping explicit.

2. **Register the route** in `crates/buzz-relay/src/router.rs` using the
   narrowest path possible. Do not add new `/api/*` compatibility routes unless
   the product decision explicitly calls for one.

3. **Add database queries** in `buzz-db/src/` only when the endpoint cannot be
   expressed through the existing event query paths.

4. **Handle errors** using the `api_error()`, `internal_error()`, and
   `not_found()` helpers in `buzz-relay/src/api/mod.rs`. Return
   `(StatusCode, Json<Value>)` tuples.

5. **Write tests** with the `buzz-test-client` harness in
   `crates/buzz-test-client/tests/`, covering auth, community scoping, and the
   relevant success path.

6. **Document** any public endpoint in `ARCHITECTURE.md` and user-facing docs.

