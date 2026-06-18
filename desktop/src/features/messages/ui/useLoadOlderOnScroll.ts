import * as React from "react";

import type { ListVirtualizer } from "@/shared/ui/VirtualizedList";

type UseLoadOlderOnScrollOptions = {
  fetchOlder?: () => Promise<void>;
  hasOlderMessages: boolean;
  isLoading: boolean;
  restoreScrollPosition: (scrollTop: number) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /**
   * When the timeline is virtualized, prepended rows shift every index and are
   * mounted at an estimate (80px) before they measure, so the `scrollHeight`
   * delta anchor drifts. Supplying the virtualizer switches to an index anchor:
   * we hold the first-visible item across the prepend by its NEW index.
   */
  virtualizer?: {
    getVirtualizer: () => ListVirtualizer | null;
    itemCount: number;
  } | null;
};

/**
 * Triggers `fetchOlder` when a sentinel element near the top of the scroll
 * container enters the viewport, then restores the scroll position so the
 * visible content doesn't jump.
 */
export function useLoadOlderOnScroll({
  fetchOlder,
  hasOlderMessages,
  isLoading,
  restoreScrollPosition,
  scrollContainerRef,
  sentinelRef,
  virtualizer = null,
}: UseLoadOlderOnScrollOptions) {
  const restoreScrollPositionRef = React.useRef(restoreScrollPosition);
  React.useEffect(() => {
    restoreScrollPositionRef.current = restoreScrollPosition;
  });
  // Mirror the virtualizer option into a ref so the long-lived Intersection
  // observer reads the live getter + count without re-subscribing per render.
  const virtualizerRef = React.useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (
      !sentinel ||
      !container ||
      !fetchOlder ||
      isLoading ||
      !hasOlderMessages
    ) {
      return;
    }

    let disposed = false;
    let currentObserver: IntersectionObserver | null = null;

    const observe = () => {
      if (disposed) {
        return;
      }

      currentObserver = new IntersectionObserver(
        ([entry]) => {
          if (!entry.isIntersecting || disposed) {
            return;
          }

          currentObserver?.disconnect();

          const virt = virtualizerRef.current;
          if (virt) {
            // Index anchor: hold the first rendered item across the prepend.
            // Capture its index + the gap between its top and the viewport top
            // BEFORE the fetch; after the prepend shifts indices by N, re-aim at
            // `oldIndex + N` and restore that same intra-row gap. This is immune
            // to the estimate->measured height churn that makes a scrollHeight
            // delta drift.
            const instance = virt.getVirtualizer();
            const firstVisible = instance?.getVirtualItems()[0];
            const previousCount = virt.itemCount;
            const anchorIndex = firstVisible?.index ?? null;
            const anchorOffsetIntoRow =
              firstVisible && instance
                ? (instance.scrollOffset ?? 0) - firstVisible.start
                : 0;

            void fetchOlder().then(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  const after = virtualizerRef.current?.getVirtualizer();
                  const prepended =
                    (virtualizerRef.current?.itemCount ?? previousCount) -
                    previousCount;
                  if (after && anchorIndex !== null && prepended > 0) {
                    after.scrollToIndex(anchorIndex + prepended, {
                      align: "start",
                    });
                    // scrollToIndex aligns the row's top to the viewport top;
                    // re-apply the captured gap so the view doesn't nudge by a
                    // partial row.
                    const target = after.getOffsetForIndex(
                      anchorIndex + prepended,
                      "start",
                    );
                    if (target !== undefined) {
                      restoreScrollPositionRef.current(
                        target[0] + anchorOffsetIntoRow,
                      );
                    }
                  }
                  observe();
                });
              });
            });
            return;
          }

          const previousHeight = container.scrollHeight;
          const previousScrollTop = container.scrollTop;
          void fetchOlder().then(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const newHeight = container.scrollHeight;
                const delta = newHeight - previousHeight;
                if (delta > 0) {
                  restoreScrollPositionRef.current(previousScrollTop + delta);
                }
                observe();
              });
            });
          });
        },
        { root: container, rootMargin: "200px 0px 0px 0px" },
      );

      currentObserver.observe(sentinel);
    };

    observe();
    return () => {
      disposed = true;
      currentObserver?.disconnect();
    };
  }, [
    fetchOlder,
    hasOlderMessages,
    isLoading,
    scrollContainerRef,
    sentinelRef,
  ]);
}
