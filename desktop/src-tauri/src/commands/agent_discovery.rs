use std::io::Read;
use std::sync::atomic::Ordering::{Acquire, Relaxed};
use tauri::{AppHandle, State};

use crate::{
    app_state::AppState,
    managed_agents::{
        command_availability, AcpProviderCatalogEntry, DiscoverManagedAgentPrereqsRequest,
        InstallRuntimeResult, InstallStepResult, ManagedAgentPrereqsInfo, RelayAgentInfo,
        DEFAULT_ACP_COMMAND, DEFAULT_MCP_COMMAND,
    },
    nostr_convert,
    relay::query_relay,
};

static INSTALL_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub fn discover_acp_providers() -> Vec<AcpProviderCatalogEntry> {
    crate::managed_agents::discover_acp_providers()
}

#[tauri::command]
pub async fn install_acp_runtime(provider_id: String) -> Result<InstallRuntimeResult, String> {
    tokio::task::spawn_blocking(move || install_acp_runtime_blocking(&provider_id))
        .await
        .map_err(|e| format!("install task panicked: {e}"))?
}

fn install_acp_runtime_blocking(provider_id: &str) -> Result<InstallRuntimeResult, String> {
    // Prevent concurrent installs.
    INSTALL_IN_PROGRESS
        .compare_exchange(false, true, Acquire, Relaxed)
        .map_err(|_| "an install is already in progress".to_string())?;

    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            INSTALL_IN_PROGRESS.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    let _guard = Guard;

    let provider = crate::managed_agents::known_acp_provider_exact(provider_id)
        .ok_or_else(|| format!("unknown provider: {provider_id}"))?;

    let mut steps = Vec::new();

    // Phase 1: Install CLI if missing and commands are available.
    if let Some(cli) = provider.underlying_cli {
        if crate::managed_agents::resolve_command(cli, None).is_none() {
            for cmd in provider.cli_install_commands {
                let result = run_install_command("cli", cmd);
                let success = result.success;
                steps.push(result);
                if !success {
                    return Ok(InstallRuntimeResult {
                        success: false,
                        steps,
                    });
                }
            }
        }
    }

    // Phase 2: Install adapter if missing and commands are available.
    let adapter_found = provider
        .commands
        .iter()
        .any(|cmd| crate::managed_agents::resolve_command(cmd, None).is_some());
    if !adapter_found {
        for cmd in provider.adapter_install_commands {
            let result = run_install_command("adapter", cmd);
            let success = result.success;
            steps.push(result);
            if !success {
                return Ok(InstallRuntimeResult {
                    success: false,
                    steps,
                });
            }
        }
    }

    // Clear the resolve cache so the next discovery picks up new binaries.
    crate::managed_agents::clear_resolve_cache();

    Ok(InstallRuntimeResult {
        success: true,
        steps,
    })
}

fn run_install_command(step: &str, command: &str) -> InstallStepResult {
    let shell_path = crate::managed_agents::login_shell_path();
    let shell = if std::path::Path::new("/bin/zsh").exists() {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };

    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-l", "-c", command]);

    if let Some(ref path) = shell_path {
        cmd.env("PATH", path);
    }

    let mut child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return InstallStepResult {
                step: step.to_string(),
                command: command.to_string(),
                success: false,
                stdout: String::new(),
                stderr: format!("failed to spawn shell: {e}"),
                exit_code: None,
            };
        }
    };

    // Drain stdout/stderr on background threads to prevent pipe buffer deadlock.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_string(&mut buf);
        }
        buf
    });

    let (tx, rx) = std::sync::mpsc::channel();
    let wait_thread = std::thread::spawn(move || {
        let status = child.wait();
        let _ = tx.send(status);
        // Return child so the caller can kill it on timeout.
    });

    // 5-minute timeout for install commands.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            // Timeout: the wait_thread still holds the child; signal via the
            // channel being dropped and use a sentinel. We cannot kill here
            // since `child` was moved. Instead, we drop the receiver and join
            // the threads, letting them finish naturally, then report timeout.
            drop(rx);
            let _ = wait_thread.join();
            let stdout = stdout_thread.join().unwrap_or_default();
            let stderr = stderr_thread.join().unwrap_or_default();
            let _ = stdout; // discard; timed out
            let _ = stderr;
            return InstallStepResult {
                step: step.to_string(),
                command: command.to_string(),
                success: false,
                stdout: String::new(),
                stderr: "install command timed out after 5 minutes".to_string(),
                exit_code: None,
            };
        }

        match rx.recv_timeout(std::time::Duration::from_millis(200).min(remaining)) {
            Ok(Ok(status)) => {
                let _ = wait_thread.join();
                let stdout = stdout_thread.join().unwrap_or_default();
                let stderr_raw = stderr_thread.join().unwrap_or_default();
                return InstallStepResult {
                    step: step.to_string(),
                    command: command.to_string(),
                    success: status.success(),
                    stdout: truncate_output(stdout),
                    stderr: truncate_output(stderr_raw),
                    exit_code: status.code(),
                };
            }
            Ok(Err(e)) => {
                let _ = wait_thread.join();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return InstallStepResult {
                    step: step.to_string(),
                    command: command.to_string(),
                    success: false,
                    stdout: String::new(),
                    stderr: format!("failed to check process status: {e}"),
                    exit_code: None,
                };
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Still running; loop and check deadline again.
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                // wait_thread dropped sender without sending — shouldn't happen.
                let _ = wait_thread.join();
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return InstallStepResult {
                    step: step.to_string(),
                    command: command.to_string(),
                    success: false,
                    stdout: String::new(),
                    stderr: "internal error: wait thread disconnected".to_string(),
                    exit_code: None,
                };
            }
        }
    }
}

/// Cap output to head + tail to avoid flooding the UI with large error dumps,
/// while preserving the most useful parts of the output.
fn truncate_output(s: String) -> String {
    const HEAD: usize = 512;
    const TAIL: usize = 1024;
    const LIMIT: usize = HEAD + TAIL;
    if s.len() <= LIMIT {
        return s;
    }
    let head_end = s.floor_char_boundary(HEAD);
    let tail_start = s.floor_char_boundary(s.len().saturating_sub(TAIL));
    let omitted = tail_start - head_end;
    format!(
        "{}\n... ({omitted} bytes omitted) ...\n{}",
        &s[..head_end],
        &s[tail_start..]
    )
}

#[tauri::command]
pub fn discover_managed_agent_prereqs(
    input: DiscoverManagedAgentPrereqsRequest,
    app: AppHandle,
) -> ManagedAgentPrereqsInfo {
    let acp_command = input
        .acp_command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_ACP_COMMAND);
    let mcp_command = input
        .mcp_command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MCP_COMMAND);

    ManagedAgentPrereqsInfo {
        acp: command_availability(acp_command, Some(&app)),
        mcp: command_availability(mcp_command, Some(&app)),
    }
}

#[tauri::command]
pub async fn list_relay_agents(state: State<'_, AppState>) -> Result<Vec<RelayAgentInfo>, String> {
    // Query kind:10100 agent profile events from the relay.
    let events = query_relay(
        &state,
        &[serde_json::json!({
            "kinds": [10100],
        })],
    )
    .await?;

    // The convert helper returns `{"agents": [...]}`. Extract and re-deserialize
    // into the strongly-typed `Vec<RelayAgentInfo>` the frontend expects.
    let value = nostr_convert::agents_from_events(&events);
    let agents = value
        .get("agents")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    serde_json::from_value(agents).map_err(|e| format!("agent parse failed: {e}"))
}
