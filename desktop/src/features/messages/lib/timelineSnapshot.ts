/**
 * Pure helpers that read a timeline message snapshot to compute the values the
 * timeline render needs: sticky-bottom autoscroll, day dividers, jump-to-message
 * deep links, and the deferred reply-list render state.
 *
 * Keeping these out of the component render body / scroll-manager effects lets
 * them be covered by the lib-level `*.test.mjs` suite. It also enforces the key
 * correctness property: every decision must read off the SAME snapshot. If the
 * deep-link lookup reads a fresher list than the rows the DOM has actually
 * committed, a jump fires against a row that isn't there yet and silently fails.
 */

import type { TimelineMessage } from "@/features/messages/types";
import { KIND_SYSTEM_MESSAGE } from "@/shared/constants/kinds";
import { isSameDay } from "./dateFormatters";
import {
  type MainTimelineEntry,
  type TimelineThreadSummary,
  shouldRenderUnreadDivider,
} from "./threadPanel";

/** Distance (px) from the bottom within which the timeline counts as "at bottom". */
export const BOTTOM_THRESHOLD_PX = 72;

/** Minimal scroll geometry the sticky-bottom decision needs — a pure subset of the DOM element. */
export type ScrollMetrics = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

/**
 * Is the timeline scrolled close enough to the bottom to count as "at bottom"?
 * Pure over geometry so the threshold math is testable without a DOM.
 */
export function isNearBottomMetrics(metrics: ScrollMetrics): boolean {
  return (
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <=
    BOTTOM_THRESHOLD_PX
  );
}

/** Reads live scroll geometry off a container and applies the bottom-threshold rule. */
export function isNearBottom(container: HTMLDivElement): boolean {
  return isNearBottomMetrics({
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    scrollTop: container.scrollTop,
  });
}

/**
 * Identity of the last message in a snapshot, used to detect "a new latest
 * message arrived" for autoscroll. Prefers `renderKey` (stable across optimistic
 * send-ack) and falls back to `id`. Returns `undefined` for an empty snapshot.
 */
export function selectLatestMessageKey(
  messages: readonly TimelineMessage[],
): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  const latest = messages[messages.length - 1];
  return latest.renderKey ?? latest.id;
}

/** A single day boundary in the timeline: where it starts and how many messages it covers. */
export type DayGroupBoundary = {
  /** Stable key for the day section. */
  key: string;
  /** Index into `messages` of the first message in this day. */
  startIndex: number;
  /** Number of messages in this day group. */
  count: number;
  /** The `createdAt` (unix seconds) used to render the heading label. */
  headingTimestamp: number;
};

/**
 * Walks a snapshot in order and produces the day-group boundaries. A new group
 * starts at index 0 and whenever a message falls on a different calendar day
 * than the one before it.
 */
export function buildDayGroupBoundaries(
  messages: readonly TimelineMessage[],
): DayGroupBoundary[] {
  const boundaries: DayGroupBoundary[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;

    if (!prev || !isSameDay(prev.createdAt, message.createdAt)) {
      boundaries.push({
        key: `day-${message.createdAt}`,
        startIndex: i,
        count: 1,
        headingTimestamp: message.createdAt,
      });
    } else {
      boundaries[boundaries.length - 1].count += 1;
    }
  }

  return boundaries;
}

/** Outcome of resolving a deep-link target against the current snapshot. */
export type DeepLinkResolution = {
  /** Whether the target message exists in this snapshot (i.e. a row would be committed). */
  resolved: boolean;
  /** Index of the target in `messages`, or -1 when unresolved. */
  index: number;
};

/**
 * Does a jump-to-message target resolve against THIS snapshot? The scroll-manager
 * effect only does `querySelector` + `scrollIntoView` once a target row is
 * actually committed, so the jump must read the same snapshot the list rendered
 * — otherwise it scrolls to a row that isn't there yet.
 */
export function resolveDeepLinkTarget(
  messages: readonly TimelineMessage[],
  targetMessageId: string | null | undefined,
): DeepLinkResolution {
  if (!targetMessageId) {
    return { resolved: false, index: -1 };
  }
  const index = messages.findIndex((message) => message.id === targetMessageId);
  return { resolved: index !== -1, index };
}

/**
 * Which of three states a deferred list should paint. A list gated behind
 * `useDeferredValue` lags the live one for a frame, so the deferred snapshot can
 * be empty while the live list is not. Keying the empty state off the LIVE count
 * stops us flashing an "empty" affordance over a list that's streaming in:
 *
 *   - "list"    → the deferred snapshot has rows; paint them
 *   - "empty"   → the LIVE list is genuinely empty; paint the empty state
 *   - "pending" → deferred is empty but live has content; paint nothing yet
 */
export type DeferredListRenderState = "list" | "empty" | "pending";

