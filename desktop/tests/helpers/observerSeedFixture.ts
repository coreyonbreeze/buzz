// Populated observer-transcript fixture for PR-3 screenshot capture.
//
// Produces a faithful `ObserverEvent[]` that, when fed through the production
// `appendAgentEvent → processTranscriptEvent → getAgentTranscript` pipeline via
// `__BUZZ_E2E_SEED_OBSERVER_FRAMES__`, renders the full range of populated
// Activity-panel states Marge needs to review #1061's UI:
//   - lifecycle rows (turn started / session ready)
//   - a grouped user prompt with [Buzz event] context sections + author avatar
//   - an assistant message bubble
//   - a thinking row and a plan row
//   - a read tool_call → completed update (read_file)
//   - a shell tool rendered as a message-style chat bubble (buzz messages send)
//   - a view_image tool_call carrying an inline image thumbnail (mediaInset)
//
// The event shapes mirror the real ACP wire frames: `acp_write session/prompt`
// and `acp_read session/update` with the sessionUpdate discriminator. See
// agentSessionTranscript.ts / agentSessionTranscriptHelpers.ts for the parser
// these payloads are reverse-engineered from.

type ObserverEvent = {
  seq: number;
  timestamp: string;
  kind: string;
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  payload: unknown;
};

const SESSION_ID = "sess-pr3-001";
const TURN_ID = "turn-pr3-001";

// Canonical seed identities, mirroring the conventions used by the other
// screenshot specs (active-turn-screenshots.spec.ts):
//   - agent pubkey is a deterministic all-`aa` hex string
//   - the channel is the well-known mock "general" channel id
export const OBSERVER_SEED_AGENT_PUBKEY = "aa".repeat(32);
export const OBSERVER_SEED_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";

// Human author whose prompt triggers the seeded turn (drives the prompt avatar).
const OBSERVER_SEED_AUTHOR_PUBKEY =
  "e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34";

// A tiny 1x1 transparent PNG data URL — stands in for a view_image thumbnail
// so the mediaInset rendering path lights up without shipping a binary asset.
const SAMPLE_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type FixtureOptions = {
  channelId: string;
  /** hex pubkey of the human whose prompt triggered the turn (drives avatar) */
  authorPubkey: string;
};

export function buildPopulatedObserverEvents(
  opts: FixtureOptions,
): ObserverEvent[] {
  const { channelId, authorPubkey } = opts;
  let seq = 0;
  const base = Date.parse("2026-06-15T18:00:00.000Z");
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

  const ev = (
    kind: string,
    payload: unknown,
    offsetMs: number,
  ): ObserverEvent => {
    seq += 1;
    return {
      seq,
      timestamp: at(offsetMs),
      kind,
      agentIndex: 0,
      channelId,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      payload,
    };
  };

  const sessionUpdate = (update: Record<string, unknown>) => ({
    method: "session/update",
    params: { update },
  });

  return [
    // ── lifecycle ──────────────────────────────────────────────────────────
    ev("turn_started", { triggeringEventIds: ["evt-aaaa", "evt-bbbb"] }, 0),
    ev("session_resolved", { isNewSession: true }, 200),

    // ── user prompt with [Buzz event] context (drives grouped prompt + avatar)
    ev(
      "acp_write",
      {
        method: "session/prompt",
        params: {
          prompt: [
            {
              text: [
                "[System]",
                "You are a helpful Buzz agent.",
                "[Buzz event: chat message]",
                `From: Marge (hex: ${authorPubkey})`,
                "Content: Can you read the config file and post a summary to the channel? Also grab a screenshot.",
              ].join("\n"),
            },
          ],
        },
      },
      400,
    ),

    // ── assistant thinking + message ─────────────────────────────────────────
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: {
          text: "I'll read the config, summarize it, post to the channel, then attach a screenshot.",
        },
      }),
      600,
    ),
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "plan",
        content: {
          text: "1. Read config.toml\n2. Summarize key settings\n3. Send summary via buzz messages send\n4. Capture + attach a screenshot",
        },
      }),
      700,
    ),
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: {
          text: "On it. Reading the config now, then I'll post a summary.",
        },
      }),
      800,
    ),

    // ── read_file tool_call → completed (read tone) ──────────────────────────
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-read-1",
        title: "Read config.toml",
        toolName: "read_file",
        status: "executing",
        rawInput: { path: "config.toml", limit: 40 },
      }),
      1000,
    ),
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-read-1",
        status: "completed",
        content: {
          text: '[server]\nport = 3000\nrelay = "wss://sprout-oss.stage.blox.sqprod.co"\n[features]\nobserver = true',
        },
      }),
      1200,
    ),

    // ── shell tool: buzz messages send (renders as message-style chat bubble) ─
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-shell-1",
        title: "Shell",
        toolName: "shell",
        status: "executing",
        rawInput: {
          command:
            "buzz messages send --channel a9f57da5 --content 'Config summary: port 3000, observer enabled, relay on stage.'",
        },
      }),
      1400,
    ),
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-shell-1",
        status: "completed",
        content: { text: '{"accepted":true,"event_id":"8fc888cb..."}' },
      }),
      1600,
    ),

    // ── view_image tool: carries a thumbnail (mediaInset rendering) ───────────
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-img-1",
        title: "View image",
        toolName: "view_image",
        status: "executing",
        rawInput: { source: "screenshot.png" },
      }),
      1800,
    ),
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-img-1",
        status: "completed",
        content: [
          { type: "image", mimeType: "image/png", data: SAMPLE_IMAGE_DATA_URL },
          { text: "Captured the Activity panel screenshot (1280x800)." },
        ],
      }),
      2000,
    ),

    // ── closing assistant message ────────────────────────────────────────────
    ev(
      "acp_read",
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-2",
        content: {
          text: "Done — summary posted and the screenshot is attached above. Anything else?",
        },
      }),
      2200,
    ),
  ];
}

// Pre-built populated transcript for the canonical seed agent + channel. The
// screenshot spec feeds this straight into `__BUZZ_E2E_SEED_OBSERVER_FRAMES__`.
export const observerSeedFrames = buildPopulatedObserverEvents({
  channelId: OBSERVER_SEED_CHANNEL_ID,
  authorPubkey: OBSERVER_SEED_AUTHOR_PUBKEY,
});
