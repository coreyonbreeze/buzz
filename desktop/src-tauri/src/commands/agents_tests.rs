use super::*;

#[test]
fn normalize_relay_mesh_rejects_empty_model_ref() {
    let config = RelayMeshConfig {
        model_ref: "  \t ".to_string(),
    };

    assert_eq!(
        normalize_relay_mesh(Some(&config), &BackendKind::Local).unwrap_err(),
        "relay mesh modelRef is required"
    );
}

#[test]
fn normalize_relay_mesh_rejects_non_local_backend() {
    let config = RelayMeshConfig {
        model_ref: "Qwen3".to_string(),
    };
    let backend = BackendKind::Provider {
        id: "blox".to_string(),
        config: serde_json::json!({}),
    };

    assert_eq!(
        normalize_relay_mesh(Some(&config), &backend).unwrap_err(),
        "relay mesh agents must use the local backend"
    );
}

#[test]
fn normalize_relay_mesh_trims_and_preserves_valid_config() {
    let config = RelayMeshConfig {
        model_ref: "  Qwen3  ".to_string(),
    };

    assert_eq!(
        normalize_relay_mesh(Some(&config), &BackendKind::Local).unwrap(),
        Some(RelayMeshConfig {
            model_ref: "Qwen3".to_string(),
        })
    );
}

#[test]
fn created_avatar_prefers_explicit_input() {
    let resolved = resolve_created_avatar_url(
        Some(" https://x/input.png "),
        Some("https://x/persona.png".to_string()),
        "goose",
    );

    assert_eq!(resolved.as_deref(), Some("https://x/input.png"));
}

#[test]
fn created_avatar_uses_persona_before_command_fallback() {
    let resolved =
        resolve_created_avatar_url(None, Some(" https://x/persona.png ".to_string()), "goose");

    assert_eq!(resolved.as_deref(), Some("https://x/persona.png"));
}

#[test]
fn created_avatar_uses_command_fallback_without_input_or_persona() {
    use crate::managed_agents::managed_agent_avatar_url;

    let resolved = resolve_created_avatar_url(None, None, "goose");

    assert_eq!(resolved, managed_agent_avatar_url("goose"));
}
