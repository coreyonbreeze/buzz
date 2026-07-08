import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * UPSCROLL-JITTER GATE (L-E) — the RED-today metric the fix train rides on.
 *
 * Tyler's report: scrolling UP a fully-loaded channel is jumpy in tiny
 * variations; scrolling DOWN is smooth. Eva's H1 says why: rows above the
 * opening viewport have NEVER painted, so they sit at `estimateRowHeight()`
 * reserves under `content-visibility: auto`. Scrolling up, each row realizes
 * at its TRUE height the instant it enters the realization band; the delta
 * (true - estimate) shifts content, and the browser's scroll anchoring only
 * corrects APPROXIMATELY, one lurch per realization. Down is smooth because
 * `contain-intrinsic-size: auto` has already remembered every passed row's
 * exact size.
 *
 * WHAT THIS MEASURES (the honest signal, not a proxy):
 * During a steady upscroll the content already on screen must translate by
 * exactly the wheel delta. If the viewport moves up by D px, every currently
 * visible element's `top` must increase by exactly D. Any residual
 * `(delta_top - D)` is content that jumped for a reason OTHER than the wheel —
 * a realization-induced anchor correction. That residual IS the jump Tyler
 * feels. A perfectly smooth scroll keeps every step's residual at 0.
 *
 * We track a row sitting COMFORTABLY INSIDE the viewport (a SAFE_MARGIN band
 * from both edges) so it stays realized across the whole step — its `top`
 * therefore reflects only true motion, never the ~one-row-height box jump a
 * STRADDLING row suffers when `content-visibility` un-realizes it as it exits
 * the top. When rows ABOVE the tracked row realize this step (true != estimate)
 * and native anchoring is off, the content below them — including our tracked
 * row — shifts down by the accumulated realization delta. That extra motion IS
 * the reading-position jump Tyler feels, and it lands cleanly in the residual.
 * We re-pick the tracked row each step and only score a step when the SAME id
 * stayed inside the safe band both before and after (a partial exit would
 * reintroduce the un-realization artifact). The gate is the WORST single-step
 * residual (peak lurch) plus the RMS residual (sustained micro-jitter) — a user
 * feels both the spike and the accumulated shimmer.
 *
 * VALIDITY (why this is the honest metric, not a proxy): a fully-realized
 * ("prewarmed") channel has NO realization deltas, so this residual collapses
 * to ~0 — the make-or-break control. A uniform channel realizes near-estimate,
 * so it stays low. Only the heterogeneous corpus, whose estimates miss, is RED.
 *
 * WHY IT IS RED TODAY: the `jitter-corpus` seed (e2eBridge.ts) is 400
 * structurally-rich rows whose true height `estimateRowHeight` is known to
 * miss (markdown headings/lists/blockquotes counted as flat 20px prose lines;
 * long prose vs the fixed CHARS_PER_LINE=64 guess; code-fence chrome). Every
 * never-painted row realizes with true != estimate, so a real per-step
 * residual appears. The thresholds sit under the baseline this corpus produces
 * at tip 77bd0e70, so the gate FAILS now and only a genuine estimator/anchor
 * fix turns it green.
 *
 * SCOPE / ENGINE FIDELITY: this runs under Playwright headed Chromium, which
 * ships `overflow-anchor` (native scroll anchoring). The app ships in
 * WKWebView, which — per Eva's L-C finding (Mari) — has NO `overflow-anchor`
 * at all: it corrects NOTHING, so every above-viewport realization delta lands
 * raw on the reading position. To make the red bar honest we therefore FORCE
 * `overflow-anchor: none` on the timeline scroller before measuring, so
 * Chromium reproduces the shipped engine's behavior instead of hiding exactly
 * the drift Tyler feels. We also log `CSS.supports("overflow-anchor","auto")`
 * so the per-engine baseline is on the record. A correct owned-compensation
 * fix (the converged train: `overflow-anchor: none` + same-frame
 * scrollBy(realized − reserved)) zeros this residual on ANY engine — which is
 * the point: it makes Chromium CI test what macOS users actually feel.
 *
 * Run headed to watch it:
 *   pnpm build && npx playwright test --config=playwright.perf.config.ts \
 *     upscroll-jitter --headed
 */

