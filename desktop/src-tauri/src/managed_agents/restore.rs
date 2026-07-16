#[cfg(feature = "mesh-llm")]
use super::relay_mesh_model_id;
use super::{
    find_managed_agent_mut, kill_stale_tracked_processes, load_managed_agents, load_personas,
    save_managed_agents, spawn_agent_child, sync_managed_agent_processes, BackendKind,
    ManagedAgentProcess, ManagedAgentRecord,
};
use crate::app_state::AppState;
use crate::util;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

type SpawnResult = Result<ManagedAgentProcess, String>;
type AgentSpawnResult = (String, SpawnResult);

/// Backfill the pinned persona snapshot for pre-existing agents created before
/// the record became the spawn source of truth. Runs once at launch, before
/// `activate_workspace_agents` spawns anything, so no agent boots from an
/// empty snapshot.
///
/// Only records with a `persona_id` but no `persona_source_version` are touched.
/// Records that already have a `persona_source_version` — including those whose
/// `model`/`provider` were clobbered by the old unconditional snapshot code before
/// this fix — are skipped here; they self-heal on the next manual start via the
/// start-path re-snapshot in `start_local_agent_with_preflight`.
/// If the linked persona is gone, we log loudly and leave the snapshot empty —
/// the record's own `system_prompt`/`model` (possibly empty for persona-created
/// agents) is then all the config that remains, which is the same fallback an
/// orphaned agent already gets.
pub fn backfill_persona_snapshots(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;

    let mut records = load_managed_agents(app)?;
    let needs_backfill = records
        .iter()
        .any(|r| r.persona_id.is_some() && r.persona_source_version.is_none());
    if !needs_backfill {
        return Ok(());
    }

    let personas = load_personas(app)?;
    let mut changed = false;
    for record in records.iter_mut() {
        let Some(persona_id) = record.persona_id.clone() else {
            continue;
        };
        if record.persona_source_version.is_some() {
            continue;
        }
        let Some(persona) = personas.iter().find(|p| p.id == persona_id) else {
            eprintln!(
                "buzz-desktop: persona-snapshot backfill: agent {} links persona {persona_id} which no longer exists; leaving snapshot empty — it will spawn from its record fields",
                record.pubkey
            );
            continue;
        };
        // Layer precedence at read time: persona env < agent env. When the
        // persona leaves model/provider blank, the record's own configured
        // values are preserved — a blank persona must not clobber a
        // user-configured agent. See `apply_persona_snapshot`.
        super::persona_events::apply_persona_snapshot(record, persona);
        record.updated_at = util::now_iso();
        changed = true;
    }

    if changed {
        save_managed_agents(app, &records)?;
    }
    Ok(())
}

/// Scope of a relay activation granted by [`begin_relay_activation`].
pub(crate) struct RelayActivation {
    /// True only for the session's very first activation (the boot restore):
    /// the one-shot stale-process and orphan sweeps run only then. Later
    /// activations must not re-sweep — a concurrent activation's freshly
    /// spawned children are not yet tracked and would read as orphans.
    pub run_boot_sweeps: bool,
}

/// Record `relay_url` as activated for this app session, deciding whether the
/// caller may start its agents.
///
/// Returns `None` when the URL is blank or this relay was already activated
/// this session — the caller must not start agents again, so bouncing A→B→A
/// never resurrects an agent the user manually stopped in A. Activation is
/// marked at attempt time (a failed attempt is not retried until relaunch),
/// matching the old one-shot restore flag. Relays are keyed normalized
/// (trailing slash, scheme/host case), so cosmetic URL differences cannot
/// re-activate a workspace.
pub(crate) fn begin_relay_activation(
    activated_relays: &mut HashSet<String>,
    relay_url: &str,
) -> Option<RelayActivation> {
    let normalized = crate::relay::normalize_relay_url(relay_url);
    if normalized.is_empty() {
        return None;
    }
    let run_boot_sweeps = activated_relays.is_empty();
    if !activated_relays.insert(normalized) {
        return None;
    }
    Some(RelayActivation { run_boot_sweeps })
}

