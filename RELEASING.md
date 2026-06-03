# Releasing Sprout Desktop

## Quick Start

```sh
# Regular release (next patch version)
just release

# Patch release
just release patch

# Minor release
just release 0.4.0

# Any explicit version
just release 1.0.0
```

This creates a `version-bump/<version>` PR that bumps all version manifests, regenerates lockfiles, and appends a changelog entry. Merge the PR to trigger the build automatically.

---

## How It Works

1. **`just release`** runs locally on `main` — computes the next version, creates a `version-bump/<version>` branch, bumps versions in all manifests, regenerates lockfiles, generates a changelog entry, commits, pushes, and opens a PR.

2. **The release PR stays in sync** — if other PRs merge to `main` while the release PR is open, the `sync-release-changelog` workflow automatically updates the changelog on the release PR branch so the final release notes reflect everything that will be in the binary. No manual action needed.

3. **Merge the PR** — the `auto-tag-on-release-pr-merge` workflow detects the `version-bump/*` branch merge, pushes a `v<version>` tag, and triggers both the OSS release build and the internal Buildkite pipeline automatically.

4. **Builds run in parallel** — `release.yml` builds, signs, notarizes, and publishes the OSS desktop app. The `sprout-releases` Buildkite pipeline produces Block-signed macOS and iOS builds with the `-block` version suffix.

---

## Release Types

| Command | Version | Example |
|---------|---------|---------|
| `just release` | Next patch | `0.3.0` → `0.3.1` |
| `just release patch` | Next patch | `0.3.0` → `0.3.1` |
| `just release 0.4.0` | Explicit minor | `0.3.1` → `0.4.0` |
| `just release 1.0.0` | Explicit | `1.0.0` |

---

## Version Files

`just bump-version <version>` updates these files:

| File | Field |
|------|-------|
| `desktop/package.json` | `"version"` |
| `desktop/src-tauri/tauri.conf.json` | `"version"` |
| `desktop/src-tauri/Cargo.toml` | `version` (under `[package]`) |
| `mobile/pubspec.yaml` | `version:` (preserves build number) |

It also regenerates `pnpm-lock.yaml`, `desktop/src-tauri/Cargo.lock`, and `mobile/pubspec.lock`.

---

## Manual Fallback

If the automated flow isn't suitable (e.g., building from a non-main ref):

1. Go to **Actions > Release** in the GitHub UI
2. Click **Run workflow**
3. Provide the semver version (no `v` prefix) and the ref to build from

---

## Internal Releases

Internal builds are triggered automatically when the release PR merges. The `auto-tag-on-release-pr-merge` workflow calls the Buildkite REST API to start the [sprout-releases pipeline](https://buildkite.com/runway/sprout-releases) with the correct version, tag ref, relay URL, and `publish_latest=true`. No manual action needed.

Internal desktop builds display a `-block` suffix in the version (e.g., `v0.3.0-block` in the Settings panel). This distinguishes them from OSS builds at a glance. iOS builds and GitHub release tags use the clean version (`0.3.0`) since Apple's `CFBundleShortVersionString` rejects pre-release suffixes.

### Manual Buildkite Trigger (Fallback)

If the automated trigger fails or you need a custom build (different relay URL, `publish_latest=false`, non-tag ref):

1. Go to the [sprout-releases pipeline](https://buildkite.com/runway/sprout-releases) and click **New Build**
2. Fill in the input fields:

   | Field | Value | Notes |
   |-------|-------|-------|
   | `version` | `0.3.0` | Semver, no `v` prefix |
   | `sprout_ref` | `v0.3.0` | The OSS git tag — use the tag, not a branch name |
   | `relay_url` | *(default)* | Pre-filled with the production relay; usually leave as-is |
   | `publish_latest` | `true` | Set to `false` for test builds |

---

## What Gets Published

Each release produces two GitHub releases:

1. **`v<version>`** — the user-facing release with the `.dmg` installer (macOS) and `.deb`/`.AppImage` (Linux).

2. **`sprout-desktop-latest`** — a rolling pre-release for the Tauri auto-updater containing `latest.json`, the signed `.tar.gz` archive, and its `.sig` signature.

---

## Prerequisites

- **Write access** to the `block/sprout` GitHub repository
- **`gh` CLI** authenticated (`gh auth status`)
- The following **GitHub Actions secrets** must be configured:

  | Secret / Variable | Purpose |
  |-------------------|---------|
  | `SPROUT_UPDATER_PUBLIC_KEY` | Tauri updater public key (minisign) |
  | `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater private key |
  | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key |
  | `RELEASE_APP_CLIENT_ID` (variable) | GitHub App client ID for release automation |
  | `RELEASE_APP_PRIVATE_KEY` (secret) | GitHub App private key for release automation |
  | `BUILDKITE_API_TOKEN` | Runway Buildkite API token (`write_builds` scope) |

---

## Troubleshooting

### `just release` fails with "must be on main branch"
Switch to `main` and pull latest before running `just release`.

### `just release` fails with "working tree is dirty"
Commit or stash your changes before running `just release`.

### Build fails at "Validate version"
The version string must be valid semver: `MAJOR.MINOR.PATCH` with an optional pre-release suffix. Do not include a `v` prefix.

### Auto-updater reports "no update available"
Verify that the `sprout-desktop-latest` release exists and contains a valid `latest.json`.

### `sync-release-changelog` workflow fails with "Multiple open release PRs"
More than one `version-bump/*` PR is open. Close or merge the stale one before the sync can resume.

### Internal Buildkite build didn't trigger after release PR merge
Check the `auto-tag-on-release-pr-merge` workflow run for errors in the "Trigger internal release build" step. Common causes: expired `BUILDKITE_API_TOKEN`, pipeline slug changed, or the token lacks `BUILD_AND_READ` access on the pipeline. Fall back to a [manual Buildkite trigger](#manual-buildkite-trigger-fallback).
