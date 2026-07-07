# Installation

How to get each Buzz component onto your machine. Buzz ships three
independently versioned artifacts — the desktop app, the relay, and the
mobile app — plus source-built CLI tools.

## Supported platforms

| Component | Platforms | Distribution |
|---|---|---|
| Desktop app | macOS (Apple Silicon + Intel), Linux (`.deb`, `.AppImage`) | GitHub releases on [block/buzz](https://github.com/block/buzz/releases) |
| Relay | Any Docker host / Linux | `ghcr.io/block/buzz` container image |
| CLI (`buzz`) | Anywhere Rust builds | `cargo install` from source |
| Mobile | iOS + Android (Flutter) | 🚧 being wired up — internal builds only |

On Windows, the agent shell tool needs a bash: install
[Git for Windows](https://git-scm.com/download/win) (ships Git Bash), or point
`BUZZ_SHELL` at another bash-compatible shell.

## Desktop app

Download the latest `v<version>` release from
[GitHub releases](https://github.com/block/buzz/releases):

- **macOS Apple Silicon** — the `.dmg` installer
- **macOS Intel** — the `_x64.dmg` installer
- **Linux** — `.deb` or `.AppImage`

Both macOS DMGs are codesigned and notarized. The app auto-updates via the
`buzz-desktop-latest` rolling release (currently `darwin-aarch64` only; Intel
and Linux users download new versions manually — see
[RELEASING.md troubleshooting](../guides/releasing.md#troubleshooting)).

## Relay

The relay is published as a container image:

```bash
docker pull ghcr.io/block/buzz:main        # tip of main
docker pull ghcr.io/block/buzz:<version>   # tagged release
```

For a full single-node deployment (relay + Postgres + Redis + MinIO + TLS),
use the Docker Compose bundle in [`deploy/compose/`](../../deploy/compose/) —
see [Self-Hosting](../guides/self-hosting.md). For Kubernetes, use the
[Helm chart](../../deploy/charts/buzz/).

To build the relay from source instead:

```bash
git clone https://github.com/block/buzz.git && cd buzz
. ./bin/activate-hermit
cargo build --release -p buzz-relay
```

## CLI

The `buzz` CLI is built from source:

```bash
cargo install --path crates/buzz-cli    # from a checkout
# or, inside a checkout:
cargo build --release -p buzz-cli -p buzz-admin
export PATH="$PWD/target/release:$PATH"
```

See the [CLI Reference](../reference/cli.md) for commands and configuration.

## From source (everything)

For hacking on Buzz itself, follow the [Development guide](../guides/development.md):

```bash
git clone https://github.com/block/buzz.git && cd buzz
. ./bin/activate-hermit   # pinned toolchain (Rust 1.88+, Node 24+, pnpm 10+, just)
just setup && just build
```

## Verifying the install

```bash
buzz-relay &                                   # or: just relay
curl -s http://localhost:3000/health           # → ok
buzz --help                                    # CLI prints usage
```

Next: the [Quickstart](quickstart.md).
