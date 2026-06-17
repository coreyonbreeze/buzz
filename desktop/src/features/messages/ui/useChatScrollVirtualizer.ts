import { type Virtualizer, useVirtualizer } from "@tanstack/react-virtual";
import * as React from "react";

import { BOTTOM_THRESHOLD_PX } from "@/features/messages/lib/timelineSnapshot";

export type ChatVirtualizer = Virtualizer<HTMLElement, Element>;

/** How long (ms) a deep-linked row stays highlighted before the glow fades. */
const HIGHLIGHT_DURATION_MS = 2_000;

/**
 * Single scroll owner for the chat surfaces (main timeline + thread pane).
 *
 * The hard scroll behaviors are owned by `@tanstack/react-virtual` (over
 * `virtual-core@3.17.0`), NOT hand-built here — that is the whole point of the
 * migration off the manual scroll manager:
 *
 *   - **Anchored prepend** (load-older holds the viewport): `anchorTo: "end"`.
 *     On a prepend the library captures the bottom anchor's key + relative
 *     offset and re-applies it after the new rows measure, so the viewport
 *     does not jump. This is the ResizeObserver-during-prepend race killed at
 *     the root.
 *   - **Bottom-stick during a burst**: `followOnAppend`. While pinned to the
 *     end the library re-scrolls to end on append, surviving measurement
 *     settle — no per-frame manual re-pin.
 *   - **Deep-link settle** (`scrollToIndex`): the library's internal
 *     reconcile loop re-targets the index until the offset is stable once the
 *     never-before-measured target row measures.
 *
 * What the library does NOT own — and this hook does:
 *
 *   - **Short-channel bottom-align pad.** A 2-3 message channel must sit at the
 *     bottom of the viewport. The virtualizer lays rows from the top, so we add
 *     a top pad of `max(0, viewportHeight - totalSize)`. It is recomputed off
 *     the LIVE `getTotalSize()` on every measurement pass (via `onChange`) so
 *     it collapses to 0 the instant content exceeds the viewport — see the
 *     ordering note below.
 *   - **The "at bottom" / new-message-count UI state** the scroll-to-latest
 *     pill reads. The library knows the geometry (`isAtEnd`); this hook lifts
 *     it to React state and counts messages that arrive while scrolled up.
 *   - **Deep-link highlight + completion callback.** `scrollToItem` drives the
 *     library jump, lights the target row for a beat, and fires
 *     `onTargetReached` once.
 */

export type ChatScrollVirtualizerOptions = {
  /** Number of flat virtual items. */
  count: number;
  /** Scroll container the surface owns (timeline/thread both own their own). */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Stable per-item key — byte-identical to the legacy render keys. */
  getItemKey: (index: number) => string;
  /** Estimated row height (px) before measurement. */
  estimateSize?: number;
  /** Vertical gap (px) the virtualizer inserts between rows. */
  gap?: number;
  /** Rows rendered outside the viewport on each side. */
  overscan?: number;
  /**
   * Key of the latest message in the rendered snapshot. When it changes while
   * the user is scrolled up, `newMessageCount` ticks up — drives the pill's
   * "N new messages" label. Pass `undefined` for an empty surface.
   */
  latestMessageKey?: string;
  /** Called once when a deep-link jump lands on its target. */
  onTargetReached?: (messageId: string) => void;
};

export type ChatScrollVirtualizer = {
  virtualizer: ChatVirtualizer;
  /**
   * Top padding (px) that bottom-aligns a channel whose content is shorter
   * than the viewport. Apply it to the row spacer's `paddingTop`. Always `0`
   * once content fills the viewport.
   */
  topPad: number;
  /** True while the surface is scrolled to (or near) the bottom. */
  isAtBottom: boolean;
  /** Messages that arrived while scrolled up; reset on reaching the bottom. */
  newMessageCount: number;
  /** Message id currently highlighted by a deep-link jump, or null. */
  highlightedMessageId: string | null;
  /** Jump to the end (the pill action). */
  scrollToBottom: (behavior: ScrollBehavior) => void;
  /**
   * Jump to a flat-item index, highlight `messageId`, and fire
   * `onTargetReached` once the library settles. The caller resolves the index
   * against the SAME snapshot the rows render from (the no-tearing guard).
   */
  scrollToItem: (index: number, messageId: string) => void;
};

