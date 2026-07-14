#![cfg_attr(not(windows), forbid(unsafe_code))]
//! Compiled launcher shim for the bundled ACP bridge tools.
//!
//! Unix targets stage the bundled bridges (`claude-agent-acp`, `codex-acp`)
//! as bash wrapper shims (`desktop/scripts/lib/acp-node-wrapper.sh`), which
//! Windows cannot execute — and the desktop's command resolution only looks
//! for `<binary>.exe` there anyway. Windows targets stage this launcher as
//! `<binary>.exe` next to a `<binary>.shim.json` manifest instead. The
//! launcher reproduces the wrapper contract exactly: verify a Node.js
//! runtime satisfying the locked engine range is on PATH, then run node on
//! the vendored entrypoint, forwarding arguments, stdio, and the exit code.
//!
//! On Windows the node child is additionally assigned to a Job Object with
//! `KILL_ON_JOB_CLOSE`, so terminating the launcher (as the buzz-acp
//! harness's `kill_on_drop` does when a session ends) takes the node process
//! tree with it instead of orphaning it. On Unix the launcher execs node,
//! matching the bash shim; it exists there only so the crate builds and
//! tests on every workspace platform.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// On-disk shape of the `<binary>.shim.json` manifest written by
/// `desktop/scripts/lib/acp-node-wrapper.sh` next to the staged launcher.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShimManifest {
    /// JS entrypoint to run; a relative path resolves against the launcher's
    /// own directory, mirroring the bash wrapper.
    entrypoint: String,
    /// The lock's Node engine range (e.g. ">=22"), used verbatim in error
    /// messages so they match the bash wrapper's.
    node_engine: String,
    /// Minimum Node.js major version enforced before spawning.
    required_node_major: u32,
}

/// The manifest sits next to the launcher under the same staged binary name:
/// `claude-agent-acp.exe` reads `claude-agent-acp.shim.json`.
fn shim_manifest_path(exe: &Path) -> PathBuf {
    exe.with_extension("shim.json")
}

fn resolve_entrypoint(exe_dir: &Path, entrypoint: &str) -> PathBuf {
    let entrypoint = Path::new(entrypoint);
    if entrypoint.is_absolute() {
        entrypoint.to_path_buf()
    } else {
        exe_dir.join(entrypoint)
    }
}

fn parse_node_major(version: &str) -> Option<u32> {
    version.trim().split('.').next()?.parse().ok()
}

/// `Ok(None)` means node ran but produced no parsable version; `Err` is a
/// spawn failure (`NotFound` when node is not on PATH at all).
fn node_major_version() -> std::io::Result<Option<u32>> {
    let output = Command::new("node")
        .args(["-p", "process.versions.node"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(parse_node_major(&String::from_utf8_lossy(&output.stdout)))
}

fn fail(message: std::fmt::Arguments<'_>, code: i32) -> ! {
    eprintln!("{message}");
    std::process::exit(code);
}

/// Run node on the entrypoint, forwarding stdio and the exit code. Diverges:
/// on Unix this execs (the launcher *becomes* node, like the bash shim); on
/// Windows it waits on a Job-Object-managed child.
fn run_node(name: &str, entrypoint: &Path, args: std::env::ArgsOs) -> ! {
    let mut command = Command::new("node");
    command.arg(entrypoint).args(args.skip(1));

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        fail(format_args!("{name}: failed to exec node: {error}"), 1);
    }

    #[cfg(windows)]
    {
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => fail(format_args!("{name}: failed to spawn node: {error}"), 1),
        };
        // Held for the launcher's lifetime: the OS closes the handle at
        // process exit, which is exactly when KILL_ON_JOB_CLOSE should fire.
        // After a normal wait() the child is already gone and the close is a
        // no-op; on TerminateProcess it reaps the whole node tree.
        let _job = job::KillOnCloseJob::assign(&child);
        match child.wait() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(error) => fail(format_args!("{name}: failed to wait on node: {error}"), 1),
        }
    }
}

