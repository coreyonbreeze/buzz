import { expect, test } from "@playwright/test";

import { KIND_TYPING_INDICATOR } from "../../src/shared/constants/kinds";
import { installMockBridge } from "../helpers/bridge";
import {
  OBSERVER_SEED_AGENT_PUBKEY,
  observerSeedFrames,
} from "../helpers/observerSeedFixture";

// Channel the seeded agent is a member of (via the managedAgents seed below).
// The agent must be a member of the navigated channel so it classifies as a
// channel-session agent — that's what renders the composer activity trigger.
const SEED_CHANNEL_NAME = "general";

// Poll until the mock relay has a live typing-indicator subscription for the
// channel. Without this, the typing event is emitted before the channel
// subscribes and is silently dropped, so the composer trigger never paints.
async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
  kind?: number,
) {
  await expect
    .poll(async () =>
      page.evaluate(
        ({ currentChannelName, kind }) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
                kind?: number;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: currentChannelName,
            kind,
          }) ?? false,
        { currentChannelName: channelName, kind },
      ),
    )
    .toBe(true);
}

const SHOTS = "test-results/observer-seed";

// Themes the populated panel is captured against. Values map to the real
// THEME_STORAGE_KEY entries read by ThemeProvider (light = catppuccin-latte,
// dark = houston).
const THEMES = [
  { label: "light", value: "catppuccin-latte" },
  { label: "dark", value: "houston" },
] as const;

function asWindow(page: import("@playwright/test").Page) {
  return page;
}

async function waitForBridge(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () =>
      typeof (
        window as Window & {
          __BUZZ_E2E_SEED_OBSERVER_FRAMES__?: unknown;
        }
      ).__BUZZ_E2E_SEED_OBSERVER_FRAMES__ === "function",
    null,
    { timeout: 10_000 },
  );
}

// Drives the app from the channel list into the agent-session thread panel for
// the seeded agent, then injects the populated observer transcript. The agent
// is surfaced in the composer activity bar via a mock typing indicator, which
// is what renders the `bot-activity-composer-*` controls.
async function openSeededAgentSession(
  page: import("@playwright/test").Page,
  themeValue: string,
) {
  // Set the theme before the app boots so the first paint is already themed.
  await page.addInitScript((value) => {
    window.localStorage.setItem("buzz-theme", value);
  }, themeValue);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForBridge(page);

  // Open #general and surface the agent as "typing" so the composer activity
  // bar exposes the trigger + per-agent item. Wait for the typing-indicator
  // subscription to go live first so the emitted event isn't dropped.
  await page.getByTestId(`channel-${SEED_CHANNEL_NAME}`).click();
  await waitForMockLiveSubscription(
    page,
    SEED_CHANNEL_NAME,
    KIND_TYPING_INDICATOR,
  );
  await page.evaluate((pubkey) => {
    (
      window as Window & {
        __BUZZ_E2E_EMIT_MOCK_TYPING__?: (input: {
          channelName: string;
          pubkey: string;
        }) => void;
      }
    ).__BUZZ_E2E_EMIT_MOCK_TYPING__?.({
      channelName: "general",
      pubkey,
    });
  }, OBSERVER_SEED_AGENT_PUBKEY);

  await expect(page.getByTestId("bot-activity-composer-trigger")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId("bot-activity-composer-trigger").click();
  await page
    .getByTestId(`bot-activity-composer-item-${OBSERVER_SEED_AGENT_PUBKEY}`)
    .click({ force: true });

  const panel = page.getByTestId("agent-session-thread-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });

  // Inject the already-decrypted observer transcript through the production
  // appendAgentEvent -> processTranscriptEvent pipeline.
  await page.evaluate(
    ({ agentPubkey, events }) => {
      (
        window as Window & {
          __BUZZ_E2E_SEED_OBSERVER_FRAMES__?: (input: {
            agentPubkey: string;
            events: unknown[];
          }) => void;
        }
      ).__BUZZ_E2E_SEED_OBSERVER_FRAMES__?.({ agentPubkey, events });
    },
    { agentPubkey: OBSERVER_SEED_AGENT_PUBKEY, events: observerSeedFrames },
  );

  return panel;
}

test.describe("observer-seed populated panel screenshots", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const theme of THEMES) {
    test(`populated transcript — ${theme.label}`, async ({ page }) => {
      await installMockBridge(asWindow(page), {
        managedAgents: [
          {
            pubkey: OBSERVER_SEED_AGENT_PUBKEY,
            name: "Fizz",
            status: "running",
            channelNames: ["general"],
          },
        ],
      });

      const panel = await openSeededAgentSession(page, theme.value);

      // The seeded transcript renders a user prompt, an assistant message, and
      // tool/shell summaries — assert one stable marker before capturing so the
      // shot isn't taken mid-render. The compact tool row renders the friendly
      // label ("Read file"), not the raw tool name.
      await expect(panel).toContainText("Read file", { timeout: 10_000 });

      await panel.screenshot({
        path: `${SHOTS}/populated-${theme.label}.png`,
      });
    });
  }
});
