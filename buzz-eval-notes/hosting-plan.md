# Hosting plan — always-on relay on our GCP, agents on our laptops

Goal: the workspace is always up (host the relay), but we don't pay for or babysit cloud agents. Each of us runs our own agent on our own machine; overnight it's just off; on reopen it catches up.

## Topology

```
                 ┌─────────────────────────────────────┐
   Corey's Mac   │   GCP (Onbreeze project)            │   Mike's Mac
  ┌───────────┐  │  ┌───────────────────────────────┐  │  ┌───────────┐
  │ Desktop   │◄─┼─►│ buzz relay (VM or Cloud Run)  │◄─┼─►│ Desktop   │
  │  app      │  │  │  + Postgres + Redis + object  │  │  │  app      │
  │ +buzz-acp │  │  │    storage (GCS/MinIO)        │  │  │ +buzz-acp │
  └───────────┘  │  └───────────────────────────────┘  │  └───────────┘
   (agent lives  │   always-on, stable hostname+TLS    │   (agent lives
    on laptop)   └─────────────────────────────────────┘    on laptop)
```

## Relay: two ways, pick one

**Option A — single Compute Engine VM (simplest, recommended to start).**
- e2-small or e2-medium, running the repo's `deploy/compose` bundle: 5 containers (relay, Postgres, Redis, MinIO, minio-init).
- ~$15–40/mo.
- This is the path Block actually ships; least surprise.
- You own backups: schedule `pg_dump` + a GCS snapshot of the MinIO volume. (Buzz's own backup tool just prints a checklist — don't rely on it.)

**Option B — managed (more moving parts, less babysitting).**
- Cloud Run for the relay + Cloud SQL Postgres + Memorystore Redis + a GCS bucket for object storage.
- Win: **Cloud SQL does automated backups for you** — meaningful, given Buzz's upgrade/migration footguns.
- Caveat: the relay wants long-lived WebSocket connections; a persistent VM handles those more naturally than Cloud Run's request model. If we go Cloud Run, mind the WS timeout + session affinity.

**Either way — non-negotiable:**
- **Stable hostname + TLS.** `relay.getonbreeze.com` via our Cloudflare/GoDaddy DNS, TLS at a Caddy or Cloudflare front. The relay derives *which workspace you're in* from the HTTP Host header (this is the #2444 footgun — mismatched hostnames become two isolated worlds). Everyone connects by that ONE name. Never by IP, never by `localhost`.
- **Pin the relay image to a version tag**, never `ghcr.io/block/buzz:main`. In-place migration edits mean a floating tag can brick the DB on restart (#2472).

## Agents: laptop-resident, decoupled from the desktop window

Don't let the GUI own the agent — closing the window kills it (#2412). Run `buzz-acp` as its own service:

- It's a standalone binary (bundled in the desktop app as a sidecar, or built from source). Takes `--relay-url`, `--private-key`, `--owner`.
- Wrap it in a **launchd** user agent (macOS) so it starts at login and survives the desktop app closing.
- Flags that matter for our use case:
  - `--respond-to owner-only` (default) — only respond to our own messages. Fine for a 2-person relay; use `anyone` only if we want the agent answering everyone.
  - `--heartbeat-interval 60` — **the catch-up knob.** Wakes the agent on a timer so it drains the overnight backlog even if nothing new is posted. Default is 0 (off).
  - evalexpr filter rules — so the agent only burns a turn on events we care about (e.g. only in `#corey-mike`, only on `@mentions`).

## Credential model (no per-seat cost)

- The laptop agent rides the Claude Code / Codex login already on that machine. **No API key, no per-seat license.** Overnight it's off, so it costs nothing while we sleep.
- Only if we ever move an agent to the always-on box does it need its own billable credential — and since we're on GCP, **Claude via Vertex AI** (`CLAUDE_CODE_USE_VERTEX`) keeps that billing inside the Onbreeze project. We've decided we don't need that yet.

## What this setup does and doesn't buy

- ✅ Always-on workspace; both hop in anytime; full history persists; agents cost nothing overnight; on reopen they catch up (with heartbeat set).
- ❌ Doesn't fix Buzz's app-level rough edges: pin image versions (#2472), watch the partition roller (#2396), manual desktop updates. Those ride along wherever we host.

## Rough first-run checklist (when we come back to this)

1. Spin the VM (or Cloud Run + Cloud SQL) in the Onbreeze GCP project.
2. Point `relay.getonbreeze.com` at it; TLS via Caddy/Cloudflare.
3. Run `deploy/compose` with a pinned image tag; seed the community for that exact hostname.
4. Both install the desktop app; set `BUZZ_RELAY_URL=wss://relay.getonbreeze.com`.
5. Register each other's agents (owner binding); set `--heartbeat-interval` + filter rules.
6. Create `#corey-mike` + `#feed`; seed the 12 open Transponder delegations as threads.
7. Time-box it: if a blocking ask still sits 3 days without either of us or our agents acting, the problem was never transport — kill it.
