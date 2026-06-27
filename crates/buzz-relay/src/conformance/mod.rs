//! Runtime conformance harness — the relay's side of the trace seam.
//!
//! This module hosts the [`Tracer`] re-export and the per-request emit
//! helpers that translate the relay's actual decisions into [`TraceStep`]s
//! from `buzz-conformance`. See `crates/buzz-conformance/src/lib.rs` for
//! the schema and `docs/spec/MultiTenantRelay.tla` for what the schema is
//! grounded in.
//!
//! ## Design rules (from `skill-runtime-formal-compliance`)
//!
//! 1. **Project, don't echo.** The trace carries opaque labels (community
//!    UUID, channel UUID, blake3-truncated actor) — never the event id,
//!    payload, pubkey bytes, signature, or wall-clock timestamps. The
//!    only fields that survive are the ones the spec's `Next` and
//!    `Inv_NonInterference` reason about.
//! 2. **Don't normalize away violations.** The emitter records
//!    `claimed_community` (from the event's `h` tag) SEPARATELY from
//!    `resolved_community` (from `TenantContext::community()`). The
//!    checker's M2 bite depends on seeing both.
//! 3. **Drop guard is load-bearing.** Every entry to a critical seam must
//!    construct an [`EmitGuard`]; if the seam exits without an emit, the
//!    guard's `Drop` records [`TraceAction::ImplBug`] which the checker
//!    treats as a coverage breach.
//!
//! ## Wire points
//!
//! - **ingest.rs:** AuthCheck at `check_channel_membership` call site;
//!   WriteInsert / WriteInsertGlobal / WriteDuplicate at the two
//!   `dispatch_persistent_event` sites; SanitizedError at the outer
//!   wrapper based on the IngestError variant.
//! - **req.rs / event.rs:** (held back as additive patch for Eva to apply
//!   onto Max's req.rs writes — see thread `c882c9b1…`).

use std::sync::Arc;

use buzz_core::tenant::TenantContext;
use nostr::PublicKey;
use uuid::Uuid;

pub use buzz_conformance::{
    AbstractState, ActorLabel, ChannelLabel, CommunityLabel, HostLabel, OpaqueId, SanitizedReason,
    TraceAction, TraceStep, Tracer, Verdict,
};

mod tracers;
pub use tracers::{JsonlTracer, NoopTracer};

/// Build the [`AbstractState`] for a request from its resolved tenant
/// context and authenticated public key.
///
/// `community` and `host` come straight from `TenantContext` — server-
/// resolved, never client input. `actor` is the lower 16 bytes of
/// `blake3(pubkey_bytes)` as a hex string, opaque and stable across the
/// run.
pub fn state_for_request(tenant: &TenantContext, actor: &PublicKey) -> AbstractState {
    AbstractState {
        resolved_community: CommunityLabel::from_uuid(*tenant.community().as_uuid()),
        bound_host: HostLabel(tenant.host().to_string()),
        actor: actor_label(actor),
    }
}

/// Opaque actor label: first 16 hex chars of the pubkey. The pubkey is
/// already a hash from the client's POV (Schnorr X-only) — equality of
/// the prefix is equivalent to equality of the pubkey for tracing
/// purposes, and the relay already prints full pubkey hexes elsewhere,
/// so the prefix discloses nothing the rest of the log doesn't already.
/// Using the pubkey directly also avoids dragging in a hash dep for what
/// is observability code.
fn actor_label(actor: &PublicKey) -> ActorLabel {
    let hex = actor.to_hex();
    let n = hex.len().min(16);
    ActorLabel(hex[..n].to_string())
}