/// Whether `record` auto-starts when `workspace_relay_url` is activated:
/// a local start-on-launch agent pinned to this relay. A blank pin matches
/// the workspace being activated — mirroring `effective_agent_relay_url`'s
/// defense-in-depth fallback — so a record that somehow escaped relay
/// stamping still auto-starts against the relay it resolves to at spawn.
pub(crate) fn record_activates_on_relay(
    record: &ManagedAgentRecord,
    workspace_relay_url: &str,
) -> bool {
    if !record.start_on_app_launch || record.backend != BackendKind::Local {
        return false;
    }
    let pinned = record.relay_url.trim();
    pinned.is_empty() || crate::relay::relay_urls_equivalent(pinned, workspace_relay_url)
}

/// Lazily activate a workspace's managed agents.
///
/// Called from every `apply_workspace`: starts local `start_on_app_launch`
/// agents pinned to `workspace_relay_url` that are not already running — the
/// launch restore is simply the session's first activation. Each workspace
/// activates at most once per app session ([`begin_relay_activation`]), and
/// nothing is ever stopped here: switching away leaves the previous
/// workspace's agents running against their own relay.
///
/// Split into three phases to minimise lock contention with the frontend:
///   A (under lock): sync process state, cleanup, collect agents to start
///   B (no locks):   resolve commands and spawn processes in parallel
///   C (re-lock):    write back PIDs and status to records on disk
pub async fn activate_workspace_agents(
    app: &tauri::AppHandle,
    shutdown_started: &AtomicBool,
    workspace_relay_url: &str,
) -> Result<(), String> {
    if shutdown_started.load(Ordering::SeqCst) {
        return Ok(());
    }

    let state = app.state::<AppState>();

    // Session-wide boot gate: repos-dir resolution and identity recovery are
    // decided once at launch. When either fails closed, no workspace may
    // auto-start agents this session.
    if !state
        .managed_agent_activation_enabled
        .load(Ordering::Acquire)
    {
        return Ok(());
    }

    let Some(activation) = ({
        let mut activated_relays = state
            .activated_agent_relays
            .lock()
            .map_err(|error| error.to_string())?;
        begin_relay_activation(&mut activated_relays, workspace_relay_url)
    }) else {
        return Ok(());
    };

    // ── Phase A (under lock): housekeeping + collect agents to activate ──
    let mut agents_to_start: Vec<super::ManagedAgentRecord>;
    {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;

        if shutdown_started.load(Ordering::SeqCst) {
            return Ok(());
        }

        let mut records = load_managed_agents(app)?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;
        let (mut changed, _exited) = sync_managed_agent_processes(
            &mut records,
            &mut runtimes,
            &super::current_instance_id(app),
        );

        // One-shot boot cleanup: previous-session leftovers and orphans are
        // swept only on the session's first activation. Later activations
        // must not sweep — a concurrent activation's or UI start's freshly
        // spawned children are not yet in the tracked set and would be killed
        // as orphans.
        if activation.run_boot_sweeps {
            changed |= kill_stale_tracked_processes(
                &mut records,
                &runtimes,
                &super::current_instance_id(app),
            );

            let tracked_pids: Vec<u32> = records
                .iter()
                .filter_map(|r| r.runtime_pid)
                .chain(runtimes.values().map(|rt| rt.child.id()))
                .collect();
            super::sweep_orphaned_agent_processes(app, &tracked_pids);

            // System-wide sweep: enumerate all user processes and kill any known
            // agent binaries not tracked by this session. Catches orphans whose
            // PID files were already cleaned up (e.g. agent workers in their own
            // process group whose parent harness exited).
            super::sweep_system_agent_processes(&super::current_instance_id(app), &tracked_pids);

            // Dead-instance reaping: find agents belonging to Buzz instances
            // whose desktop process is no longer running and reap them.
            super::reap_dead_instance_agents(&super::current_instance_id(app), &tracked_pids);

            // Exact-path sweep: kill any buzz-acp process whose executable path
            // matches this bundle's harness binary but is not in the tracked set.
            // Complements the env-var sweep above — catches orphans that predate
            // BUZZ_MANAGED_AGENT injection or lost their PID-file receipt.
            //
            // TODO: the three sweeps above each walk the PID table independently.
            // A future consolidation should collect a single shared process snapshot
            // at the top of this block and thread it through all sweep functions,
            // replacing the three separate kernel enumerations.
            super::sweep_untracked_bundle_harnesses(&tracked_pids);
        }

        let candidates: Vec<String> = records
            .iter()
            .filter(|record| record_activates_on_relay(record, workspace_relay_url))
            .map(|record| record.pubkey.clone())
            .collect();

        let mut to_start = Vec::new();
        for pubkey in &candidates {
            if let Some(runtime) = runtimes.get_mut(pubkey) {
                if runtime.child.try_wait().ok().flatten().is_none() {
                    continue;
                }
            }
            if let Some(record) = records.iter().find(|r| r.pubkey == *pubkey) {
                if let Some(pid) = record.runtime_pid {
                    if super::process_is_running(pid) {
                        continue;
                    }
                }
                to_start.push(record.clone());
            }
        }
        agents_to_start = to_start;

        // Re-snapshot persona config for agents about to be restored, matching
        // the interactive spawn path so auto-start agents also pick up the
        // current persona on app launch.
        let personas_for_snapshot = super::load_personas(app).unwrap_or_default();
        for record in records.iter_mut() {
            if !agents_to_start.iter().any(|r| r.pubkey == record.pubkey) {
                continue;
            }
            let Some(persona_id) = record.persona_id.clone() else {
                continue;
            };
            let Some(persona) = personas_for_snapshot.iter().find(|p| p.id == persona_id) else {
                continue;
            };
            super::persona_events::apply_persona_snapshot(record, persona);
            record.updated_at = util::now_iso();
            changed = true;
        }
        // Re-collect to_start from the updated records so Phase B spawns the refreshed config.
        agents_to_start = records
            .iter()
            .filter(|r| agents_to_start.iter().any(|s| s.pubkey == r.pubkey))
            .cloned()
            .collect();

        if changed {
            save_managed_agents(app, &records)?;
        }
    }

    if agents_to_start.is_empty() {
        return Ok(());
    }

    // Snapshot the workspace owner pubkey once for the legacy auth_tag fallback.
    // Read outside the per-agent spawn loop so all parallel spawns see the same
    // value and we don't lock `state.keys` repeatedly.
    let owner_hex: Option<String> = state
        .keys
        .lock()
        .map_err(|e| e.to_string())
        .ok()
        .map(|k| k.public_key().to_hex());

    #[cfg(feature = "mesh-llm")]
    let agents_to_start = {
        let mut mesh_preflight_failures = std::collections::HashSet::new();
        for record in &agents_to_start {
            if relay_mesh_model_id(record).is_none() {
                continue;
            }
            // Auto-start after relaunch: re-resolve a live bootstrap target and
            // dial it. Skip (with an actionable error) only when no live target
            // serves this model right now.
            if let Err(error) =
                crate::commands::ensure_relay_mesh_for_record(app, record, false).await
            {
                persist_restore_error(app, &state, &record.pubkey, error)?;
                mesh_preflight_failures.insert(record.pubkey.clone());
            }
        }
        agents_to_start
            .into_iter()
            .filter(|record| !mesh_preflight_failures.contains(&record.pubkey))
            .collect::<Vec<_>>()
    };
    if agents_to_start.is_empty() {
        return Ok(());
    }

    // Serialize spawning and runtime registration with shutdown cleanup. The
    // shutdown flag is rechecked after taking the lock so shutdown either
    // prevents this transition or waits until every child is tracked and can
    // be terminated.
    let restore_transition = state
        .managed_agent_restore_transition
        .lock()
        .map_err(|error| error.to_string())?;
    if shutdown_started.load(Ordering::SeqCst) {
        return Ok(());
    }

    // ── Phase B (no locks): resolve commands and spawn processes in parallel ──
    let spawn_results: Vec<AgentSpawnResult> = std::thread::scope(|scope| {
        let owner_hex_ref = owner_hex.as_deref();
        let handles: Vec<_> = agents_to_start
            .iter()
            .filter(|_| !shutdown_started.load(Ordering::SeqCst))
            .map(|record| {
                let pubkey = record.pubkey.clone();
                let handle = scope.spawn(move || {
                    let result = spawn_agent_child(app, record, owner_hex_ref);
                    (pubkey, result)
                });
                handle
            })
            .collect();

        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    if spawn_results.is_empty() {
        return Ok(());
    }

    // ── Phase C (re-acquire lock): write back PIDs and status to records ──
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let mut records = load_managed_agents(app)?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|error| error.to_string())?;

    let mut successfully_spawned: Vec<String> = Vec::new();

    for (pubkey, result) in spawn_results {
        let record = match find_managed_agent_mut(&mut records, &pubkey) {
            Ok(r) => r,
            Err(_) => continue,
        };
        match result {
            Ok(process) => {
                let now = util::now_iso();
                record.updated_at = now.clone();
                record.runtime_pid = Some(process.child.id());
                record.last_started_at = Some(now);
                record.last_stopped_at = None;
                record.last_exit_code = None;
                record.last_error = None;
                runtimes.insert(pubkey.clone(), process);
                successfully_spawned.push(pubkey);
            }
            Err(error) => {
                record.updated_at = util::now_iso();
                record.last_error = Some(error);
            }
        }
    }

    // Collect profile reconciliation data for successfully spawned agents before
    // releasing the lock. This mirrors the fire-and-forget pattern in
    // start_managed_agent — ensuring boot-restored agents get the same profile
    // self-healing as UI-started agents.
    let reconcile_personas = super::load_personas(app).unwrap_or_default();
    let reconcile_items: Vec<(String, crate::commands::ProfileReconcileData)> =
        successfully_spawned
            .iter()
            .filter_map(|pubkey| {
                let record = records.iter().find(|r| r.pubkey == *pubkey)?;
                // Resolve the effective harness for the avatar-fallback
                // derivation (the snapshot may be empty/stale for an inherited
                // harness). Mirrors the UI start path.
                let effective_command =
                    crate::managed_agents::record_agent_command(record, &reconcile_personas);
                Some((
                    pubkey.clone(),
                    crate::commands::ProfileReconcileData {
                        private_key_nsec: record.private_key_nsec.clone(),
                        name: record.name.clone(),
                        relay_url: record.relay_url.clone(),
                        avatar_url: record.avatar_url.clone(),
                        auth_tag: record.auth_tag.clone(),
                        pubkey: record.pubkey.clone(),
                        agent_command: effective_command,
                        persona_id: record.persona_id.clone(),
                    },
                ))
            })
            .collect();

    save_managed_agents(app, &records)?;
    drop(runtimes);
    drop(_store_guard);
    drop(restore_transition);

    // ── Profile reconciliation (fire-and-forget) ────────────────────────────
    // Spawn background tasks to ensure each restored agent's kind:0 profile is
    // published on the relay. Same pattern as the UI start path.
    for (pubkey, data) in reconcile_items {
        let reconcile_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = reconcile_app.state::<AppState>();
            if let Err(e) =
                crate::commands::reconcile_agent_profile(&state, &reconcile_app, &pubkey, &data)
                    .await
            {
                eprintln!("buzz-desktop: profile reconciliation failed for agent {pubkey}: {e}");
            }
        });
    }

    Ok(())
}