fn main() {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => fail(
            format_args!("acp-node-launcher: cannot determine own path: {error}"),
            1,
        ),
    };
    let name = exe
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "acp-node-launcher".to_string());

    let manifest_path = shim_manifest_path(&exe);
    let manifest_raw = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(error) => fail(
            format_args!(
                "{name}: cannot read shim manifest {}: {error}",
                manifest_path.display()
            ),
            1,
        ),
    };
    let manifest: ShimManifest = match serde_json::from_str(&manifest_raw) {
        Ok(manifest) => manifest,
        Err(error) => fail(
            format_args!(
                "{name}: invalid shim manifest {}: {error}",
                manifest_path.display()
            ),
            1,
        ),
    };

    let exe_dir = exe.parent().unwrap_or_else(|| Path::new("."));
    let entrypoint = resolve_entrypoint(exe_dir, &manifest.entrypoint);
    if !entrypoint.is_file() {
        fail(
            format_args!(
                "{name}: bundled entrypoint missing: {}",
                entrypoint.display()
            ),
            1,
        );
    }

    // Same message and exit codes as the bash wrapper: 127 when node is not
    // on PATH at all, 1 when it is too old (or unidentifiable).
    match node_major_version() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fail(
            format_args!("{name} requires Node.js {} on PATH.", manifest.node_engine),
            127,
        ),
        Ok(Some(major)) if major >= manifest.required_node_major => {}
        Ok(_) | Err(_) => fail(
            format_args!("{name} requires Node.js {} on PATH.", manifest.node_engine),
            1,
        ),
    }

    run_node(&name, &entrypoint, std::env::args_os());
}

#[cfg(windows)]
mod job {
    //! Job Object holding the node child, mirroring buzz-dev-mcp's
    //! `KillGroup` (crates/buzz-dev-mcp/src/shell.rs): `KILL_ON_JOB_CLOSE`
    //! kills every process still in the job when the last handle closes.

    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct KillOnCloseJob {
        _job: HANDLE,
    }

    impl KillOnCloseJob {
        /// Best-effort: a creation or assignment failure leaves the child
        /// unmanaged (the outer harness Job Object still reaps it at app
        /// shutdown) rather than failing the launch.
        pub fn assign(child: &std::process::Child) -> Self {
            // SAFETY: each call is a documented Win32 FFI call with arguments
            // that satisfy its contract — a null SECURITY_ATTRIBUTES/name for
            // an anonymous job, a zeroed #[repr(C)] info struct sized by
            // size_of, and the live process handle owned by `child`. A null
            // job HANDLE on failure makes the later calls harmless no-ops.
            let job = unsafe {
                let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if !job.is_null() {
                    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        std::ptr::addr_of!(info).cast(),
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    );
                    AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
                }
                job
            };
            Self { _job: job }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_node_major, resolve_entrypoint, shim_manifest_path, ShimManifest};
    use std::path::Path;

    #[test]
    fn manifest_parses_the_staging_script_shape() {
        let manifest: ShimManifest = serde_json::from_str(
            r#"{
              "entrypoint": "../node/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
              "nodeEngine": ">=22",
              "requiredNodeMajor": 22
            }"#,
        )
        .expect("parse manifest");
        assert!(manifest.entrypoint.ends_with("dist/index.js"));
        assert_eq!(manifest.node_engine, ">=22");
        assert_eq!(manifest.required_node_major, 22);
    }

    #[test]
    fn manifest_rejects_missing_fields() {
        assert!(serde_json::from_str::<ShimManifest>(r#"{"entrypoint": "index.js"}"#).is_err());
    }

    #[test]
    fn shim_manifest_sits_next_to_the_launcher_under_the_staged_name() {
        assert_eq!(
            shim_manifest_path(Path::new("/acp/bin/claude-agent-acp.exe")),
            Path::new("/acp/bin/claude-agent-acp.shim.json"),
        );
        // Unix-style staging without an extension gains the suffix whole.
        assert_eq!(
            shim_manifest_path(Path::new("/acp/bin/codex-acp")),
            Path::new("/acp/bin/codex-acp.shim.json"),
        );
    }

    #[test]
    fn relative_entrypoints_resolve_against_the_launcher_dir() {
        assert_eq!(
            resolve_entrypoint(Path::new("/acp/bin"), "../node/x/dist/index.js"),
            Path::new("/acp/bin/../node/x/dist/index.js"),
        );
        assert_eq!(
            resolve_entrypoint(Path::new("/acp/bin"), "/abs/dist/index.js"),
            Path::new("/abs/dist/index.js"),
        );
    }

    #[test]
    fn node_major_parses_plain_and_noisy_versions() {
        assert_eq!(parse_node_major("22.14.0\n"), Some(22));
        assert_eq!(parse_node_major("24"), Some(24));
        assert_eq!(parse_node_major(""), None);
        assert_eq!(parse_node_major("not-a-version"), None);
    }
}
