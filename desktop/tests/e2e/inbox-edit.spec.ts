import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const GENERAL_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const CURRENT_PUBKEY = "deadbeef".repeat(8);
const OWN_MESSAGE_ID = "d1".repeat(32);
const FOREIGN_MESSAGE_ID = "e2".repeat(32);
const SHOTS = "test-results/inbox-edit";

type MockFeedItem = {
  category: "activity";
  channel_id: string;
  channel_name: string;
  content: string;
  created_at: number;
  id: string;
  kind: number;
  pubkey: string;
  tags: string[][];
};

type MockWindow = Window & {
  __BUZZ_E2E_PUSH_MOCK_FEED_ITEM__?: (item: MockFeedItem) => unknown;
};

async function openMoreActions(
  page: import("@playwright/test").Page,
  messageId: string,
) {
  const row = page.locator(`[data-message-id="${messageId}"]`);
  await row.hover();
  await page.getByTestId(`more-actions-${messageId}`).click();
  await expect(page.locator('[role="menuitem"]').first()).toBeVisible();
}

test("Inbox offers a working Edit action only for manageable messages", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await expect(page.getByTestId("home-inbox-list")).toBeVisible();
  await page.waitForFunction(
    () =>
      typeof (window as MockWindow).__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__ ===
      "function",
  );

  await page.evaluate(
    ({
      channelId,
      currentPubkey,
      foreignPubkey,
      foreignMessageId,
      ownMessageId,
    }) => {
      const pushFeedItem = (window as MockWindow)
        .__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__;
      if (!pushFeedItem) {
        throw new Error("Mock feed helper is not installed.");
      }

      const createdAt = Math.floor(Date.now() / 1_000);
      const messages = [
        {
          content: "My Inbox message before editing.",
          createdAt,
          id: ownMessageId,
          pubkey: currentPubkey,
        },
        {
          content: "Another person's Inbox message.",
          createdAt: createdAt - 1,
          id: foreignMessageId,
          pubkey: foreignPubkey,
        },
      ];

      for (const message of messages) {
        pushFeedItem({
          category: "activity",
          channel_id: channelId,
          channel_name: "general",
          content: message.content,
          created_at: message.createdAt,
          id: message.id,
          kind: 9,
          pubkey: message.pubkey,
          tags: [["h", channelId]],
        });
      }
    },
    {
      channelId: GENERAL_CHANNEL_ID,
      currentPubkey: CURRENT_PUBKEY,
      foreignMessageId: FOREIGN_MESSAGE_ID,
      foreignPubkey: TEST_IDENTITIES.alice.pubkey,
      ownMessageId: OWN_MESSAGE_ID,
    },
  );

  await page.getByTestId(`home-inbox-item-${OWN_MESSAGE_ID}`).click();
  const detail = page.getByTestId("home-inbox-detail");
  await expect(detail).toContainText("My Inbox message before editing.");

  await openMoreActions(page, OWN_MESSAGE_ID);
  await expect(
    page.getByTestId(`edit-message-${OWN_MESSAGE_ID}`),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/01-edit-action.png` });
  await page.getByTestId(`edit-message-${OWN_MESSAGE_ID}`).click();
  await expect(detail.getByTestId("edit-target")).toBeVisible();

  const input = detail.getByTestId("message-input");
  await expect(input).not.toBeEmpty();
  await input.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("My Inbox message after editing.");
  await page.keyboard.press("Enter");

  await expect(detail.getByTestId("edit-target")).toBeHidden();
  await expect(
    detail.locator(`[data-message-id="${OWN_MESSAGE_ID}"]`),
  ).toContainText("My Inbox message after editing.");
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/02-edited-message.png` });

  await page.getByTestId(`home-inbox-item-${FOREIGN_MESSAGE_ID}`).click();
  await expect(detail).toContainText("Another person's Inbox message.");
  await openMoreActions(page, FOREIGN_MESSAGE_ID);
  await expect(
    page.getByTestId(`edit-message-${FOREIGN_MESSAGE_ID}`),
  ).toHaveCount(0);
});
