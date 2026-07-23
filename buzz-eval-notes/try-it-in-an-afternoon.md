# Try it in an afternoon (if you want to poke at it yourself)

The shortest path from clone to "an agent posts in a channel." Measured — this actually works. You do NOT need to read the 7 VISION docs first.

## Fastest: just run the desktop app

If you only want to *feel* it, grab a packaged build from the [latest release](https://github.com/block/buzz/releases/latest) — `Buzz_x.y.z_aarch64.dmg` for Apple Silicon. Install it, and either point it at a relay or stand one up (below). No build required — the DMG bundles the CLI + agent harness as sidecars.

## Headless relay + one agent (~45–75 min)

Prereqs: Docker + git. Everything else comes from Hermit (the repo's pinned toolchain), which installs itself in ~1 minute with no prompts.

```bash
git clone https://github.com/block/buzz.git && cd buzz
. ./bin/activate-hermit          # pulls Rust/Node/just, ~53s, zero prompts
just setup                       # docker up + migrate + seed local community
just build                       # cold Rust build — this is the long pole, 10–20 min
```

Then prove the round trip with the CLI:

```bash
# mint an identity
cargo run -p buzz-admin -- generate-key     # prints pubkey + secret
export BUZZ_PRIVATE_KEY=<secret>
export BUZZ_RELAY_URL=http://localhost:3000

buzz channels create --name eval-test --type stream --visibility open
buzz messages send --channel <uuid> --content "hello from buzz"
buzz messages get  --channel <uuid>          # reads it back — signed event, kind 9
```

## Wiring a Claude Code agent to a channel

```bash
npm install -g @agentclientprotocol/claude-agent-acp     # the ACP adapter
# make sure `claude auth status` is logged in — the agent rides THIS login

buzz-acp \
  --relay-url ws://localhost:3000 \
  --private-key <agent-secret> \
  --agent-command claude-code-acp \
  --respond-to anyone \          # bypass the owner-only silent-drop gate for local dev
  --heartbeat-interval 60        # so it catches up on a timer
```

## The three traps that eat time (skip the head-scratching)

1. **owner-only gate** — by default the agent silently drops EVERY event until an owner is registered (the blessed path routes through the desktop app). For local testing use `--respond-to anyone`. This is the single biggest "why isn't it responding" trap.
2. **`buzz-admin mint-token` doesn't exist** despite the ACP README — use `generate-key`. Dev default needs no API token (`BUZZ_REQUIRE_AUTH_TOKEN=false`).
3. **keycloak healthcheck is broken** — `docker compose up --wait` exits 1 on a stack that's actually fine (only postgres+redis are gated). Ignore it.

## Cleanup

```bash
docker compose down -v           # removes containers + volumes
```

## What you'll learn in 30 minutes

- Whether the desktop UX is a credible Slack replacement for us (my read: alpha, but the channel/thread/DM/canvas core works).
- Whether an agent-in-a-channel feels like the Transponder replacement (my read: yes, this is the strongest fit).
- Whether the "one context" search is useful (my read: it's keyword FTS, weaker than you'd hope — don't expect semantic recall).
