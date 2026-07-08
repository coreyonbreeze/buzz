//! Relay startup wiring for the inter-relay mesh (`BUZZ_MESH` seam).
//!
//! [`boot_mesh`] is the ONLY place the relay constructs mesh machinery. It
//! returns `None` — and touches nothing — when `BUZZ_MESH=off`, so mesh-off
//! deployments stay byte-identical to a relay built before this module
//! existed. When enabled, it:
//!
//! 1. binds the iroh endpoint on `BUZZ_MESH_BIND_ADDR` (boot-unique keypair =
//!    boot-unique `RuntimeId`),
//! 2. publishes a relay-key-attested [`ReadyRecord`] to the Redis ready
//!    registry and starts the readiness-gated heartbeat,
//! 3. starts the [`MeshRuntime`] loops (accept, reconcile/dial, gossip) and
//!    runs one immediate reconcile pass so seed peers are dialed at boot,
//! 4. spawns a drain watcher: when the relay's `shutting_down` flag flips,
//!    membership gossips `draining=true` and the heartbeat clears the
//!    registry record.
//!
//! Consumers (huddle control plane, reliable-stream tunnels) reach the mesh
//! exclusively through [`MeshHandle`] via `AppState::mesh()` — `None` means
//! "behave exactly like a single-instance relay."

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use buzz_relay_mesh::endpoint::MeshEndpoint;
use buzz_relay_mesh::gossip::GossipRecord;
use buzz_relay_mesh::registry::{ReadyRecord, ReadyRegistry};
use buzz_relay_mesh::{
    InboundHandler, MeshDatagram, MeshMembership, MeshRuntime, MeshStatus, MeshStream, Profile,
    RelayMeshMembership, RelayPeerTransport, RuntimeId, StreamHello, StreamRole,
};

use crate::config::Config;
use crate::tunnel::directory::SessionDirectory;

/// Handler for one inbound session-stream profile. Called on the accept task;
/// implementations must hand off promptly (spawn) rather than block.
pub type SessionStreamHandler = Box<dyn Fn(RuntimeId, StreamHello, MeshStream) + Send + Sync>;

/// Handler for inbound realtime-media datagrams.
pub type DatagramHandler = Box<dyn Fn(RuntimeId, MeshDatagram) + Send + Sync>;

/// The single [`InboundHandler`] slot owner: fans inbound mesh traffic out to
/// per-profile consumers.
///
/// The transport has exactly one inbound slot (`set_inbound`), but two lanes
/// consume session streams (`HuddleControl`, `ReliableStream`) and one
/// consumes datagrams (`RealtimeMedia`). This dispatcher is installed once by
/// [`boot_mesh`]; consumers register their entrypoints afterwards via the
/// `register_*` methods on [`MeshHandle`]'s dispatcher. Traffic arriving
/// before a slot is registered is logged and dropped — a bounded boot-window
/// race; fencing makes the peer's retry safe.
#[derive(Clone, Default)]
pub struct MeshInboundDispatcher {
    slots: Arc<DispatcherSlots>,
}

#[derive(Default)]
struct DispatcherSlots {
    huddle_control: OnceLock<SessionStreamHandler>,
    reliable_stream: OnceLock<SessionStreamHandler>,
    datagrams: OnceLock<DatagramHandler>,
}

impl MeshInboundDispatcher {
    /// Register the `HuddleControl` session-stream consumer (huddle join lane).
    /// First registration wins; later calls are logged and ignored.
    pub fn register_huddle_control(&self, handler: SessionStreamHandler) {
        if self.slots.huddle_control.set(handler).is_err() {
            tracing::warn!("mesh dispatcher: huddle_control handler already registered — ignored");
        }
    }

    /// Register the `ReliableStream` session-stream consumer (goose/berd lane).
    pub fn register_reliable_stream(&self, handler: SessionStreamHandler) {
        if self.slots.reliable_stream.set(handler).is_err() {
            tracing::warn!("mesh dispatcher: reliable_stream handler already registered — ignored");
        }
    }

    /// Register the realtime-media datagram consumer (huddle audio fan-out).
    pub fn register_datagrams(&self, handler: DatagramHandler) {
        if self.slots.datagrams.set(handler).is_err() {
            tracing::warn!("mesh dispatcher: datagram handler already registered — ignored");
        }
    }
}

impl InboundHandler for MeshInboundDispatcher {
    fn on_datagram(&self, from: RuntimeId, dgram: MeshDatagram) {
        match self.slots.datagrams.get() {
            Some(handler) => handler(from, dgram),
            None => tracing::warn!(
                peer = %from,
                "mesh dispatcher: datagram before handler registration — dropped"
            ),
        }
    }

