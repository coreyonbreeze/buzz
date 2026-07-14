# Shared Node wrapper generation for ACP bridge tools staged from npm.
# Sourced by ensure-acp-tools.sh and prepare-acp-tools-resource.sh so the
# wrapper staged into the dev cache and the wrapper bundled into app
# resources cannot drift (a drift would make dev and bundled installs fail
# differently on the same missing/old Node runtime).
#
# Unix targets stage a bash wrapper shim (write_node_wrapper); Windows
# targets stage the compiled buzz-acp-node-launcher as `<binary>.exe` next
# to a `<binary>.shim.json` manifest (write_windows_node_launcher) — Windows
# cannot execute bash shims, and the desktop's command resolution only looks
# for `<binary>.exe`. Both shims enforce the same lock-derived Node engine
# requirement.
#
# acp_target_is_windows <target-triple>
#   Whether the Rust target triple names a Windows target.
acp_target_is_windows() {
  [[ "$1" == *-windows-* ]]
}

# acp_staged_binary_name <binary> <target-triple>
#   The filename a tool's shim is staged under for <target>: the lock's bare
#   binary name on Unix, `<binary>.exe` on Windows.
acp_staged_binary_name() {
  if acp_target_is_windows "$2"; then
    printf '%s.exe\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}
#
# acp_required_node_major <node-engine>
#   Prints the minimum Node.js major version implied by a ">=N..." engine
#   range, defaulting to 22 when the range is not in that form. Shared by
#   the wrapper shim below and the node-runtime.json manifest consumed by
#   the app's Node.js runtime doctor check, so the version the wrapper
#   enforces at spawn time and the version the doctor reports at setup
#   time cannot disagree.
acp_required_node_major() {
  local node_engine="$1"
  local major
  major="$(printf '%s\n' "$node_engine" | sed -n 's/^>=\([0-9][0-9]*\).*$/\1/p')"
  if [[ -z "$major" ]]; then
    major=22
  fi
  printf '%s\n' "$major"
}

# write_node_wrapper <wrapper> <entrypoint> [node-engine]
#   Writes an executable bash shim at <wrapper> that verifies a Node.js
#   runtime satisfying <node-engine> (default ">=22") is on PATH, then
#   execs node on <entrypoint>. An absolute <entrypoint> is embedded
#   verbatim; a relative one is resolved against the wrapper's directory
#   at run time.

write_node_wrapper() {
  local wrapper="$1"
  local entrypoint="$2"
  local node_engine="${3:->=22}"
  local required_node_major
  required_node_major="$(acp_required_node_major "$node_engine")"

  mkdir -p "$(dirname "$wrapper")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'if ! command -v node >/dev/null 2>&1; then\n'
    printf '  echo "%s requires Node.js %s on PATH." >&2\n' "$(basename "$wrapper")" "$node_engine"
    printf '  exit 127\n'
    printf 'fi\n'
    printf 'required_node_major=%q\n' "$required_node_major"
    printf 'node_major="$(node -p '\''process.versions.node.split(".")[0]'\'' 2>/dev/null || true)"\n'
    printf 'if [[ -z "$node_major" || "$node_major" -lt "$required_node_major" ]]; then\n'
    printf '  echo "%s requires Node.js %s on PATH." >&2\n' "$(basename "$wrapper")" "$node_engine"
    printf '  exit 1\n'
    printf 'fi\n'
    if [[ "$entrypoint" == /* ]]; then
      printf 'entrypoint=%q\n' "$entrypoint"
    else
      printf 'wrapper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n'
      printf 'entrypoint="$wrapper_dir"/%q\n' "$entrypoint"
    fi
    printf 'exec node "$entrypoint" "$@"\n'
  } > "$wrapper"
  chmod +x "$wrapper"
}

# acp_node_launcher_exe <target-triple>
#   Prints the path to the compiled Windows launcher shim for <target>,
#   building it with cargo when needed (a no-op rebuild when up to date).
#   ACP_NODE_LAUNCHER_EXE overrides the build entirely — for callers that
#   already built the crate, and for cross-target staging tests on hosts
#   without the Windows toolchain.
acp_node_launcher_exe() {
  local target="$1"
  if [[ -n "${ACP_NODE_LAUNCHER_EXE:-}" ]]; then
    printf '%s\n' "$ACP_NODE_LAUNCHER_EXE"
    return
  fi
  # The lib lives at desktop/scripts/lib; the launcher crate is in the repo
  # root workspace so the Windows release job's warm target dir is reused.
  local repo_root manifest target_dir
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  manifest="$repo_root/Cargo.toml"
  echo "Building ACP node launcher shim for $target..." >&2
  cargo build --release --manifest-path "$manifest" -p buzz-acp-node-launcher --target "$target" >&2
  # Resolve the target dir instead of assuming ./target — CARGO_TARGET_DIR
  # and .cargo/config redirects are common.
  target_dir="$(cargo metadata --format-version 1 --no-deps --manifest-path "$manifest" \
    | node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).target_directory)')"
  printf '%s/%s/release/buzz-acp-node-launcher.exe\n' "$target_dir" "$target"
}

# write_windows_node_launcher <dest-exe> <launcher-exe> <entrypoint> [node-engine]
#   Stages the compiled launcher shim at <dest-exe> and writes the sibling
#   `<name>.shim.json` manifest the launcher reads at spawn time. Mirrors
#   write_node_wrapper's contract: a relative <entrypoint> resolves against
#   the launcher's directory at run time. Idempotent — the copy is skipped
#   when the staged launcher is already identical, so a re-stage never
#   rewrites an .exe a running agent may hold open.
write_windows_node_launcher() {
  local dest_exe="$1"
  local launcher_exe="$2"
  local entrypoint="$3"
  local node_engine="${4:->=22}"
  local required_node_major
  required_node_major="$(acp_required_node_major "$node_engine")"

  if [[ ! -f "$launcher_exe" ]]; then
    echo "ACP node launcher shim not found: $launcher_exe" >&2
    return 1
  fi
  mkdir -p "$(dirname "$dest_exe")"
  if ! cmp -s "$launcher_exe" "$dest_exe"; then
    cp -f "$launcher_exe" "$dest_exe"
  fi
  chmod +x "$dest_exe"
  ACP_SHIM_ENTRYPOINT="$entrypoint" \
    ACP_SHIM_NODE_ENGINE="$node_engine" \
    ACP_SHIM_REQUIRED_NODE_MAJOR="$required_node_major" \
    node -e '
const fs = require("node:fs");
fs.writeFileSync(process.argv[1], `${JSON.stringify({
  entrypoint: process.env.ACP_SHIM_ENTRYPOINT,
  nodeEngine: process.env.ACP_SHIM_NODE_ENGINE,
  requiredNodeMajor: Number(process.env.ACP_SHIM_REQUIRED_NODE_MAJOR),
}, null, 2)}\n`);
' "${dest_exe%.exe}.shim.json"
}
