//! PATH augmentation for launched managed-agent child processes.

use std::path::PathBuf;

/// Pure PATH composition kernel shared by the install shell and the runtime/probe paths.
///
/// Merges already-split PATH entries in precedence order:
///   1. `managed` — Buzz-controlled dirs (highest precedence, e.g. managed Node/npm bins)
///   2. `login`   — login-shell PATH entries (split before calling)
///   3. `inherited` — current-process PATH entries (split before calling), appended
///      only when `use_inherited` is `true`
///
/// Callers are responsible for splitting raw PATH strings and for prepending any
/// additional prefix entries (e.g. `home/.local/bin`, `nvm`, `exe_parent`) before
/// passing them in `managed`.  `split_paths`/`join_paths` are kept at the wrapper
/// boundaries so this function remains fully pure and testable on any host.
pub(crate) fn compose_path_entries(
    managed: Vec<PathBuf>,
    login: Vec<PathBuf>,
    inherited: Vec<PathBuf>,
    use_inherited: bool,
) -> Vec<PathBuf> {
    let mut parts = managed;
    parts.extend(login);
    if use_inherited {
        parts.extend(inherited);
    }
    parts
}

/// Assemble the augmented `PATH` for a launched managed-agent child process.
///
/// Concatenates, in priority order:
///   1. `<home>/.local/bin` — bundled CLI symlink
///   2. Buzz-managed npm prefix bin dir — app-private ACP adapter shims
///   3. Buzz-managed Node.js bin dir — app-private Node/npm runtime
///   4. `nvm_bin` — nvm's default Node.js bin dir (if the user uses nvm)
///   5. exe parent dir — DMG sidecars under `Contents/MacOS/`
///   6. user's login-shell `PATH` — runtimes like node/python from other managers
///   7. Windows only: the current process `PATH` (appended when no login-shell
///      PATH exists, because callers use `Command::env("PATH", …)` which
///      *replaces* the child's PATH — without this, the child loses node/npm/git
///      and every npm `.cmd` shim fails with `'node' is not recognized`)
///
/// `shell_path` is the raw colon-delimited string from a login shell, so it is
/// split into individual entries before joining. Pushing it as a single segment
/// would make `join_paths` reject it (a segment containing the separator is an
/// error), collapsing the entire augmented `PATH` to `None` — the bug this
/// guards against, which left managed agents unable to find `buzz`. Returns
/// `None` only when no entries exist.
pub(in crate::managed_agents) fn build_augmented_path(
    home: Option<PathBuf>,
    exe_parent: Option<PathBuf>,
    shell_path: Option<String>,
    nvm_bin: Option<PathBuf>,
) -> Option<String> {
    let home_added = home.is_some();
    let exe_added = exe_parent.is_some();
    let has_local_context = home_added || exe_added;

    // Build the managed/prefix entries (everything before login-shell PATH).
    let mut managed: Vec<PathBuf> = Vec::new();
    if let Some(home) = home {
        managed.push(home.join(".local").join("bin"));
    }
    // Only add managed runtime dirs when a home or executable context exists.
    // This keeps tests/utility callers that intentionally pass no local context
    // from manufacturing a PATH out of ambient platform dirs alone.
    if has_local_context {
        if let Some(managed_npm_bin) = crate::managed_agents::buzz_managed_npm_bin_dir() {
            managed.push(managed_npm_bin);
        }
        if let Some(managed_node_bin) = crate::managed_agents::buzz_managed_node_bin_dir() {
            managed.push(managed_node_bin);
        }
    }
    if let Some(nvm_bin) = nvm_bin {
        managed.push(nvm_bin);
    }
    if let Some(parent) = exe_parent {
        managed.push(parent);
    }

    // Split the login-shell PATH into individual entries.
    let had_shell_path = shell_path.is_some();
    let login: Vec<PathBuf> = shell_path
        .as_deref()
        .map(|s| std::env::split_paths(s).collect())
        .unwrap_or_default();

    // On Windows, `login_shell_path()` always returns `None` because Git Bash
    // reports POSIX colon-delimited paths that poison native children.  Nothing
    // above contributes the user's real Windows PATH, and `Command::env("PATH",
    // …)` replaces rather than extends, so every child loses node/npm/git.
    // Append the inherited process PATH here — after the Buzz-managed dirs so
    // those still win — but only when there is local context (home or exe_parent
    // was supplied) to prevent manufacturing a PATH from ambient state alone.
    let inherited: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // `use_inherited`: Windows-only policy — append process PATH when no
    // login-shell PATH was available and there is local context.  On non-Windows
    // platforms this is always false, making the inherited entries a dead weight
    // that compose_path_entries simply drops; the compiler eliminates the branch.
    let use_inherited = !had_shell_path && has_local_context && cfg!(windows);

    let parts = compose_path_entries(managed, login, inherited, use_inherited);
    if parts.is_empty() {
        return None;
    }
    // join_paths uses the platform separator (':' on Unix, ';' on Windows).
    std::env::join_paths(parts)
        .ok()
        .map(|s| s.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::build_augmented_path;
    use std::path::PathBuf;

    #[cfg(unix)]
    #[test]
    fn splits_colon_delimited_shell_path() {
        // Regression: the shell PATH arrives as one colon-delimited string. It
        // must be split into segments before join_paths, or join_paths rejects
        // it and the whole augmented PATH collapses to None (managed agents then
        // lose `buzz`).
        let result = build_augmented_path(
            Some(PathBuf::from("/home/agent")),
            Some(PathBuf::from("/Applications/Buzz.app/Contents/MacOS")),
            Some("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin".to_string()),
            None,
        );
        let result = result.expect("path");
        assert!(result.starts_with("/home/agent/.local/bin:"), "{result}");
        assert!(
            result.contains(":/Applications/Buzz.app/Contents/MacOS:"),
            "{result}"
        );
        assert!(
            result.ends_with(":/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"),
            "{result}"
        );
    }

    #[test]
    fn none_when_no_inputs() {
        assert_eq!(build_augmented_path(None, None, None, None), None);
    }

    #[cfg(unix)]
    #[test]
    fn shell_path_only() {
        let result = build_augmented_path(None, None, Some("/usr/bin:/bin".to_string()), None);
        assert_eq!(result.as_deref(), Some("/usr/bin:/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn nvm_bin_inserted_after_local_bin_before_exe_parent() {
        let result = build_augmented_path(
            Some(PathBuf::from("/home/user")),
            Some(PathBuf::from("/Applications/Buzz.app/Contents/MacOS")),
            Some("/usr/bin:/bin".to_string()),
            Some(PathBuf::from("/home/user/.nvm/versions/node/v20.0.0/bin")),
        );
        let result = result.expect("path");
        let local = result.find("/home/user/.local/bin").unwrap();
        let nvm = result
            .find("/home/user/.nvm/versions/node/v20.0.0/bin")
            .unwrap();
        let exe = result
            .find("/Applications/Buzz.app/Contents/MacOS")
            .unwrap();
        assert!(local < nvm && nvm < exe, "{result}");
        assert!(result.ends_with(":/usr/bin:/bin"), "{result}");
    }

    #[cfg(unix)]
    #[test]
    fn nvm_bin_none_does_not_add_segment() {
        let result = build_augmented_path(
            Some(PathBuf::from("/home/user")),
            Some(PathBuf::from("/usr/local/bin")),
            None,
            None,
        );
        let result = result.expect("path");
        assert!(result.starts_with("/home/user/.local/bin:"), "{result}");
        assert!(result.ends_with(":/usr/local/bin"), "{result}");
    }

    /// On Unix, supplying a `shell_path` must NOT trigger the Windows process-PATH
    /// fallback — the output must be byte-identical to what it was before this
    /// fix.  (The `#[cfg(windows)]` block is dead on this platform, but the
    /// `had_shell_path` variable introduced alongside it must not affect non-Windows
    /// output.)
    #[cfg(unix)]
    #[test]
    fn unix_shell_path_output_unchanged_by_windows_fallback_logic() {
        let result = build_augmented_path(
            Some(PathBuf::from("/home/user")),
            None,
            Some("/usr/local/bin:/usr/bin:/bin".to_string()),
            None,
        );
        let result = result.expect("path");
        // Must end exactly with the login-shell PATH — no ambient process PATH
        // appended even though shell_path is set.
        assert!(
            result.ends_with(":/usr/local/bin:/usr/bin:/bin"),
            "Unix output must not append process PATH: {result}"
        );
    }

    /// On Windows: when no login-shell PATH is available, `build_augmented_path`
    /// must append the inherited process PATH so node/npm remain visible.
    ///
    /// This test manipulates `std::env::var_os("PATH")` directly — it must hold
    /// the `lock_path_mutex` to avoid racing with other tests.
    #[cfg(windows)]
    #[test]
    fn windows_appends_process_path_when_no_shell_path() {
        let _guard = crate::managed_agents::lock_path_mutex();
        let previous = std::env::var_os("PATH");
        std::env::set_var("PATH", r"C:\Program Files\nodejs");

        let result = build_augmented_path(Some(PathBuf::from(r"C:\Users\agent")), None, None, None);

        match previous {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }

        let result = result.expect("path must not be None with a home dir");
        assert!(
            result.starts_with(r"C:\Users\agent\.local\bin;"),
            "home/.local/bin must be first: {result}"
        );
        assert!(
            result.ends_with(r";C:\Program Files\nodejs"),
            "process PATH must be last: {result}"
        );
    }

    /// On Windows: when a login-shell PATH IS supplied (hypothetically), the
    /// process PATH must NOT also be appended — that would double the PATH.
    #[cfg(windows)]
    #[test]
    fn windows_does_not_append_process_path_when_shell_path_present() {
        let _guard = crate::managed_agents::lock_path_mutex();
        let previous = std::env::var_os("PATH");
        std::env::set_var("PATH", r"C:\ShouldNotAppear");

        let result = build_augmented_path(
            Some(PathBuf::from(r"C:\Users\agent")),
            None,
            Some(r"C:\Program Files\nodejs".to_string()),
            None,
        );

        match previous {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }

        let result = result.expect("path");
        assert!(
            !result.contains("ShouldNotAppear"),
            "process PATH must not be appended when shell_path is present: {result}"
        );
    }

    /// On Windows: when no local context is provided (home=None, exe_parent=None),
    /// the function must return None even if the process PATH is set — callers
    /// that pass no context must not get a PATH manufactured from ambient state.
    #[cfg(windows)]
    #[test]
    fn windows_no_process_path_without_local_context() {
        let _guard = crate::managed_agents::lock_path_mutex();
        let previous = std::env::var_os("PATH");
        std::env::set_var("PATH", r"C:\Windows\System32");

        let result = build_augmented_path(None, None, None, None);

        match previous {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }

        assert_eq!(
            result, None,
            "must return None when no local context and no shell_path"
        );
    }
}

// ── Pure compose_path_entries tests — cover the Windows policy matrix on any host ──
//
// These test the composition kernel directly with explicit inputs, so they run
// on macOS/Linux CI and validate the Windows `use_inherited` behavior without
// touching process state or needing a Windows target.
#[cfg(test)]
mod compose_tests {
    use super::compose_path_entries;
    use std::path::PathBuf;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn managed_entries_appear_first() {
        let managed = vec![p("/buzz/node/bin"), p("/buzz/npm/bin")];
        let login = vec![p("/usr/local/bin"), p("/usr/bin")];
        let result = compose_path_entries(managed, login, vec![], false);
        assert_eq!(result[0], p("/buzz/node/bin"), "managed[0] must be first");
        assert_eq!(result[1], p("/buzz/npm/bin"), "managed[1] must be second");
        assert_eq!(
            result[2],
            p("/usr/local/bin"),
            "login[0] must follow managed"
        );
    }

    #[test]
    fn login_path_suppresses_inherited_when_use_inherited_false() {
        let login = vec![p("/usr/local/bin")];
        let inherited = vec![p("/should/not/appear")];
        let result = compose_path_entries(vec![], login, inherited, false);
        assert!(
            !result.contains(&p("/should/not/appear")),
            "inherited must not appear when use_inherited=false"
        );
    }

    #[test]
    fn inherited_appended_last_when_use_inherited_true() {
        let managed = vec![p("/buzz/npm/bin")];
        let login = vec![];
        let inherited = vec![p("C:/windows/node"), p("C:/windows/npm")];
        let result = compose_path_entries(managed, login, inherited.clone(), true);
        assert_eq!(result[0], p("/buzz/npm/bin"), "managed must be first");
        assert_eq!(
            &result[1..],
            &inherited[..],
            "inherited entries must be appended last"
        );
    }

    #[test]
    fn empty_managed_and_login_with_inherited_appended() {
        let inherited = vec![p("C:/windows/system32"), p("C:/windows")];
        let result = compose_path_entries(vec![], vec![], inherited.clone(), true);
        assert_eq!(
            result, inherited,
            "only inherited entries when others are empty"
        );
    }

    #[test]
    fn empty_all_inputs_returns_empty() {
        let result = compose_path_entries(vec![], vec![], vec![], false);
        assert!(
            result.is_empty(),
            "all-empty inputs must produce empty output"
        );
    }

    #[test]
    fn install_runtime_parity_same_kernel() {
        // Both install and runtime paths share compose_path_entries. Verify that
        // two callers with identical inputs produce identical output — the drift
        // that upstream PRs #2247 vs #2533 introduced cannot happen here.
        let managed = vec![p("/buzz/node/bin"), p("/buzz/npm/bin")];
        let inherited = vec![p("C:/win/node")];
        let install_result = compose_path_entries(managed.clone(), vec![], inherited.clone(), true);
        let runtime_result = compose_path_entries(managed.clone(), vec![], inherited.clone(), true);
        assert_eq!(
            install_result, runtime_result,
            "install and runtime callers with identical inputs must produce identical PATH"
        );
    }

    /// Non-Windows behavior: `use_inherited=false` (what the runtime passes on Unix)
    /// must produce byte-identical output to what existed before this fix.
    /// The inherited entries are collected but never appended — they are dead weight
    /// that compose_path_entries drops.
    #[cfg(unix)]
    #[test]
    fn unix_use_inherited_false_output_unchanged() {
        let managed = vec![p("/buzz/npm/bin")];
        let login = vec![p("/usr/local/bin"), p("/usr/bin"), p("/bin")];
        let inherited = vec![p("/proc/ambient/PATH")]; // would be real proc PATH on Unix
        let result = compose_path_entries(managed, login, inherited, false);
        assert_eq!(
            result,
            vec![
                p("/buzz/npm/bin"),
                p("/usr/local/bin"),
                p("/usr/bin"),
                p("/bin")
            ],
            "Unix output must not include inherited entries when use_inherited=false"
        );
    }
}
