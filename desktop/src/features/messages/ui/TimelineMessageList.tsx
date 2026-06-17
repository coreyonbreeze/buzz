import * as React from "react";

import { formatDayHeading } from "@/features/messages/lib/dateFormatters";
import type { TimelineVirtualItem } from "@/features/messages/lib/timelineSnapshot";
import {
  buildVideoReviewCommentsByRootId,
  buildVideoReviewContextForMessage,
} from "@/features/messages/lib/videoReviewContext";
import type { TimelineMessage } from "@/features/messages/types";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { ChannelType } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import type { ChatVirtualizer } from "./useChatScrollVirtualizer";
import { DayDivider } from "./DayDivider";
import { MessageRow } from "./MessageRow";
import { MessageThreadSummaryRow } from "./MessageThreadSummaryRow";
import { SystemMessageRow } from "./SystemMessageRow";
import { UnreadDivider } from "./UnreadDivider";

type TimelineMessageListProps = {
  agentPubkeys?: ReadonlySet<string>;
  channelId?: string | null;
  channelName?: string;
  channelType?: ChannelType | null;
  currentPubkey?: string;
  /** Event id of the oldest unread top-level message; renders a "New" divider above it. */
  firstUnreadMessageId?: string | null;
  followThreadById?: (rootId: string) => void;
  highlightedMessageId?: string | null;
  isFollowingThreadById?: (rootId: string) => boolean;
  messageFooters?: Record<string, React.ReactNode>;
  messages: TimelineMessage[];
  onDelete?: (message: TimelineMessage) => void;
  onEdit?: (message: TimelineMessage) => void;
  onMarkUnread?: (message: TimelineMessage) => void;
  onReply?: (message: TimelineMessage) => void;
  isSendingVideoReviewComment?: boolean;
  onSendVideoReviewComment?: (
    message: TimelineMessage,
    content: string,
    mentionPubkeys: string[],
    mediaTags?: string[][],
    parentEventId?: string,
  ) => Promise<void>;
  unfollowThreadById?: (rootId: string) => void;
  onToggleReaction?: (
    message: TimelineMessage,
    emoji: string,
    remove: boolean,
  ) => Promise<void>;
  /** Map from lowercase pubkey → persona display name for bot members. */
  personaLookup?: Map<string, string>;
  profiles?: UserProfileLookup;
  /** The message ID of the currently active find-in-channel match. */
  searchActiveMessageId?: string | null;
  /** Set of message IDs that match the current find-in-channel query. */
  searchMatchingMessageIds?: Set<string>;
  /** The current find-in-channel query string. */
  searchQuery?: string;
  /** Per-thread unread counts keyed by thread root id. */
  threadUnreadCounts?: ReadonlyMap<string, number>;
  /**
   * The virtualizer that owns this surface's scroll. Built by
   * `useChatScrollVirtualizer` at the timeline level so the single scroll owner
   * also owns measurement; this component is a pure renderer of its rows.
   */
  virtualizer: ChatVirtualizer;
  /** The flat virtual-item list the virtualizer's `count` mirrors. */
  items: TimelineVirtualItem[];
  /**
   * Top padding (px) that bottom-aligns a channel shorter than the viewport.
   * Always `0` once content fills the viewport. Applied to the row spacer so it
   * pushes the absolute rows down without entering the measured total.
   */
  topPad: number;
};

