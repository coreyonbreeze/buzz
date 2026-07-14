//! End-to-end tests for the launcher shim: copy the built binary under a
//! bridge name next to a `<name>.shim.json` manifest — exactly how the
//! staging scripts lay it out — and run it against the real node on PATH.
//! Tests that need node skip (loudly) when it is absent, so the suite still
//! passes on stripped-down environments.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Stage the launcher under `name` in `dir`, as the staging scripts do.
fn stage_launcher(dir: &Path, name: &str) -> PathBuf {
    let staged = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    fs::copy(env!("CARGO_BIN_EXE_buzz-acp-node-launcher"), &staged).expect("stage launcher");
    staged
}

fn write_shim_manifest(dir: &Path, name: &str, entrypoint: &str, required_node_major: u32) {
    fs::write(
        dir.join(format!("{name}.shim.json")),
        format!(
            r#"{{"entrypoint":{},"nodeEngine":">={required_node_major}","requiredNodeMajor":{required_node_major}}}"#,
            serde_json::to_string(entrypoint).expect("encode entrypoint"),
        ),
    )
    .expect("write shim manifest");
}

#[test]
fn runs_entrypoint_forwarding_args_stdio_and_exit_code() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let temp = tempfile::tempdir().expect("temp dir");
    fs::write(
        temp.path().join("entry.js"),
        "console.log(['ok', ...process.argv.slice(2)].join(' '));\nprocess.exit(7);\n",
    )
    .expect("write entrypoint");
    // Relative entrypoint: must resolve against the launcher's directory.
    write_shim_manifest(temp.path(), "claude-agent-acp", "entry.js", 0);
    let staged = stage_launcher(temp.path(), "claude-agent-acp");

    let output = Command::new(&staged)
        .args(["--flag", "value"])
        .output()
        .expect("run staged launcher");

    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "ok --flag value"
    );
    assert_eq!(output.status.code(), Some(7));
}

#[test]
fn missing_manifest_fails_loudly() {
    let temp = tempfile::tempdir().expect("temp dir");
    let staged = stage_launcher(temp.path(), "codex-acp");

    let output = Command::new(&staged).output().expect("run staged launcher");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("shim manifest"),
        "stderr should name the missing manifest: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn missing_entrypoint_fails_loudly() {
    let temp = tempfile::tempdir().expect("temp dir");
    write_shim_manifest(temp.path(), "codex-acp", "no-such/dist/index.js", 0);
    let staged = stage_launcher(temp.path(), "codex-acp");

    let output = Command::new(&staged).output().expect("run staged launcher");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("entrypoint missing"),
        "stderr should name the missing entrypoint: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn node_major_below_requirement_is_rejected() {
    if !node_available() {
        eprintln!("skipping: node not on PATH");
        return;
    }
    let temp = tempfile::tempdir().expect("temp dir");
    fs::write(temp.path().join("entry.js"), "process.exit(0);\n").expect("write entrypoint");
    write_shim_manifest(temp.path(), "claude-agent-acp", "entry.js", 999);
    let staged = stage_launcher(temp.path(), "claude-agent-acp");

    let output = Command::new(&staged).output().expect("run staged launcher");

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("requires Node.js >=999 on PATH."),
        "stderr should carry the wrapper-shim message: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