// Peak single-step residual we tolerate (px). Above this is a realization
// lurch the eye catches. RED at tip: baseline peaks well above.
const MAX_PEAK_RESIDUAL_PX = 2.0;
// RMS residual across steps (px) — the sustained micro-jitter floor.
const MAX_RMS_RESIDUAL_PX = 0.6;

const WHEEL_NOTCH = 220; // px per wheel step (Blink scales the applied delta)
const MAX_STEPS = 80; // cap; stop early once we near the top of the window
// Keep the tracked row this far (px) from both viewport edges so it stays
// realized across the step — no straddling-row un-realization artifact.
const SAFE_MARGIN = 100;

type StepSample = { residual: number; appliedDelta: number };

type Result = {
  samples: StepSample[];
  steps: number;
  reachedTop: boolean;
  rowCount: number;
};

test("GATE: upscroll anchor residual stays below the realization-jitter threshold", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
  );

  // The `jitter-corpus` channel is pre-seeded (e2eBridge.ts) with 400
  // heterogeneous rows in its mock store — no dependence on live-emit timing,
  // the same reliable cold-load path scroll-history.spec.ts uses.
  await page.getByTestId("channel-jitter-corpus").click();
  await expect(page.getByTestId("chat-title")).toHaveText("jitter-corpus");
  const timeline = page.getByTestId("message-timeline");
  await expect(timeline.locator("[data-message-id]").first()).toBeVisible();
  await page.waitForFunction(() => {
    const el = document.querySelector(
      '[data-testid="message-timeline"]',
    ) as HTMLDivElement | null;
    return !!el && el.scrollHeight > el.clientHeight + 1000;
  });

  // Pin to the true bottom so everything above is unpainted (at estimate).
  await timeline.evaluate((element) => {
    const el = element as HTMLDivElement;
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(150);

  // Log native-anchoring support for this engine, then FORCE it off so
  // Chromium reproduces the shipped WKWebView (which has no `overflow-anchor`).
  // Without this, Blink's native anchoring silently corrects the realization
  // shift and the gate would measure a world macOS users never see.
  const anchorSupport = await page.evaluate(() =>
    typeof CSS !== "undefined" && typeof CSS.supports === "function"
      ? CSS.supports("overflow-anchor", "auto")
      : false,
  );
  await timeline.evaluate((element) => {
    (element as HTMLElement).style.overflowAnchor = "none";
  });
  /* eslint-disable no-console */
  console.log(
    `overflow-anchor supported by this engine: ${anchorSupport} ` +
      `(forced to 'none' on the scroller to mirror shipped WKWebView)`,
  );
  /* eslint-enable no-console */
  await page.waitForTimeout(50);

  // Hover so the timeline owns wheel scrolling (mirrors a real reader; also
  // engages the `:hover` realization rule, utilities.css:21).
  await timeline.hover();

  const samples: StepSample[] = [];
  let reachedTop = false;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    // Pick a row sitting comfortably inside the viewport (SAFE_MARGIN from both
    // edges) so it stays realized across the wheel notch. Capture its top and
    // the scrollTop BEFORE the notch. reachedTop is decided by scrollTop, not by
    // whether a safe-band row exists.
    const before = await timeline.evaluate((element, margin: number) => {
      const el = element as HTMLDivElement;
      const box = el.getBoundingClientRect();
      const safeTop = box.top + margin;
      const safeBottom = box.bottom - margin;
      const rows = el.querySelectorAll<HTMLElement>("[data-message-id]");
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.top > safeTop && rect.bottom < safeBottom) {
          return {
            id: row.dataset.messageId ?? null,
            top: rect.top,
            scrollTop: el.scrollTop,
          };
        }
      }
      return { id: null, top: 0, scrollTop: el.scrollTop };
    }, SAFE_MARGIN);

    if (before.scrollTop <= 0) {
      reachedTop = true;
      break;
    }
    if (!before.id) {
      // No row fully inside the safe band this step (rare: a single row taller
      // than the band). Nudge up and try the next step rather than scoring it.
      await page.mouse.wheel(0, -WHEEL_NOTCH);
      await timeline.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          ),
      );
      continue;
    }

    // One real wheel notch upward, then settle two frames so realization +
    // any anchor correction land before we read positions back.
    await page.mouse.wheel(0, -WHEEL_NOTCH);
    await timeline.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );

    const after = await timeline.evaluate(
      (element, args: { id: string; margin: number }) => {
        const el = element as HTMLDivElement;
        const box = el.getBoundingClientRect();
        const row = el.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(args.id)}"]`,
        );
        if (!row)
          return { top: null, inSafeBand: false, scrollTop: el.scrollTop };
        const rect = row.getBoundingClientRect();
        return {
          top: rect.top,
          // Only score the step if the SAME row is still fully inside the band —
          // otherwise a partial exit would reintroduce the un-realization jump.
          inSafeBand:
            rect.top > box.top + args.margin &&
            rect.bottom < box.bottom - args.margin,
          scrollTop: el.scrollTop,
        };
      },
      { id: before.id, margin: SAFE_MARGIN },
    );

    const appliedDelta = before.scrollTop - after.scrollTop; // px moved up
    if (appliedDelta <= 0) {
      // No movement (already at top / wheel absorbed) — stop.
      reachedTop = after.scrollTop <= 0;
      break;
    }
    if (after.top === null || !after.inSafeBand) {
      // Tracked row left the safe band this step — skip scoring, keep scrolling.
      continue;
    }
    // Smooth: reducing scrollTop by appliedDelta moves the row DOWN the
    // viewport by exactly appliedDelta. Residual = motion NOT from the wheel,
    // i.e. realization deltas from rows that crossed the band ABOVE this row.
    const residual = after.top - before.top - appliedDelta;
    samples.push({ residual, appliedDelta });
  }

  const result: Result = {
    samples,
    steps: samples.length,
    reachedTop,
    rowCount: await timeline.evaluate(
      (el) =>
        (el as HTMLDivElement).querySelectorAll("[data-message-id]").length,
    ),
  };

  const abs = result.samples.map((s) => Math.abs(s.residual));
  const peak = abs.length ? Math.max(...abs) : 0;
  const rms = abs.length
    ? Math.sqrt(abs.reduce((a, r) => a + r * r, 0) / abs.length)
    : 0;
  const mean = abs.length ? abs.reduce((a, r) => a + r, 0) / abs.length : 0;

  /* eslint-disable no-console */
  console.log("\n=== UPSCROLL JITTER GATE (anchor residual, Chromium) ===");
  console.log(`rows mounted (live DOM):     ${result.rowCount}`);
  console.log(`steps measured:              ${result.steps}`);
  console.log(`reached top of history:      ${result.reachedTop}`);
  console.log(
    `peak single-step residual:   ${peak.toFixed(2)}px  (gate <= ${MAX_PEAK_RESIDUAL_PX})`,
  );
  console.log(
    `rms residual:                ${rms.toFixed(2)}px  (gate <= ${MAX_RMS_RESIDUAL_PX})`,
  );
  console.log(`mean |residual|:             ${mean.toFixed(2)}px`);
  console.log("(0 == every on-screen row tracked the wheel exactly)");
  console.log("========================================================\n");
  /* eslint-enable no-console */

  // Sanity: the run actually exercised a meaningful upscroll. The cold-load
  // windows the 400-row seed to the newest ~100 rows (CHANNEL_HISTORY_LIMIT),
  // all in the DOM (de-virtualized), so ~100 mounted rows is the expected
  // fully-loaded window we scroll within.
  expect(result.rowCount).toBeGreaterThanOrEqual(80);
  expect(result.samples.length).toBeGreaterThan(8);

  // THE GATE. RED at tip 77bd0e70; a real estimator/anchor fix turns it green.
  expect(peak).toBeLessThanOrEqual(MAX_PEAK_RESIDUAL_PX);
  expect(rms).toBeLessThanOrEqual(MAX_RMS_RESIDUAL_PX);
});