export const TimelineMessageList = React.memo(function TimelineMessageList({
  agentPubkeys,
  channelId,
  channelName,
  channelType,
  currentPubkey,
  followThreadById,
  highlightedMessageId = null,
  isFollowingThreadById,
  messageFooters,
  messages,
  onDelete,
  onEdit,
  onMarkUnread,
  onReply,
  isSendingVideoReviewComment = false,
  onSendVideoReviewComment,
  onToggleReaction,
  profiles,
  searchActiveMessageId = null,
  searchMatchingMessageIds,
  searchQuery,
  threadUnreadCounts,
  unfollowThreadById,
  virtualizer,
  items,
  topPad,
}: TimelineMessageListProps) {
  const reviewCommentsByRootId = React.useMemo(
    () => buildVideoReviewCommentsByRootId(messages),
    [messages],
  );
  // Contexts are memoized per message id so MessageRow/Markdown memo
  // comparisons hold across unrelated timeline re-renders (typing
  // indicators, presence updates) — a fresh context object per render would
  // defeat the memo and re-render every video message on every pass.
  const videoReviewContextById = React.useMemo(() => {
    const contexts = new Map<
      string,
      NonNullable<ReturnType<typeof buildVideoReviewContextForMessage>>
    >();
    for (const message of messages) {
      const comments = reviewCommentsByRootId.get(message.id) ?? [];
      const context = buildVideoReviewContextForMessage({
        channelId,
        channelName,
        channelType,
        comments,
        isSendingVideoReviewComment,
        message,
        onSendVideoReviewComment,
        onToggleReaction,
        profiles,
      });
      if (context) {
        contexts.set(message.id, context);
      }
    }
    return contexts;
  }, [
    channelId,
    channelName,
    channelType,
    isSendingVideoReviewComment,
    messages,
    onSendVideoReviewComment,
    onToggleReaction,
    profiles,
    reviewCommentsByRootId,
  ]);

  const renderItem = (item: TimelineVirtualItem): React.ReactNode => {
    switch (item.kind) {
      case "day":
        // The day separator scrolls inline with the rows (it is a normal
        // virtual item, not sticky — sticky cannot work on an absolute row).
        // The thin connector line that the legacy day-`<section>` drew behind
        // the centered pill is re-homed onto this row so the divider keeps its
        // rule-behind-label look without the group wrapper.
        return (
          <div className="relative before:absolute before:inset-x-0 before:top-[15px] before:h-px before:bg-border/35 before:content-['']">
            <DayDivider label={formatDayHeading(item.headingTimestamp)} />
          </div>
        );
      case "unread":
        return <UnreadDivider />;
      case "system": {
        const footer = messageFooters?.[item.message.id] ?? null;
        return (
          <div className="flex flex-col gap-1">
            <SystemMessageRow
              message={item.message}
              currentPubkey={currentPubkey}
              onToggleReaction={onToggleReaction}
              profiles={profiles}
            />
            {footer}
          </div>
        );
      }
      case "message": {
        const { message, summary } = item;
        const footer = messageFooters?.[message.id] ?? null;

        if (summary && onReply) {
          const isHighlighted = message.id === highlightedMessageId;
          return (
            <div
              className={cn(
                "group/message relative mx-1 flex flex-col gap-0 rounded-2xl px-0 py-1 transition-colors hover:bg-muted/50 focus-within:bg-muted/50",
                isHighlighted &&
                  "-mx-4 px-4 before:absolute before:-inset-y-1.5 before:inset-x-0 before:animate-[route-target-highlight-fade_2s_ease-out_forwards] before:bg-primary/10 before:content-[''] motion-reduce:before:animate-none sm:-mx-6 sm:px-6",
              )}
            >
              <MessageRow
                agentPubkeys={agentPubkeys}
                channelId={channelId}
                highlighted={false}
                hoverBackground={false}
                isFollowingThread={
                  isFollowingThreadById
                    ? isFollowingThreadById(message.id)
                    : undefined
                }
                message={message}
                onDelete={
                  onDelete && currentPubkey && message.pubkey === currentPubkey
                    ? onDelete
                    : undefined
                }
                onEdit={
                  onEdit && currentPubkey && message.pubkey === currentPubkey
                    ? onEdit
                    : undefined
                }
                onFollowThread={
                  followThreadById
                    ? () => followThreadById(message.id)
                    : undefined
                }
                onMarkUnread={onMarkUnread}
                onToggleReaction={onToggleReaction}
                onReply={onReply}
                onUnfollowThread={
                  unfollowThreadById
                    ? () => unfollowThreadById(message.id)
                    : undefined
                }
                profiles={profiles}
                showDepthGuides={false}
                videoReviewContext={videoReviewContextById.get(message.id)}
              />
              <MessageThreadSummaryRow
                depth={message.depth}
                message={message}
                onOpenThread={onReply}
                showDepthGuides={false}
                summary={summary}
                unreadCount={threadUnreadCounts?.get(message.id)}
              />
              {footer}
            </div>
          );
        }

        const isSearchMatch =
          searchMatchingMessageIds?.has(message.id) ?? false;
        const isSearchActive = message.id === searchActiveMessageId;
        return (
          <div className="flex flex-col gap-1">
            <MessageRow
              agentPubkeys={agentPubkeys}
              channelId={channelId}
              highlighted={
                message.id === highlightedMessageId || isSearchActive
              }
              message={message}
              onDelete={
                onDelete && currentPubkey && message.pubkey === currentPubkey
                  ? onDelete
                  : undefined
              }
              onEdit={
                onEdit && currentPubkey && message.pubkey === currentPubkey
                  ? onEdit
                  : undefined
              }
              onMarkUnread={onMarkUnread}
              onToggleReaction={onToggleReaction}
              onReply={onReply}
              profiles={profiles}
              searchQuery={isSearchMatch ? searchQuery : undefined}
              showDepthGuides={false}
              videoReviewContext={videoReviewContextById.get(message.id)}
            />
            {footer}
          </div>
        );
      }
    }
  };

  // The spacer is `box-sizing: border-box` (Tailwind global), so `topPad` is
  // folded into `height` AND set as `paddingTop`: the height keeps the full
  // scroll range while the padding pushes the absolute rows (positioned against
  // the padding box, `top:0` = inner edge) down to bottom-align a short channel.
  // `translateY` then uses the virtualizer's raw `start` — no double offset.
  return (
    <div
      className="relative w-full"
      style={{
        height: `${virtualizer.getTotalSize() + topPad}px`,
        paddingTop: topPad > 0 ? `${topPad}px` : undefined,
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => (
        <div
          data-index={virtualRow.index}
          key={virtualRow.key}
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${virtualRow.start}px)`,
          }}
        >
          {renderItem(items[virtualRow.index])}
        </div>
      ))}
    </div>
  );
});
