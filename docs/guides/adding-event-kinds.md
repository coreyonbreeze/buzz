# Adding a New Event Kind

Every action in Buzz is a Nostr event with a kind integer — adding a feature
usually means adding a kind, not a new API. Prefer reusing an existing kind
with new tags over minting a new number when the semantics genuinely match.
The authoritative registry is
[`crates/buzz-core/src/kind.rs`](../../crates/buzz-core/src/kind.rs).

1. **Define the kind constant** in `buzz-core/src/kind.rs`:

   ```rust
   /// My new event kind — description of what it represents.
   pub const KIND_MY_FEATURE: u32 = 4XXXX;
   ```

   Pick a kind number in the appropriate sub-range defined in `kind.rs`.
   Check the `ALL_KINDS` array for collisions. Each sub-range is documented
   with comments in the file.

2. **Define the payload type** in the appropriate module in `buzz-core/src/`
   (e.g., alongside `event.rs`) if the content field is structured JSON:

   ```rust
   #[derive(Debug, Serialize, Deserialize)]
   pub struct MyFeaturePayload {
       pub field_one: String,
       pub field_two: Option<u64>,
   }
   ```

3. **Register the kind's required scope** in
   `crates/buzz-relay/src/handlers/ingest.rs` inside
   `required_scope_for_kind()`. This controls which auth scope a caller
   needs to submit the event:

   ```rust
   KIND_MY_FEATURE => Ok(Scope::MessagesWrite),
   ```

4. **Handle post-storage side effects** by adding a match arm in
   `crates/buzz-relay/src/handlers/side_effects.rs` inside
   `handle_side_effects()`:

   ```rust
   KIND_MY_FEATURE => handle_my_feature(event, state).await?,
   ```

   `handle_side_effects()` runs after the event is stored — use it for
   notifications, cache invalidation, or derived data. If the new kind
   also needs an HTTP bridge surface (for example, a protocol helper that
   cannot practically use WebSocket), add a handler in
   `crates/buzz-relay/src/api/` and register it in
   `crates/buzz-relay/src/router.rs`.

5. **Persist to the database** — if the event needs to be queryable, add a
   handler in `buzz-db/src/` (e.g., `buzz-db/src/my_feature.rs`) with
   the appropriate `INSERT` and `SELECT` queries.

6. **Index for search** (if applicable) — Postgres FTS indexes persisted
   events automatically via the `events.search_tsv` generated column. To
   exclude a privacy-sensitive kind from search, add it to the `CASE WHEN
   kind IN (...)` exclusion in the `search_tsv` definition (see the initial
   schema migration) rather than wiring a separate indexer.

7. **Audit** — the audit log captures all events automatically; no changes
   needed unless you need custom audit metadata.

8. **Write tests** — add a unit test for payload serialization in
   `buzz-core` and an integration test in `buzz-test-client` that sends
   the new event kind and verifies the expected behavior.

9. **Document** — `kind.rs` is the authoritative registry of all kind numbers.
   Update `README.md` if it's a user-facing feature.


## Protocol documentation

If the kind is part of a coherent protocol extension (not just an internal
implementation detail), document it as a Buzz NIP in [`docs/nips/`](../nips/)
and add it to the [NIPs index](../reference/nips.md).
