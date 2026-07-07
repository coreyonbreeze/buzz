# Security Model

Every security-sensitive operation in Buzz uses an explicit, verified
pattern — no implicit trust. This page covers authentication, input
validation, SSRF protection, audit integrity, access control, and webhook
security. To report a vulnerability, see [`SECURITY.md`](../../SECURITY.md)
at the repository root. Multi-tenant isolation is formally specified in
[`docs/multi-tenant-relay.md`](../multi-tenant-relay.md) and the
[`docs/spec/`](../spec/) TLA+/Tamarin models.

Every security-sensitive operation uses an explicit, verified pattern. No implicit trust.

## Authentication

| Concern | Mechanism |
|---------|-----------|
| NIP-42 timestamp | ±60 second tolerance — prevents replay attacks |
| AUTH events | Never stored in Postgres, never logged in audit chain |
| NIP-98 HTTP Auth | Schnorr-signed `kind:27235` events — URL and method verification |

## Input Validation

| Concern | Mechanism |
|---------|-----------|
| Schnorr signatures | `verify_event()` in `buzz-core` — every event verified before storage |
| Event ID | SHA-256 of canonical serialization verified independently of signature |
| Frame size | `MAX_FRAME_BYTES = 65,536` — oversized frames rejected, connection closed |
| Search event IDs | 64-char hex validation before URL construction — prevents path injection |
| Workflow step IDs | Alphanumeric + underscore only — prevents evalexpr variable injection |
| Partition names | Allowlist of table names + strict suffix/date validators — prevents DDL injection |

## SSRF Protection

`is_private_ip()` in `buzz-core` covers:
- IPv4: unspecified (0.0.0.0/8), loopback (127.0.0.0/8), private (10/8, 172.16/12, 192.168/16), link-local (169.254/16), CGNAT (100.64/10), benchmarking (198.18/15), broadcast (255.255.255.255)
- IPv6: loopback (::1), ULA (fc00::/7), link-local (fe80::/10), multicast (ff00::/8), documentation (2001:db8::/32)
- IPv4-mapped IPv6 (::ffff:0:0/96) — recursively checks the embedded IPv4 address

Applied in: `buzz-workflow` (CallWebhook action), `buzz-core` (shared utility).

## Audit Integrity

- Hash chain: each entry's SHA-256 covers all fields including `prev_hash` — tampering any entry breaks all subsequent hashes
- Canonical JSON: `BTreeMap` for deterministic key ordering — hash is reproducible
- Single-writer lock: `pg_advisory_lock` — prevents concurrent writes from breaking the chain
- Panic-safe: `catch_unwind` ensures lock release even on panic

## Access Control

- Channel membership is the only gate — enforced by the relay at every operation
- REQ handler checks access before subscription registration — no race window for private channel leaks
- TOCTOU-safe membership operations: all check-then-modify sequences run inside Postgres transactions
- Approval tokens: UUID (CSPRNG), stored as SHA-256 hash, single-use enforced with `AND status = 'pending'` in UPDATE

## Webhook Security

- Workflow webhooks: constant-time XOR comparison of stored UUID secret (not HMAC — compares the secret directly, not a body MAC)
- Outbound webhooks (CallWebhook): SSRF protection + redirects disabled + 1 MiB response cap