    fn on_session_stream(&self, from: RuntimeId, hello: StreamHello, stream: MeshStream) {
        let StreamRole::Session { profile, .. } = &hello.role else {
            // Control streams are consumed inside the runtime and never reach
            // the inbound slot; anything else here is a peer bug.
            tracing::warn!(peer = %from, "mesh dispatcher: non-session stream role — dropped");
            return;
        };
        let slot = match profile {
            Profile::HuddleControl => &self.slots.huddle_control,
            Profile::ReliableStream => &self.slots.reliable_stream,
            Profile::RealtimeMedia => {
                // Datagram-only profile: a *stream* claiming it is a protocol
                // violation, never a valid session.
                tracing::warn!(
                    peer = %from,
                    "mesh dispatcher: RealtimeMedia arrived as a stream (datagram-only profile) — rejected"
                );
                return;
            }
        };
        match slot.get() {
            Some(handler) => handler(from, hello, stream),
            None => tracing::warn!(
                peer = %from,
                ?profile,
                "mesh dispatcher: session stream before handler registration — dropped"
            ),
        }
    }
}

/// Everything a mesh consumer needs, as one bundle.
#[derive(Clone)]
pub struct MeshHandle {
    /// Redis fenced session directory — the ownership arbiter.
    pub directory: SessionDirectory,
    /// Fenced byte transport to peer runtimes.
    pub transport: Arc<dyn RelayPeerTransport>,
    /// Routing hints: who is alive / draining / dialable.
    pub membership: Arc<dyn RelayMeshMembership>,
    /// This runtime's boot-unique mesh identity.
    pub local_runtime_id: RuntimeId,
    /// Per-profile inbound registration: consumers call
    /// `dispatcher.register_*` to receive their profile's traffic. The
    /// dispatcher itself is already installed as the transport's single
    /// inbound slot by [`boot_mesh`].
    pub dispatcher: MeshInboundDispatcher,
    /// The single local generation floor for huddle audio. Shared so the
    /// datagram receive path (`MeshAudioRouter`, wired via `register_*`) and
    /// the non-owner teardown path (`audio::handler`) consult and clear ONE
    /// floor — a private floor per consumer would let a torn-down session keep
    /// suppressing a rejoin. It is a *local stale-frame guard only*: Redis
    /// fenced CAS remains the ownership arbiter; `forget` clears local
    /// suppression after teardown and never authorizes ownership.
    pub audio_fence: Arc<crate::audio::mesh::GenerationFloor>,
    /// The running mesh (status snapshots, shutdown).
    runtime: MeshRuntime,
}

impl MeshHandle {
    /// Live `/_mesh` status snapshot.
    pub fn status(&self) -> MeshStatus {
        self.runtime.membership().status()
    }
}

/// Wire protocol version advertised in registry/gossip records.
const PROTO_VERSION: u16 = buzz_relay_mesh::WIRE_VERSION as u16;

/// Capabilities advertised by this build. All three tunnel profiles ship in
/// the same binary, so the list is static.
fn capabilities() -> Vec<String> {
    vec![
        "reliable-stream".to_string(),
        "realtime-media".to_string(),
        "huddle-control".to_string(),
    ]
}

/// Addresses peers should dial, in preference order:
/// `BUZZ_MESH_ADVERTISE_ADDR` (explicit, classic-LB shapes) →
/// `POD_IP` + actual bound port (k8s Downward API, zero RBAC) →
/// every IP transport addr the endpoint reports (dev/local).
fn advertise_addrs(endpoint: &MeshEndpoint) -> Vec<String> {
    if let Ok(addr) = std::env::var("BUZZ_MESH_ADVERTISE_ADDR") {
        let addr = addr.trim().to_string();
        if !addr.is_empty() {
            return vec![addr];
        }
    }

    let ip_addrs = endpoint.ip_addrs();
    let bound_port = ip_addrs.first().map(|sock| sock.port()).unwrap_or(0);

    if let Ok(pod_ip) = std::env::var("POD_IP") {
        let pod_ip = pod_ip.trim();
        if !pod_ip.is_empty() && bound_port != 0 {
            return vec![format!("{pod_ip}:{bound_port}")];
        }
    }

    ip_addrs.iter().map(|sock| sock.to_string()).collect()
}