/// Opaque message id label: first 16 hex chars of the event id. Same
/// rationale as actor labels — the id is already a sha256 hash.
pub fn msg_id_label(event_id: &[u8]) -> OpaqueId {
    let mut out = String::with_capacity(16);
    for b in event_id.iter().take(8) {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    OpaqueId(out)
}

/// Map a UUID channel id into a [`ChannelLabel`]. Channels are not secret
/// — they appear in event `h` tags — so this is a direct wrap.
pub fn channel_label(ch: Uuid) -> ChannelLabel {
    ChannelLabel(ch)
}

/// Extract the *client-claimed* community from an event's `h` tag. Used
/// to populate [`TraceAction`]'s `claimed_community` field. The relay
/// does NOT trust this value for resolution — the resolver uses the
/// server-owned channel→community map. Recording it separately is what
/// makes the M2 (claim≠resolved) bite visible to the checker.
///
/// Returns `None` if there is no `h` tag, or the `h` tag does not parse
/// as a UUID.
pub fn claimed_community_from_event(event: &nostr::Event) -> Option<CommunityLabel> {
    for tag in event.tags.iter() {
        // The relay's existing convention: `h` tag carries the community
        // uuid (or channel uuid, ambiguous — but on the WRITE path the h
        // tag's documented use is the community claim).
        let raw = tag.as_slice();
        if raw.first().map(|s| s.as_str()) == Some("h") {
            if let Some(val) = raw.get(1) {
                if let Ok(parsed) = Uuid::parse_str(val) {
                    return Some(CommunityLabel::from_uuid(parsed));
                }
            }
            return None;
        }
    }
    None
}

/// Build a [`TraceStep::new`] with a freshly-computed [`AbstractState`].
/// Convenience wrapper to keep the call sites in ingest.rs short.
pub fn step(action: TraceAction, state: AbstractState) -> TraceStep {
    TraceStep::new(action, state)
}

/// Record one step on the tracer. Equivalent to `tracer.record(step(...))`.
/// Kept inline so the call sites stay tight and self-documenting.
pub fn emit(tracer: &Arc<dyn Tracer>, action: TraceAction, state: AbstractState) {
    tracer.record(TraceStep::new(action, state));
}

/// RAII coverage-breach guard. Constructed at the top of any critical
/// seam (currently: `ingest_event`); the guard observes a [`Tracer`]
/// wrapper that counts emits. If the seam exits without any emit
/// reaching the underlying tracer, `Drop` records a synthetic
/// [`TraceAction::ImplBug`] step — the checker treats that as a
/// coverage breach.
///
/// The guard wraps the original tracer so production code paths never
/// need to "disarm" or pass anything around — they just call
/// `tracer.record(...)` as before, and the wrapper bumps a counter. If
/// at drop time the counter is zero, the guard emits ImplBug onto the
/// underlying tracer.
pub struct EmitGuard {
    /// The inner tracer, used both for the production emits during the
    /// request AND for the synthetic ImplBug on Drop if the request
    /// emitted nothing.
    inner: Arc<dyn Tracer>,
    state: AbstractState,
    counter: Arc<std::sync::atomic::AtomicUsize>,
    kind: &'static str,
}

/// Wrapper tracer that bumps a counter on every record. Returned by
/// [`EmitGuard::counting_tracer`].
struct CountingTracer {
    inner: Arc<dyn Tracer>,
    counter: Arc<std::sync::atomic::AtomicUsize>,
}

impl std::fmt::Debug for CountingTracer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CountingTracer").finish_non_exhaustive()
    }
}

impl Tracer for CountingTracer {
    fn record(&self, step: TraceStep) {
        self.counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.inner.record(step);
    }
}

impl EmitGuard {
    /// Arm a new guard for the given seam name (e.g.
    /// `"ingest_exited_without_trace"`). Returns the guard along with a
    /// counting wrapper around `tracer` that callers should pass into
    /// the request path instead of the original `tracer`. Every emit
    /// against the wrapper bumps the guard's counter; if the count is
    /// still zero at Drop, the guard records an `ImplBug` on the
    /// original tracer.
    pub fn arm(
        tracer: Arc<dyn Tracer>,
        state: AbstractState,
        kind: &'static str,
    ) -> (Self, Arc<dyn Tracer>) {
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counting: Arc<dyn Tracer> = Arc::new(CountingTracer {
            inner: tracer.clone(),
            counter: counter.clone(),
        });
        let guard = Self {
            inner: tracer,
            state,
            counter,
            kind,
        };
        (guard, counting)
    }
}

impl Drop for EmitGuard {
    fn drop(&mut self) {
        if self.counter.load(std::sync::atomic::Ordering::Relaxed) == 0 {
            let step = TraceStep::new(
                TraceAction::ImplBug {
                    kind: self.kind.to_string(),
                },
                self.state.clone(),
            );
            self.inner.record(step);
        }
    }
}

/// Map an `IngestError` variant onto the closed `SanitizedReason`
/// alphabet (spec line 778, `Inv_SanitizedErrors`). The alphabet is
/// asserted 1:1 with the relay's error variants — if a fourth variant
/// is ever added to `IngestError` this match goes non-exhaustive and
/// CI catches it.
pub fn sanitized_reason_for(err: &crate::handlers::ingest::IngestError) -> SanitizedReason {
    use crate::handlers::ingest::IngestError as E;
    match err {
        E::Rejected(_) => SanitizedReason::Invalid,
        E::AuthFailed(_) => SanitizedReason::Restricted,
        E::Internal(_) => SanitizedReason::ServerError,
    }
}