export function selectDeferredListRenderState(
  deferredCount: number,
  liveCount: number,
): DeferredListRenderState {
  if (deferredCount > 0) {
    return "list";
  }
  if (liveCount === 0) {
    return "empty";
  }
  return "pending";
}

/**
 * One row in the flattened, virtualizer-ready timeline. Each item is the unit
 * the virtualizer measures and positions, so every divider that the legacy
 * `TimelineMessageList` rendered as a sibling node becomes its own item here.
 *
 *   - "day"     → a day-boundary heading; renders the inline `DayDivider`
 *   - "unread"  → the "New" read/unread boundary above the first unread message
 *   - "system"  → a system message (join/leave); renders `SystemMessageRow`
 *   - "message" → a normal message; carries the thread `summary` it renders
 *                 inline beneath the row (never a separate item — keeping the
 *                 summary on the message row preserves one measured unit per
 *                 message, which the virtualizer's height cache depends on)
 *
 * `key` is the React/virtualizer key and is byte-identical to the keys the
 * legacy list used, so deep-link `data-message-id` lookups and test selectors
 * keep resolving across the migration.
 */
export type TimelineVirtualItem =
  | { kind: "day"; key: string; headingTimestamp: number }
  | { kind: "unread"; key: string }
  | { kind: "system"; key: string; message: TimelineMessage }
  | {
      kind: "message";
      key: string;
      message: TimelineMessage;
      summary: TimelineThreadSummary | null;
    };

/**
 * Flattens the main-timeline entries into the ordered virtual-item list the
 * virtualizer consumes. Mirrors the legacy `TimelineMessageList` render walk
 * exactly: a day divider opens each new calendar-day group, an unread divider
 * precedes the first unread top-level message (suppressed at index 0), and each
 * entry becomes a `system` or `message` item. Pure over the snapshot so the
 * ordering and divider rules stay lib-tested without a DOM.
 */
export function buildTimelineVirtualItems(
  entries: readonly MainTimelineEntry[],
  firstUnreadMessageId: string | null = null,
): TimelineVirtualItem[] {
  const items: TimelineVirtualItem[] = [];
  const dayGroupStartIndices = new Set(
    buildDayGroupBoundaries(entries.map((entry) => entry.message)).map(
      (boundary) => boundary.startIndex,
    ),
  );

  for (let i = 0; i < entries.length; i++) {
    const { message, summary } = entries[i];
    const messageKey = message.renderKey ?? message.id;

    if (dayGroupStartIndices.has(i)) {
      items.push({
        kind: "day",
        key: `day-${message.createdAt}`,
        headingTimestamp: message.createdAt,
      });
    }

    if (shouldRenderUnreadDivider(i, message.id, firstUnreadMessageId)) {
      items.push({ kind: "unread", key: `unread-${messageKey}` });
    }

    if (message.kind === KIND_SYSTEM_MESSAGE) {
      items.push({ kind: "system", key: messageKey, message });
    } else {
      items.push({ kind: "message", key: messageKey, message, summary });
    }
  }

  return items;
}

/**
 * One row in the flattened, virtualizer-ready thread reply list. The thread
 * pane has a simpler shape than the main timeline — no day grouping, no system
 * rows, and the head message renders OUTSIDE the virtualized region — so the
 * only item kinds are an unread boundary and a reply (which carries the inline
 * thread `summary` it renders beneath the row, never a separate item, to keep
 * one measured unit per reply).
 *
 * `key` is byte-identical to the legacy reply-list keys
 * (`message.renderKey ?? message.id`) so optimistic-send identity stays stable
 * across the migration.
 */
export type ThreadReplyVirtualItem =
  | { kind: "unread"; key: string }
  | {
      kind: "reply";
      key: string;
      message: TimelineMessage;
      summary: TimelineThreadSummary | null;
    };

/**
 * Flattens thread reply entries into the ordered virtual-item list the thread
 * pane's virtualizer consumes. Mirrors the legacy reply-list render walk: an
 * unread divider precedes the first unread reply (suppressed at index 0, where
 * there is nothing above it to divide), and every entry becomes a `reply` item.
 * Pure over the snapshot so the divider rule stays lib-tested without a DOM.
 */
export function buildThreadReplyVirtualItems(
  entries: readonly MainTimelineEntry[],
  firstUnreadReplyId: string | null | undefined = null,
): ThreadReplyVirtualItem[] {
  const items: ThreadReplyVirtualItem[] = [];

  for (let i = 0; i < entries.length; i++) {
    const { message, summary } = entries[i];
    const replyKey = message.renderKey ?? message.id;

    if (shouldRenderUnreadDivider(i, message.id, firstUnreadReplyId ?? null)) {
      items.push({ kind: "unread", key: `unread-${replyKey}` });
    }

    items.push({ kind: "reply", key: replyKey, message, summary });
  }

  return items;
}