/// Boot the mesh, or return `None` when `BUZZ_MESH=off`.
///
/// Never fatal to relay startup by policy? No — a *misconfigured* enabled mesh
/// fails loudly (bind failure, Redis unreachable at publish). An operator who
/// sets `BUZZ_MESH=on` wants the mesh or wants to know why not; silently
/// booting meshless would be the same class of bug as silently dropping to a
/// default tenant.
pub async fn boot_mesh(
    config: &Config,
    redis_pool: deadpool_redis::Pool,
    relay_keypair: &nostr::Keys,
    shutting_down: Arc<AtomicBool>,
) -> anyhow::Result<Option<MeshHandle>> {
    if !config.mesh.enabled {
        tracing::info!("mesh disabled (BUZZ_MESH is not 'on') — single-instance behavior");
        return Ok(None);
    }

    let endpoint = MeshEndpoint::bind(config.mesh.bind_addr)
        .await
        .map_err(|e| {
            anyhow::anyhow!(
                "mesh endpoint bind on {} failed: {e}",
                config.mesh.bind_addr
            )
        })?;
    let runtime_id = endpoint.runtime_id();
    let addrs = advertise_addrs(&endpoint);
    tracing::info!(
        runtime_id = %runtime_id,
        bind_addr = %config.mesh.bind_addr,
        advertise_addrs = ?addrs,
        "mesh endpoint bound"
    );

    let mut local_record = GossipRecord::new(runtime_id, addrs.clone(), PROTO_VERSION);
    local_record.capabilities = capabilities();
    // Anchor ready-record acceptance to this deployment's relay identity: all
    // pods share the relay signing key, so a seed attested by any other key is
    // foreign and rejected (Wren's review — possession is not authorization).
    let membership = MeshMembership::new(local_record)
        .with_expected_relay_pubkey(relay_keypair.public_key().to_hex());

    let registry = ReadyRegistry::new(redis_pool.clone(), config.mesh.registry_refresh);
    let ready_record = ReadyRecord::new(
        runtime_id,
        relay_keypair,
        addrs,
        PROTO_VERSION,
        capabilities(),
    );

    // First publish is part of boot: if Redis can't take the attested record,
    // peers can never find us — fail loudly now, not quietly forever.
    registry
        .publish_ready(&ready_record)
        .await
        .map_err(|e| anyhow::anyhow!("mesh ready-registry publish failed: {e}"))?;
    tracing::info!(runtime_id = %runtime_id, "mesh ready record published");

    // Readiness-gated heartbeat: publishes while the relay would pass
    // readiness, clears the record on ready→not-ready and on shutdown.
    let hb_flag = Arc::clone(&shutting_down);
    buzz_relay_mesh::runtime::spawn_registry_heartbeat(
        registry.clone(),
        ready_record,
        Arc::new(move || !hb_flag.load(Ordering::Relaxed)),
    );

    let runtime = MeshRuntime::start(endpoint, membership, Some(registry));
    // Dial seed peers now rather than waiting for the first reconcile tick.
    runtime.reconcile_now().await;

    // Drain watcher: SIGTERM flips `shutting_down`; gossip `draining=true` so
    // peers stop routing new sessions here while in-flight ones drain.
    {
        let runtime = runtime.clone();
        let flag = shutting_down;
        tokio::spawn(async move {
            loop {
                if flag.load(Ordering::Relaxed) {
                    runtime.membership().begin_drain();
                    tracing::info!("mesh drain started (draining=true gossiped)");
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        });
    }

    let membership_arc: Arc<dyn RelayMeshMembership> = Arc::new(runtime.membership().clone());
    let transport: Arc<dyn RelayPeerTransport> = Arc::new(runtime.clone());

    // Install the profile dispatcher as the transport's single inbound slot.
    // Consumers (huddle control, reliable-stream) register their entrypoints
    // on the handle's dispatcher after AppState wiring.
    let dispatcher = MeshInboundDispatcher::default();
    transport.set_inbound(Box::new(dispatcher.clone()));

    Ok(Some(MeshHandle {
        directory: SessionDirectory::new(redis_pool),
        transport,
        membership: membership_arc,
        local_runtime_id: runtime_id,
        dispatcher,
        audio_fence: Arc::new(crate::audio::mesh::GenerationFloor::new()),
        runtime,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BUZZ_MESH=off must be a hard no-op: no endpoint bind, no Redis write,
    /// no background task — `boot_mesh` returns `None` before touching
    /// anything. The Redis pool here points nowhere routable; if the off path
    /// ever reached Redis this test would hang/fail.
    #[tokio::test]
    async fn mesh_off_boots_nothing() {
        let mut config = crate::config::Config::from_env().expect("default config loads");
        config.mesh.enabled = false;
        let pool = deadpool_redis::Config::from_url("redis://127.0.0.1:1") // unroutable
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .unwrap();
        let keys = nostr::Keys::generate();
        let handle = boot_mesh(&config, pool, &keys, Arc::new(AtomicBool::new(false)))
            .await
            .expect("off path is never an error");
        assert!(handle.is_none());
    }

    /// Blocker fix (Wren review of 8b077fdb): absent `BUZZ_MESH`, the mesh is
    /// OFF — an env-untouched image upgrade must not bind or write Redis.
    #[test]
    fn mesh_defaults_off_when_env_absent() {
        // `Config::from_env` in the test env has no BUZZ_MESH set unless a
        // caller exported it; assert the fail-safe reading.
        if std::env::var("BUZZ_MESH").is_ok() {
            return; // externally forced — skip rather than assert a lie
        }
        let config = crate::config::Config::from_env().expect("default config loads");
        assert!(!config.mesh.enabled, "BUZZ_MESH absent must mean mesh off");
    }

    use std::sync::Mutex;

    use buzz_relay_mesh::{
        BoxFuture, FencedHeader, MeshError, MeshStreamFrame, StreamRecvHalf, StreamSendHalf,
    };

    struct StubSend;
    impl StreamSendHalf for StubSend {
        fn send_frame(&mut self, _frame: MeshStreamFrame) -> BoxFuture<'_, Result<(), MeshError>> {
            Box::pin(async { Ok(()) })
        }
        fn finish(&mut self) -> Result<(), MeshError> {
            Ok(())
        }
    }
    struct StubRecv;
    impl StreamRecvHalf for StubRecv {
        fn recv_frame(&mut self) -> BoxFuture<'_, Result<Option<MeshStreamFrame>, MeshError>> {
            Box::pin(async { Ok(None) })
        }
    }

    fn stub_stream() -> MeshStream {
        MeshStream::new(Box::new(StubSend), Box::new(StubRecv))
    }

    fn rid(byte: u8) -> RuntimeId {
        RuntimeId([byte; 32])
    }

    fn session_hello(sender: RuntimeId, profile: Profile) -> StreamHello {
        StreamHello {
            sender,
            role: buzz_relay_mesh::StreamRole::Session {
                fenced: FencedHeader {
                    session_id: uuid::Uuid::nil(),
                    generation: 1,
                    owner_runtime_id: sender,
                },
                profile,
            },
        }
    }

    #[test]
    fn dispatcher_routes_session_streams_by_profile() {
        let dispatcher = MeshInboundDispatcher::default();
        let huddle_hits: Arc<Mutex<Vec<RuntimeId>>> = Arc::new(Mutex::new(vec![]));
        let reliable_hits: Arc<Mutex<Vec<RuntimeId>>> = Arc::new(Mutex::new(vec![]));

        let h = Arc::clone(&huddle_hits);
        dispatcher.register_huddle_control(Box::new(move |from, _hello, _stream| {
            h.lock().unwrap().push(from);
        }));
        let r = Arc::clone(&reliable_hits);
        dispatcher.register_reliable_stream(Box::new(move |from, _hello, _stream| {
            r.lock().unwrap().push(from);
        }));

        dispatcher.on_session_stream(
            rid(1),
            session_hello(rid(1), Profile::HuddleControl),
            stub_stream(),
        );
        dispatcher.on_session_stream(
            rid(2),
            session_hello(rid(2), Profile::ReliableStream),
            stub_stream(),
        );
        // Datagram-only profile arriving as a stream: rejected, routed nowhere.
        dispatcher.on_session_stream(
            rid(3),
            session_hello(rid(3), Profile::RealtimeMedia),
            stub_stream(),
        );

        assert_eq!(*huddle_hits.lock().unwrap(), vec![rid(1)]);
        assert_eq!(*reliable_hits.lock().unwrap(), vec![rid(2)]);
    }

    #[test]
    fn dispatcher_drops_traffic_before_registration_and_keeps_first_handler() {
        let dispatcher = MeshInboundDispatcher::default();

        // Pre-registration traffic must not panic — logged and dropped.
        dispatcher.on_session_stream(
            rid(1),
            session_hello(rid(1), Profile::HuddleControl),
            stub_stream(),
        );
        dispatcher.on_datagram(
            rid(1),
            MeshDatagram {
                fenced: FencedHeader {
                    session_id: uuid::Uuid::nil(),
                    generation: 1,
                    owner_runtime_id: rid(1),
                },
                seq: 0,
                payload: vec![],
            },
        );

        let first: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
        let f = Arc::clone(&first);
        dispatcher.register_datagrams(Box::new(move |_, _| *f.lock().unwrap() += 1));
        // Second registration is ignored; the first handler keeps the slot.
        dispatcher.register_datagrams(Box::new(|_, _| panic!("second handler must not win")));

        dispatcher.on_datagram(
            rid(2),
            MeshDatagram {
                fenced: FencedHeader {
                    session_id: uuid::Uuid::nil(),
                    generation: 1,
                    owner_runtime_id: rid(2),
                },
                seq: 1,
                payload: vec![],
            },
        );
        assert_eq!(*first.lock().unwrap(), 1);
    }
}
