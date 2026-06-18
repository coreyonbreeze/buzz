import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// Screenshot capture for the channel-jumping timeline fix (PR: virtualize
// timeline). The bug froze the rendered window on the newest ~11 rows after a
// memo-boundary re-render severance — scrolling back through history was
// impossible. Each shot is gated by a geometry assertion so a regression fails
// the run rather than silently producing a misleading image. The frozen-window
// "before" shot is intentionally not captured here: it only manifests with the
// fix removed, and faking it would misrepresent the build. Artifacts land in
// test-results/timeline-scroll-anchor/.
const SHOTS = "test-results/timeline-scroll-anchor";

// #load-older seeds 260 backdated messages; the newest 200 load at open and the
// rest page in via load-older. Anchor index 100 is inside the initial window
// (oldest loaded is index 60) but far enough from the bottom that reaching it
// requires real scrollback. Index 0 is the oldest message — the top of history.
const ANCHOR_ID = "mock-load-older-100";
const OLDEST_ID = "mock-load-older-0";

// Top of a row (by message id) relative to the scroll container, or null when
// the row is not mounted. The id is passed as the evaluate argument because the
// page-function is serialized into the browser and cannot close over test scope.
function rowTopWithin(timeline: Locator, id: string) {
  return timeline.evaluate((element, messageId) => {
    const row = element.querySelector(`[data-message-id="${messageId}"]`);
    if (!row) {
      return null;
    }
    return (
      row.getBoundingClientRect().top - element.getBoundingClientRect().top
    );
  }, id);
}

test.describe("timeline scroll-anchor screenshots", () => {
  test("02 — scrollback tracks the window to an older anchor row", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-load-older").click();
    await expect(page.getByTestId("chat-title")).toHaveText("load-older");

    const timeline = page.getByTestId("message-timeline");
    await expect(page.getByTestId("message-row").first()).toBeVisible();

    // Wheel up in bounded steps until the anchor mounts and parks in the upper
    // viewport — the position a reader holds while paging older history. Under
    // the freeze the window never left the newest rows, so index 100 never
    // mounted and this loop would exhaust without parking the anchor.
    await timeline.hover();
    let anchorTop: number | null = null;
    for (let i = 0; i < 120; i++) {
      anchorTop = await rowTopWithin(timeline, ANCHOR_ID);
      if (anchorTop !== null && anchorTop >= 0 && anchorTop <= 200) {
        break;
      }
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(40);
    }
    // The window tracked the scrollback: the older anchor is mounted on screen.
    expect(anchorTop).not.toBeNull();

    await page.screenshot({ path: `${SHOTS}/02-scrollback-tracking.png` });
  });

  test("03 — scrollback reaches the top of channel history", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-load-older").click();
    await expect(page.getByTestId("chat-title")).toHaveText("load-older");

    const timeline = page.getByTestId("message-timeline");
    await expect(page.getByTestId("message-row").first()).toBeVisible();

    // Keep wheeling up until the oldest message (index 0) mounts. This pages in
    // every older batch via load-older, then renders the top of history — only
    // reachable if the window tracks scrollback the whole way up.
    await timeline.hover();
    let oldestTop: number | null = null;
    for (let i = 0; i < 400; i++) {
      oldestTop = await rowTopWithin(timeline, OLDEST_ID);
      if (oldestTop !== null && oldestTop >= 0) {
        break;
      }
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(40);
    }
    // The oldest row is mounted and visible — the top of history rendered.
    expect(oldestTop).not.toBeNull();

    await page.screenshot({ path: `${SHOTS}/03-top-of-history.png` });
  });
});
