//! Relay-pinning maintenance for managed-agent records.
//!
//! Every agent record is pinned to a home relay URL (the backend-side
//! ownership key): the relay is stamped at create, legacy blank records are
//! stamped on the first `apply_workspace` after boot, and pins follow a
//! community's relay-URL edit via rebind. These are the pure record
//! mutations behind those flows; the store-lock + load/save wrappers live in
//! `commands::workspace`.

use super::types::ManagedAgentRecord;
use crate::util::now_iso;

/// Stamp every keyed record whose `relay_url` is blank with `relay_url`,
/// pinning legacy floating records to a home relay.
///
/// Run against the first workspace applied after boot, this is
/// behavior-preserving: blank resolved to exactly that relay at boot restore
/// (`effective_agent_relay_url`). Once stamped, the record keeps spawning,
/// publishing, and reconciling on its own relay no matter which workspace is
/// active later. Key-less definitions (templates) are left alone. Returns how
/// many records changed.
pub(crate) fn stamp_blank_agent_relay_urls(
    records: &mut [ManagedAgentRecord],
    relay_url: &str,
) -> usize {
    let relay_url = relay_url.trim();
    if relay_url.is_empty() {
        return 0;
    }
    let mut changed = 0;
    for record in records.iter_mut() {
        if record.pubkey.is_empty() || !record.relay_url.trim().is_empty() {
            continue;
        }
        record.relay_url = relay_url.to_string();
        record.updated_at = now_iso();
        changed += 1;
    }
    changed
}

/// Re-pin every keyed record pinned to `old_relay_url` onto `new_relay_url`.
///
/// Used when a community's relay URL is edited: records are pinned to their
/// home relay, so without the rebind the community's agents would orphan on
/// the old URL. Matching is normalized (`relay_urls_equivalent` — trailing
/// slash, scheme/host case); blank records are not touched (they belong to
/// the blank-relay migration, not to `old_relay_url`). Returns how many
/// records changed.
pub(crate) fn rebind_agent_relay_urls(
    records: &mut [ManagedAgentRecord],
    old_relay_url: &str,
    new_relay_url: &str,
) -> usize {
    let new_relay_url = new_relay_url.trim();
    if new_relay_url.is_empty() {
        return 0;
    }
    let mut changed = 0;
    for record in records.iter_mut() {
        if record.pubkey.is_empty()
            || record.relay_url.trim().is_empty()
            || record.relay_url == new_relay_url
            || !crate::relay::relay_urls_equivalent(&record.relay_url, old_relay_url)
        {
            continue;
        }
        record.relay_url = new_relay_url.to_string();
        record.updated_at = now_iso();
        changed += 1;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::{rebind_agent_relay_urls, stamp_blank_agent_relay_urls, ManagedAgentRecord};

    fn record_with_relay(pubkey: &str, relay_url: &str) -> ManagedAgentRecord {
        serde_json::from_str(&format!(
            r#"{{
                "pubkey": "{pubkey}",
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

    // ── stamp_blank_agent_relay_urls ─────────────────────────────────────────

    #[test]
    fn stamp_pins_blank_records_and_leaves_pinned_ones() {
        let mut records = vec![
            record_with_relay("agent-blank", ""),
            record_with_relay("agent-whitespace", "   "),
            record_with_relay("agent-pinned", "wss://relay-other.example"),
        ];

        let changed = stamp_blank_agent_relay_urls(&mut records, "wss://relay-home.example");

        assert_eq!(changed, 2);
        assert_eq!(records[0].relay_url, "wss://relay-home.example");
        assert_eq!(records[1].relay_url, "wss://relay-home.example");
        // An existing pin is ownership — stamping must never overwrite it.
        assert_eq!(records[2].relay_url, "wss://relay-other.example");
    }

    #[test]
    fn stamp_is_idempotent_once_records_are_pinned() {
        // Second boot (or a redundant call) finds nothing blank: exactly-once
        // semantics come from the records themselves, not just the app flag.
        let mut records = vec![record_with_relay("agent-blank", "")];
        stamp_blank_agent_relay_urls(&mut records, "wss://relay-a.example");

        let changed = stamp_blank_agent_relay_urls(&mut records, "wss://relay-b.example");

        assert_eq!(changed, 0);
        assert_eq!(records[0].relay_url, "wss://relay-a.example");
    }

    #[test]
    fn stamp_ignores_blank_workspace_relay_and_definitions() {
        // A blank stamp value would just re-create the floating record; a
        // key-less definition (template) has no home relay to pin.
        let mut records = vec![
            record_with_relay("agent-blank", ""),
            record_with_relay("", ""),
        ];

        assert_eq!(stamp_blank_agent_relay_urls(&mut records, "  "), 0);
        assert_eq!(
            stamp_blank_agent_relay_urls(&mut records, "wss://relay.example"),
            1
        );
        assert_eq!(records[1].relay_url, "", "definition must stay untouched");
    }

    // ── rebind_agent_relay_urls ──────────────────────────────────────────────

    #[test]
    fn rebind_moves_normalized_matches_only() {
        let mut records = vec![
            // Cosmetic mismatch with the old URL — still the same relay.
            record_with_relay("agent-slash", "WSS://Relay-Old.Example/"),
            record_with_relay("agent-exact", "wss://relay-old.example"),
            record_with_relay("agent-other", "wss://relay-other.example"),
            record_with_relay("agent-blank", ""),
        ];

        let changed = rebind_agent_relay_urls(
            &mut records,
            "wss://relay-old.example",
            "wss://relay-new.example",
        );

        assert_eq!(changed, 2);
        assert_eq!(records[0].relay_url, "wss://relay-new.example");
        assert_eq!(records[1].relay_url, "wss://relay-new.example");
        assert_eq!(records[2].relay_url, "wss://relay-other.example");
        // Blank is the migration's job — rebinding it would pin a floating
        // record to a community it may never have belonged to.
        assert_eq!(records[3].relay_url, "");
    }

    #[test]
    fn rebind_rejects_blank_target_and_skips_already_bound() {
        let mut records = vec![record_with_relay("agent-a", "wss://relay-old.example")];
        assert_eq!(
            rebind_agent_relay_urls(&mut records, "wss://relay-old.example", "  "),
            0
        );
        assert_eq!(records[0].relay_url, "wss://relay-old.example");

        // Records already carrying the exact target value are not counted.
        let mut records = vec![record_with_relay("agent-a", "wss://relay.example")];
        assert_eq!(
            rebind_agent_relay_urls(&mut records, "wss://relay.example", "wss://relay.example"),
            0
        );
    }
}