#[cfg(feature = "mesh-llm")]
fn persist_restore_error(
    app: &tauri::AppHandle,
    state: &AppState,
    pubkey: &str,
    error: String,
) -> Result<(), String> {
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let mut records = load_managed_agents(app)?;
    let record = find_managed_agent_mut(&mut records, pubkey)?;
    record.updated_at = util::now_iso();
    record.last_error = Some(error);
    save_managed_agents(app, &records)
}

#[cfg(test)]
mod tests {
    use super::{begin_relay_activation, record_activates_on_relay, ManagedAgentRecord};
    use std::collections::HashSet;

    /// Minimal record with the fields the activation filter reads. Everything
    /// else takes its serde default (`start_on_app_launch` defaults to true,
    /// `backend` to Local).
    fn record_on_relay(relay_url: &str) -> ManagedAgentRecord {
        serde_json::from_str(&format!(
            r#"{{
                "pubkey": "agent-pubkey",
                "name": "test-agent",
                "private_key_nsec": "nsec1fake",
                "relay_url": "{relay_url}",
                "acp_command": "buzz-acp",
                "agent_command": "goose",
                "agent_args": [],
                "mcp_command": "",
                "turn_timeout_seconds": 320,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z"
            }}"#
        ))
        .expect("sample record")
    }

    // ── begin_relay_activation: once per relay per session ──────────────────

    #[test]
    fn first_activation_of_session_runs_boot_sweeps() {
        let mut activated = HashSet::new();

        let activation = begin_relay_activation(&mut activated, "wss://relay-a.example")
            .expect("first visit must activate");

        assert!(activation.run_boot_sweeps, "boot restore sweeps orphans");
    }

    #[test]
    fn second_workspace_activates_without_boot_sweeps() {
        let mut activated = HashSet::new();
        begin_relay_activation(&mut activated, "wss://relay-a.example");

        let activation = begin_relay_activation(&mut activated, "wss://relay-b.example")
            .expect("a new workspace must activate");

        assert!(
            !activation.run_boot_sweeps,
            "sweeps are one-shot: a later activation could kill a concurrent \
             activation's untracked children"
        );
    }

    #[test]
    fn revisiting_a_workspace_does_not_reactivate() {
        // A→B→A: the second visit to A must not restart agents the user
        // stopped there, even when the URL differs only cosmetically.
        let mut activated = HashSet::new();
        begin_relay_activation(&mut activated, "wss://relay-a.example");
        begin_relay_activation(&mut activated, "wss://relay-b.example");

        assert!(begin_relay_activation(&mut activated, "wss://relay-a.example").is_none());
        assert!(
            begin_relay_activation(&mut activated, "WSS://Relay-A.Example/").is_none(),
            "normalized matching: cosmetic URL differences must not re-activate"
        );
    }

    #[test]
    fn blank_relay_never_activates_nor_consumes_the_boot_sweep() {
        let mut activated = HashSet::new();

        assert!(begin_relay_activation(&mut activated, "   ").is_none());

        // The blank no-op must not have claimed the session's boot sweep.
        let activation = begin_relay_activation(&mut activated, "wss://relay-a.example")
            .expect("real relay still activates");
        assert!(activation.run_boot_sweeps);
    }

    // ── record_activates_on_relay: relay-filtered candidate selection ───────

    #[test]
    fn record_activates_only_on_its_pinned_relay() {
        let record = record_on_relay("wss://relay-a.example");

        assert!(record_activates_on_relay(&record, "wss://relay-a.example"));
        assert!(
            record_activates_on_relay(&record, "WSS://Relay-A.Example/"),
            "pin matching is normalized"
        );
        assert!(
            !record_activates_on_relay(&record, "wss://relay-b.example"),
            "visiting another workspace must not start this agent"
        );
    }

    #[test]
    fn blank_pin_activates_on_the_visited_workspace() {
        // Defense-in-depth for a record that escaped relay stamping: it spawns
        // against the active workspace relay (`effective_agent_relay_url`), so
        // it activates with the workspace being visited.
        let record = record_on_relay("");
        assert!(record_activates_on_relay(&record, "wss://relay-a.example"));
    }

    #[test]
    fn opted_out_and_provider_records_never_activate() {
        let mut record = record_on_relay("wss://relay-a.example");
        record.start_on_app_launch = false;
        assert!(!record_activates_on_relay(&record, "wss://relay-a.example"));

        let mut record = record_on_relay("wss://relay-a.example");
        record.backend = super::BackendKind::Provider {
            id: "blox".to_string(),
            config: serde_json::Value::Null,
        };
        assert!(!record_activates_on_relay(&record, "wss://relay-a.example"));
    }
}
