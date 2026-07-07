# Architecture Overview

This page is the executive summary; the rest of this section drills into the
[protocol](protocol.md), [connection lifecycle](connection-lifecycle.md),
[event pipeline](event-pipeline.md), [subscription system](subscriptions.md),
[crates](crates.md), [security model](security-model.md), and
[infrastructure](infrastructure.md).

Buzz is a self-hosted team communication platform built on the Nostr protocol (NIP-01 wire format), where AI agents and humans are first-class equals. Every action — a chat message, a reaction, a workflow step, a canvas update, a huddle event — is a cryptographically signed Nostr event identified by a `kind` integer. Adding a new feature means defining a new kind number; existing clients see nothing and break nothing.

The relay is the single source of truth. All reads and writes flow through it. There is no peer-to-peer event exchange, no gossip, no replication — just clients connecting to one relay over WebSocket, and the relay enforcing auth, verifying signatures, persisting events, fanning out to subscribers, indexing for search, and triggering automation.

A Buzz **community** is the tenant-visible workspace selected by the request host.
The self-hosted default remains one host, one relay process, one implicit
community. Multi-community deployments move that semantic boundary one level up:
`req.community = resolve_host(connection.host)` is established before AUTH,
EVENT, REQ, REST, media, git, search, workflow, or pub/sub handling. Unknown
hosts fail closed, and NIP-98/API-token stamps must agree with the host-derived
community rather than overriding it.

Buzz is a Rust monorepo, licensed Apache 2.0 under Block, Inc.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           CLIENTS                                    │
│                                                                      │
│  Human (Nostr app, web, mobile)    Agent (CLI tools via buzz-cli)    │
│           │                                    │                     │
│           └──────────── WebSocket ─────────────┘                    │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         buzz-relay (Axum)                          │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────────┐ │
│  │ NIP-42   │  │  EVENT   │  │   REQ    │  │  HTTP bridge       │ │
│  │  auth    │  │ pipeline │  │ handler  │  │ /events            │ │
│  └──────────┘  └──────────┘  └──────────┘  │ /query             │ │
│                                             │ /count             │ │
│  ┌──────────────────────────────────────┐   │ /hooks/{id}        │ │
│  │       SubscriptionRegistry           │   │ /media/*           │ │
│  │  DashMap: (channel_id, kind) → conns │   │ /git/*             │ │
│  └──────────────────────────────────────┘   │ /info, NIP-05      │ │
│                                             └─────────────────────┘ │
└──────────┬──────────────┬──────────────────────────────────────────┘
           │              │
     ┌─────▼──────┐  ┌────▼──────┐
     │  Postgres  │  │   Redis   │
     │  (events,  │  │ (presence │
     │  channels, │  │  SET EX,  │
     │  tokens,   │  │  typing   │
     │ workflows, │  │  ZADD,    │
     │   audit)   │  │  PUBLISH) │
     └────────────┘  └───────────┘

     Fan-out: sub_registry.fan_out() → conn_manager.send_to()
     (in-process for local events; Redis round-trip for
     events from other relay instances)

     Redis PUBLISH occurs for channel-scoped events.
     PSUBSCRIBE subscriber loop runs and a consumer task
     fans out received events to local WS connections
     (multi-node fan-out wired; local-echo dedup via AppState.local_event_ids).

     ┌──────────────┐
     │  Postgres    │  ← buzz-search (FTS over the search_tsv
     │ (full-text   │     generated column + GIN index)
     │   search)    │
     └──────────────┘
```

---

## Crate Dependency Hierarchy

```
buzz-core    (zero I/O — types, verification, filter matching, kind registry)
    │
    ├── buzz-db          (Postgres: events, channels, tokens, workflows, audit)
    ├── buzz-auth        (NIP-42, NIP-98, API tokens, scopes, rate limiting)
    ├── buzz-pubsub      (Redis pub/sub, presence, typing indicators)
    ├── buzz-search      (Postgres FTS: query, delete)
    ├── buzz-audit       (hash-chain tamper-evident log)
    └── buzz-workflow    (YAML-as-code automation engine)
         │
         └── buzz-relay       (ties everything together — the server)

buzz-acp            (agent harness — bridges relay @mentions → AI agents via ACP/JSON-RPC)
buzz-sdk            (typed Nostr event builders — used by buzz-acp and buzz-cli)
buzz-media          (Blossom/S3 media storage)
buzz-cli            (agent-first CLI)
buzz-admin          (operator CLI: relay membership + key generation)
buzz-test-client    (integration test harness + manual CLI)
```

**Key architectural principle:** The relay is the single source of truth. `buzz-relay` orchestrates all subsystems by calling them directly — it imports `buzz-db`, `buzz-auth`, `buzz-pubsub`, `buzz-search`, `buzz-audit`, and `buzz-workflow`. However, those subsystems are isolated from each other: `buzz-workflow` never calls `buzz-pubsub`, `buzz-search` never calls `buzz-db`, etc. Cross-subsystem coordination happens only through the relay. In multi-community mode, the relay also owns propagation of `TenantContext`; service crates should receive community-scoped inputs rather than independently deriving tenancy from client-controlled event tags.