export function useChatScrollVirtualizer({
  count,
  scrollRef,
  getItemKey,
  estimateSize = 80,
  gap,
  overscan = 6,
  latestMessageKey,
  onTargetReached,
}: ChatScrollVirtualizerOptions): ChatScrollVirtualizer {
  // Read the element lazily so the virtualizer binds once the ref attaches;
  // capturing `ref.current` at render time would freeze it at the first-render
  // `null` (mirrors VirtualizedList).
  const getScrollElement = React.useCallback(
    () => scrollRef.current,
    [scrollRef],
  );

  const [topPad, setTopPad] = React.useState(0);
  const [isAtBottom, setIsAtBottom] = React.useState(true);
  const [newMessageCount, setNewMessageCount] = React.useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<
    string | null
  >(null);

  // The bottom-state and pad recompute both read live geometry off the
  // virtualizer on each `onChange`. virtual-core fires `onChange` directly from
  // `resizeItem` on any size delta (not only on a visible-range change), which
  // is exactly when `getTotalSize()` moves — so a short channel whose rows
  // measure taller/shorter than the estimate re-pads (and re-evaluates "at
  // bottom") with the settled total. Running here, before paint and before the
  // library re-applies its end-anchoring/follow in the same pass, orders
  // "recompute pad -> re-pin bottom" and avoids a one-frame sliver when a short
  // channel grows past the viewport.
  const onChange = React.useCallback(
    (instance: ChatVirtualizer) => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) {
        return;
      }
      const pad = Math.max(0, scrollEl.clientHeight - instance.getTotalSize());
      setTopPad((prev) => (prev === pad ? prev : pad));

      // The app's "at bottom" rule is looser than the library's 1px default;
      // reuse the timeline's 72px threshold so the pill matches the old feel.
      const atBottom = instance.isAtEnd(BOTTOM_THRESHOLD_PX);
      setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom));
      if (atBottom) {
        setNewMessageCount((prev) => (prev === 0 ? prev : 0));
      }
    },
    [scrollRef],
  );

  const virtualizer = useVirtualizer({
    count,
    getScrollElement,
    estimateSize: () => estimateSize,
    getItemKey,
    overscan,
    gap,
    // Hold the viewport on prepend and pin to the bottom anchor for follow —
    // the two library-native behaviors that replace the manual scroll manager.
    // Both surfaces follow new messages, so `followOnAppend` is always on; the
    // library only re-pins when the user is already at the end.
    anchorTo: "end",
    followOnAppend: "auto",
    onChange,
  });

  // The pad/bottom-state also depend on the viewport height, which `onChange`
  // does not track — a window/pane resize that changes `clientHeight` without
  // resizing a row would leave them stale. Observe the container so the
  // bottom-align and pill state hold across resizes too.
  React.useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) {
      return;
    }
    const observer = new ResizeObserver(() => onChange(virtualizer));
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [scrollRef, onChange, virtualizer]);

  // Count messages that arrive while the user is scrolled up. When at the
  // bottom `followOnAppend` keeps us pinned and `onChange` zeroes the count, so
  // the increment only fires for genuinely-missed messages. Skips the first
  // observed key so opening a channel doesn't show a phantom count.
  const previousLatestKeyRef = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const previous = previousLatestKeyRef.current;
    previousLatestKeyRef.current = latestMessageKey;
    if (
      previous === undefined ||
      latestMessageKey === undefined ||
      latestMessageKey === previous ||
      isAtBottom
    ) {
      return;
    }
    setNewMessageCount((prev) => prev + 1);
  }, [latestMessageKey, isAtBottom]);

  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior) => {
      virtualizer.scrollToIndex(count - 1, { align: "end", behavior });
    },
    [virtualizer, count],
  );

  const highlightTimeoutRef = React.useRef<number | undefined>(undefined);
  const scrollToItem = React.useCallback(
    (index: number, messageId: string) => {
      // align:center + the library's reconcile loop re-targets the index until
      // the offset is stable once the (possibly never-measured) row measures —
      // the W1 deep-link settle, library-owned.
      virtualizer.scrollToIndex(index, { align: "center" });
      setHighlightedMessageId(messageId);
      setNewMessageCount(0);
      onTargetReached?.(messageId);

      window.clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedMessageId((current) =>
          current === messageId ? null : current,
        );
      }, HIGHLIGHT_DURATION_MS);
    },
    [virtualizer, onTargetReached],
  );

  React.useEffect(
    () => () => window.clearTimeout(highlightTimeoutRef.current),
    [],
  );

  return {
    virtualizer,
    topPad,
    isAtBottom,
    newMessageCount,
    highlightedMessageId,
    scrollToBottom,
    scrollToItem,
  };
}
