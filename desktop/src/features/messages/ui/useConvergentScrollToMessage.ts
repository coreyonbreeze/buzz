import * as React from "react";

import {
  type ConvergenceAlign,
  convergenceStep,
} from "@/features/messages/lib/scrollConvergence";
import type { ListVirtualizer } from "@/shared/ui/VirtualizedList";

/** Offset (px) within which the library is considered to have reached the target. */
const SETTLE_TOLERANCE_PX = 2;

type ConvergentScrollOptions = {
  /** Live message-id -> item-index map, rebuilt with the flattened item stream. */
  indexByMessageId: Map<string, number>;
  /** Where the target should land in the viewport. */
  align: ConvergenceAlign;
  /** Fired on the settled frame once the target row has converged. */
  onConverged?: (messageId: string) => void;
  /** Fired when the loop stops without converging (target deleted, or frame cap). */
  onAbandoned?: (messageId: string) => void;
};

type ConvergentScrollController = {
  /**
   * Begins a convergence loop toward `messageId`. Returns `true` when the id is
   * present in the data (loop started), `false` when it is absent (never
   * off-screen-false — only data-absent-false, matching the deep-link contract).
   * A new call cancels any in-flight loop.
   */
  scrollToMessage: (messageId: string) => boolean;
  /** Cancels any in-flight convergence loop (e.g. on unmount or channel switch). */
  cancel: () => void;
};

/**
 * Drives @tanstack/react-virtual to settle on an off-screen message by id.
 *
 * The library already converges OFFSETS: one `scrollToIndex(i)` captures index
 * `i` and its `reconcileScroll` rAF loop re-aims as rows mount and measure. But
 * it chases the INDEX captured at call time — a prepend/delete mid-settle leaves
 * it on the wrong row. This adapter closes that gap: each frame it re-resolves
 * the target's CURRENT index from the live map (the pure `convergenceStep`
 * reducer owns the decision) and re-issues `scrollToIndex` ONLY when the index
 * moved. In steady state it issues nothing, so it never resets the library's
 * internal stable-frame counter and the library settles in one frame.
 *
 * Settle detection is a trivial offset-equality check (NOT the convergence math,
 * which the library owns): the measured offset for the current index is within
 * tolerance of where the library would place it, and the offset is unchanged
 * from the prior frame.
 */
export function useConvergentScrollToMessage(
  getVirtualizer: () => ListVirtualizer | null,
  {
    indexByMessageId,
    align,
    onConverged,
    onAbandoned,
  }: ConvergentScrollOptions,
): ConvergentScrollController {
  // Mirror inputs into refs so the rAF loop closure always reads live values
  // without re-subscribing the loop each render.
  const mapRef = React.useRef(indexByMessageId);
  mapRef.current = indexByMessageId;
  const alignRef = React.useRef(align);
  alignRef.current = align;
  const onConvergedRef = React.useRef(onConverged);
  onConvergedRef.current = onConverged;
  const onAbandonedRef = React.useRef(onAbandoned);
  onAbandonedRef.current = onAbandoned;

  const rafIdRef = React.useRef<number | null>(null);

  const cancel = React.useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const scrollToMessage = React.useCallback(
    (messageId: string) => {
      const startIndex = mapRef.current.get(messageId);
      if (startIndex === undefined) {
        return false;
      }

      cancel();

      let lastIssuedIndex: number | null = null;
      let previousOffset: number | null = null;
      let framesUsed = 0;

      const frame = () => {
        rafIdRef.current = null;
        const virtualizer = getVirtualizer();
        if (!virtualizer) {
          return;
        }

        const currentIndex = mapRef.current.get(messageId);
        // The library has settled this frame when its offset reached the target
        // index's offset (within tolerance) and stopped moving. `currentIndex`
        // is re-read so a settle on a stale index never counts as converged.
        let librarySettled = false;
        if (currentIndex !== undefined && lastIssuedIndex === currentIndex) {
          const offset = virtualizer.scrollOffset ?? 0;
          const target = virtualizer.getOffsetForIndex(
            currentIndex,
            alignRef.current,
          );
          const reachedTarget =
            target !== undefined &&
            Math.abs(offset - target[0]) <= SETTLE_TOLERANCE_PX;
          const offsetStable =
            previousOffset !== null &&
            Math.abs(offset - previousOffset) <= SETTLE_TOLERANCE_PX;
          librarySettled = reachedTarget && offsetStable;
          previousOffset = offset;
        } else {
          previousOffset = virtualizer.scrollOffset ?? 0;
        }

        const decision = convergenceStep({
          targetMessageId: messageId,
          indexByMessageId: mapRef.current,
          lastIssuedIndex,
          librarySettled,
          framesUsed,
        });

        if (
          decision.nextIndex !== null &&
          decision.nextIndex !== lastIssuedIndex
        ) {
          // Re-aim only when the index actually moved — re-issuing the same
          // index would reset the library's stable-frame counter forever.
          virtualizer.scrollToIndex(decision.nextIndex, {
            align: alignRef.current,
          });
          lastIssuedIndex = decision.nextIndex;
        }

        if (decision.done) {
          if (decision.converged) {
            onConvergedRef.current?.(messageId);
          } else {
            onAbandonedRef.current?.(messageId);
          }
          return;
        }

        framesUsed += 1;
        rafIdRef.current = requestAnimationFrame(frame);
      };

      rafIdRef.current = requestAnimationFrame(frame);
      return true;
    },
    [cancel, getVirtualizer],
  );

  React.useEffect(() => cancel, [cancel]);

  return { scrollToMessage, cancel };
}
