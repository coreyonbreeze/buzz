import * as React from "react";
import { ArrowDown, ArrowLeft, X } from "lucide-react";

import type { MainTimelineEntry } from "@/features/messages/lib/threadPanel";
import type { ImetaMedia } from "@/features/messages/lib/imetaMediaMarkdown";
import type { TimelineMessage } from "@/features/messages/types";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { Channel } from "@/shared/api/types";
import { useEscapeKey } from "@/shared/hooks/useEscapeKey";
import { useIsThreadPanelOverlay } from "@/shared/hooks/use-mobile";
import { THREAD_PANEL_MIN_WIDTH_PX } from "@/shared/hooks/useThreadPanelWidth";
import { cn } from "@/shared/lib/cn";
import {
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderGroup,
  AuxiliaryPanelTitle,
  auxiliaryPanelContentPaddingClass,
} from "@/shared/layout/AuxiliaryPanelHeader";
import { Button } from "@/shared/ui/button";
import {
  OverlayPanelBackdrop,
  PANEL_BASE_CLASS,
  PANEL_OVERLAY_CLASS,
  PANEL_SINGLE_COLUMN_HEADER_LAYER_CLASS,
} from "@/shared/ui/OverlayPanelBackdrop";
import { Skeleton } from "@/shared/ui/skeleton";
import type { VideoReviewContext } from "@/shared/ui/VideoPlayer";
import { MessageComposer } from "./MessageComposer";
import { MessageRow } from "./MessageRow";
import { MessageThreadSummaryRow } from "./MessageThreadSummaryRow";
import { TypingIndicatorRow } from "./TypingIndicatorRow";
import { UnreadDivider } from "./UnreadDivider";
import { useComposerHeightPadding } from "./useComposerHeightPadding";
import { useChatScrollVirtualizer } from "./useChatScrollVirtualizer";
import {
  buildThreadReplyVirtualItems,
  selectDeferredListRenderState,
  selectLatestMessageKey,
} from "@/features/messages/lib/timelineSnapshot";

type MessageThreadPanelProps = {
  agentPubkeys?: ReadonlySet<string>;
  channel: Channel | null;
  channelId: string | null;
  channelName: string;
  currentPubkey?: string;
  disabled?: boolean;
  /** Event id of the first unread reply, or null/undefined if all read. */
  firstUnreadReplyId?: string | null;
  layout?: "standalone" | "split";
  editTarget?: {
    author: string;
    body: string;
    id: string;
    imetaMedia?: ImetaMedia[];
  } | null;
  isSending: boolean;
  isSinglePanelView?: boolean;
  onCancelEdit?: () => void;
  onCancelReply: () => void;
  onClose: () => void;
  onDelete?: (message: TimelineMessage) => void;
  onEdit?: (message: TimelineMessage) => void;
  onEditLastOwnMessage?: () => boolean;
  onEditSave?: (content: string, mediaTags?: string[][]) => Promise<void>;
  onMarkUnread?: (message: TimelineMessage) => void;
  onExpandReplies: (message: TimelineMessage) => void;
  onScrollTargetResolved: () => void;
  onSelectReplyTarget: (message: TimelineMessage) => void;
  onSend: (
    content: string,
    mentionPubkeys: string[],
    mediaTags?: string[][],
  ) => Promise<void>;
  onToggleReaction?: (
    message: TimelineMessage,
    emoji: string,
    remove: boolean,
  ) => Promise<void>;
  profiles?: UserProfileLookup;
  replyTargetMessage: TimelineMessage | null;
  scrollTargetId: string | null;
  threadHead: TimelineMessage | null;
  threadReplies: MainTimelineEntry[];
  /** Subtree unread counts for collapsed summary rows, keyed by reply id. */
  threadReplyUnreadCounts?: ReadonlyMap<string, number>;
  threadTypingPubkeys: string[];
  threadHeadVideoReviewContext?: VideoReviewContext;
  toolbarExtraActions?: React.ReactNode;
  widthPx: number;
  isFollowingThread?: boolean;
  onFollowThread?: () => void;
  onUnfollowThread?: () => void;
};

/** Stable empty reference used as the `useDeferredValue` initial value so the
 *  first render when a thread opens stays light instead of blocking on the full
 *  reply list. Must be module-level so its identity never changes. Mirrors
 *  `EMPTY_MESSAGES` in MessageTimeline. */
const EMPTY_THREAD_REPLIES: MainTimelineEntry[] = [];

/** Vertical gap (px) the virtualizer inserts between reply rows — the spacing
 *  the legacy reply list expressed as `space-y-2.5`. */
const THREAD_REPLY_GAP_PX = 10;

type MessageThreadPanelSkeletonProps = {
  isSinglePanelView?: boolean;
  layout?: "standalone" | "split";
  onClose: () => void;
  widthPx: number;
};

function canManageMessage(
  message: TimelineMessage,
  currentPubkey: string | undefined,
): boolean {
  return Boolean(
    currentPubkey &&
      message.pubkey &&
      currentPubkey.toLowerCase() === message.pubkey.toLowerCase(),
  );
}

function ThreadMessageSkeleton({ isHead = false }: { isHead?: boolean }) {
  return (
    <article className="relative flex items-start gap-2.5 rounded-2xl px-3 py-2">
      <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
      <div className="-mt-1 min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0">
          <Skeleton className="h-[15px] w-28" />
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="mt-1 space-y-1.5 pb-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className={isHead ? "h-4 w-4/5" : "h-4 w-2/3"} />
        </div>
        <div className="flex items-center gap-4">
          <Skeleton className="h-4 w-8 rounded-full" />
          <Skeleton className="h-4 w-8 rounded-full" />
          <Skeleton className="h-4 w-8 rounded-full" />
        </div>
      </div>
    </article>
  );
}

function ThreadComposerSkeleton() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
      <div className="pointer-events-auto">
        <div className="relative z-10 shrink-0 bg-transparent px-4 pb-2 pt-0">
          <div className="relative isolate rounded-2xl border border-border/50 bg-background/80 px-3 pb-2 pt-3 shadow-none backdrop-blur-md sm:px-4">
            <Skeleton className="h-5 w-48 max-w-full" />
            <div className="mt-4 flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="ml-auto h-8 w-20 rounded-full" />
            </div>
          </div>
        </div>
        <div className="-mt-1 h-7 bg-background px-4 pb-1 pt-0 sm:px-6" />
      </div>
    </div>
  );
}

export function MessageThreadPanelSkeleton({
  isSinglePanelView = false,
  layout = "standalone",
  onClose,
  widthPx,
}: MessageThreadPanelSkeletonProps) {
  const isOverlay = useIsThreadPanelOverlay();
  const isFloatingOverlay = isOverlay && !isSinglePanelView;
  const isSplitLayout = layout === "split";
  useEscapeKey(onClose, isOverlay || isSinglePanelView);

  const threadHeaderContent = (
    <>
      <AuxiliaryPanelHeaderGroup>
        {isSinglePanelView ? (
          <Button
            aria-label="Back to conversation"
            className="shrink-0"
            onClick={onClose}
            size="icon"
            type="button"
            variant="outline"
          >
            <ArrowLeft />
          </Button>
        ) : null}
        <AuxiliaryPanelTitle>Thread</AuxiliaryPanelTitle>
      </AuxiliaryPanelHeaderGroup>
      <Button
        aria-label="Close thread"
        className="ml-auto"
        onClick={onClose}
        size="icon"
        type="button"
        variant="ghost"
      >
        <X />
      </Button>
    </>
  );

  const threadBody = (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-24 [overflow-anchor:none]",
        isSplitLayout && auxiliaryPanelContentPaddingClass,
        !isSplitLayout && !isFloatingOverlay && "pt-[4.75rem]",
      )}
      data-testid="message-thread-loading"
    >
      <div className="px-3 pb-1 pt-0" data-testid="message-thread-head-loading">
        <ThreadMessageSkeleton isHead />
      </div>
      <div className="space-y-2.5 px-3 pb-3 pt-1">
        <ThreadMessageSkeleton />
        <ThreadMessageSkeleton />
        <div className="ml-[58px] flex items-center gap-1.5 pt-0.5">
          <Skeleton className="h-7 w-7 rounded-full" />
          <Skeleton className="h-7 w-7 rounded-full" />
          <Skeleton className="h-4 w-28 rounded-full" />
        </div>
      </div>
    </div>
  );

  if (isSplitLayout) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AuxiliaryPanelHeader>{threadHeaderContent}</AuxiliaryPanelHeader>
        {threadBody}
        <ThreadComposerSkeleton />
      </div>
    );
  }

  return (
    <>
      {isFloatingOverlay && <OverlayPanelBackdrop onClose={onClose} />}
      <aside
        className={cn(
          PANEL_BASE_CLASS,
          isSinglePanelView && "border-l-0",
          isFloatingOverlay && PANEL_OVERLAY_CLASS,
        )}
        data-testid="message-thread-panel"
        style={{
          width: isSinglePanelView
            ? "100%"
            : `min(${widthPx}px, calc(100% - ${THREAD_PANEL_MIN_WIDTH_PX}px))`,
        }}
      >
        <div
          className={cn(
            "flex cursor-default select-none items-center",
            isSinglePanelView
              ? `relative ${PANEL_SINGLE_COLUMN_HEADER_LAYER_CLASS} -mb-[4.75rem] min-h-[4.75rem] shrink-0 gap-2.5 bg-background/80 pb-[0.1875rem] pl-4 pr-2 pt-[2.6875rem] backdrop-blur-md supports-[backdrop-filter]:bg-background/70 sm:pr-3 dark:bg-background/70 dark:backdrop-blur-xl dark:supports-[backdrop-filter]:bg-background/55`
              : "relative z-50 min-h-11 shrink-0 gap-3 bg-background/80 px-3 py-1.5 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 dark:bg-background/70 dark:backdrop-blur-xl dark:supports-[backdrop-filter]:bg-background/55",
          )}
          data-tauri-drag-region
        >
          {threadHeaderContent}
        </div>

        {threadBody}
        <ThreadComposerSkeleton />
      </aside>
    </>
  );
}

export function MessageThreadPanel({
  agentPubkeys,
  channel,
  channelId,
  channelName,
  currentPubkey,
  disabled = false,
  firstUnreadReplyId,
  layout = "standalone",
  editTarget,
  isSending,
  isSinglePanelView = false,
  isFollowingThread,
  onCancelEdit,
  onCancelReply,
  onClose,
  onDelete,
  onEdit,
  onEditLastOwnMessage,
  onEditSave,
  onFollowThread,
  onMarkUnread,
  onExpandReplies,
  onScrollTargetResolved,
  onSelectReplyTarget,
  onSend,
  onToggleReaction,
  onUnfollowThread,
  profiles,
  replyTargetMessage,
  scrollTargetId,
  threadHead,
  threadHeadVideoReviewContext,
  threadReplies,
  threadReplyUnreadCounts,
  threadTypingPubkeys,
  toolbarExtraActions,
  widthPx,
}: MessageThreadPanelProps) {
  const threadBodyRef = React.useRef<HTMLDivElement>(null);
  const threadComposerWrapperRef = React.useRef<HTMLDivElement>(null);
  const isOverlay = useIsThreadPanelOverlay();
  const isFloatingOverlay = isOverlay && !isSinglePanelView;
  const isSplitLayout = layout === "split";
  useEscapeKey(onClose, isOverlay || isSinglePanelView);
  useComposerHeightPadding(
    threadBodyRef,
    threadComposerWrapperRef,
    isSinglePanelView,
  );

  const composerReplyTarget =
    replyTargetMessage && threadHead && replyTargetMessage.id !== threadHead.id
      ? {
          author: replyTargetMessage.author,
          body: replyTargetMessage.body,
          id: replyTargetMessage.id,
        }
      : null;

  // The thread side pane renders its reply list straight into heavy
  // `react-markdown` rows (`MessageRow`), so opening a deep thread would block
  // the main thread and the OS would show the busy cursor. Gate the reply render
  // behind `useDeferredValue`. `initialValue: []` keeps even the FIRST render on
  // thread-open light; the heavy list streams in on a deferred, interruptible
  // commit. We deliberately drive BOTH the virtualizer and the rendered list
  // off the SAME deferred value — the deep-link index resolves against this
  // snapshot, so a jump never targets a reply the DOM has not committed yet
  // (the no-tearing guard). You can't scroll to a reply that hasn't rendered.
  const deferredThreadReplies = React.useDeferredValue(
    threadReplies,
    EMPTY_THREAD_REPLIES,
  );
  const isRepliesPending = deferredThreadReplies !== threadReplies;

  // Which of the three states the reply region paints this frame. Delegated to
  // a pure helper so the "don't flash empty over an incoming list" rule is
  // covered in the lib test suite (see selectDeferredListRenderState).
  const repliesRenderState = selectDeferredListRenderState(
    deferredThreadReplies.length,
    threadReplies.length,
  );

  // Flat virtual-item list for the reply region (head renders outside it). The
  // deep-link index map below is built off this SAME list — the no-tearing
  // guard — so a `scrollTargetId` jump only fires once the target reply exists
  // in the committed snapshot.
  const replyItems = React.useMemo(
    () =>
      buildThreadReplyVirtualItems(deferredThreadReplies, firstUnreadReplyId),
    [deferredThreadReplies, firstUnreadReplyId],
  );
  const indexByMessageId = React.useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < replyItems.length; i++) {
      const item = replyItems[i];
      if (item.kind === "reply") {
        map.set(item.message.id, i);
      }
    }
    return map;
  }, [replyItems]);
  const latestReplyKey = React.useMemo(
    () => selectLatestMessageKey(deferredThreadReplies.map((e) => e.message)),
    [deferredThreadReplies],
  );
  const getReplyItemKey = React.useCallback(
    (index: number) => replyItems[index].key,
    [replyItems],
  );

  // Bottom-stick + deep-link only — a thread never grows at the head, so
  // `anchorTo:"end"` makes prepend structurally absent (no flag needed). No
  // short-channel `topPad`: replies render top-down under the head row, which
  // is the legacy thread-pane layout.
  const {
    virtualizer,
    isAtBottom,
    newMessageCount,
    highlightedMessageId,
    scrollToBottom,
    scrollToItem,
  } = useChatScrollVirtualizer({
    count: replyItems.length,
    scrollRef: threadBodyRef,
    getItemKey: getReplyItemKey,
    gap: THREAD_REPLY_GAP_PX,
    latestMessageKey: latestReplyKey,
    onTargetReached: onScrollTargetResolved,
  });

  // Deep-link to `scrollTargetId` once it resolves against the rendered
  // snapshot. The library's reconcile loop settles the offset once the target
  // reply measures — the same W1 deep-link settle the main timeline uses, with
  // prepend off.
  const lastJumpedTargetRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!scrollTargetId) {
      lastJumpedTargetRef.current = null;
      return;
    }
    if (scrollTargetId === lastJumpedTargetRef.current) {
      return;
    }
    const index = indexByMessageId.get(scrollTargetId);
    if (index === undefined) {
      return;
    }
    lastJumpedTargetRef.current = scrollTargetId;
    scrollToItem(index, scrollTargetId);
  }, [scrollTargetId, indexByMessageId, scrollToItem]);

  if (!threadHead) {
    return null;
  }

  const renderReplyItem = (
    item: (typeof replyItems)[number],
  ): React.ReactNode => {
    if (item.kind === "unread") {
      return <UnreadDivider />;
    }
    const { message, summary } = item;
    return (
      <div
        className={cn(
          "flex flex-col gap-1",
          summary &&
            "group/message mx-1 rounded-2xl px-0 py-1 transition-colors hover:bg-muted/50 focus-within:bg-muted/50",
          message.id === highlightedMessageId &&
            "before:absolute before:-inset-y-1 before:inset-x-0 before:animate-[route-target-highlight-fade_2s_ease-out_forwards] before:bg-primary/10 before:content-[''] motion-reduce:before:animate-none",
        )}
      >
        <MessageRow
          agentPubkeys={agentPubkeys}
          channelId={channelId}
          hoverBackground={!summary}
          layoutVariant="thread-reply"
          message={message}
          onDelete={
            onDelete && canManageMessage(message, currentPubkey)
              ? onDelete
              : undefined
          }
          onEdit={
            onEdit && canManageMessage(message, currentPubkey)
              ? onEdit
              : undefined
          }
          onMarkUnread={onMarkUnread}
          onReply={onSelectReplyTarget}
          onToggleReaction={onToggleReaction}
          profiles={profiles}
        />
        {summary ? (
          <MessageThreadSummaryRow
            depth={message.depth}
            message={message}
            onOpenThread={onExpandReplies}
            summary={summary}
            unreadCount={threadReplyUnreadCounts?.get(message.id)}
          />
        ) : null}
      </div>
    );
  };

  const threadScrollRegion = (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain pb-24 [overflow-anchor:none]",
        isSplitLayout && auxiliaryPanelContentPaddingClass,
        !isSplitLayout && !isFloatingOverlay && "pt-[4.75rem]",
      )}
      data-testid="message-thread-body"
      ref={threadBodyRef}
    >
      <div className="px-3 pb-1 pt-0" data-testid="message-thread-head">
        <div className="rounded-2xl">
          <MessageRow
            actionBarPlacement="inside"
            agentPubkeys={agentPubkeys}
            channelId={channelId}
            isFollowingThread={isFollowingThread}
            layoutVariant="thread-reply"
            message={threadHead}
            onDelete={
              onDelete && canManageMessage(threadHead, currentPubkey)
                ? onDelete
                : undefined
            }
            onEdit={
              onEdit && canManageMessage(threadHead, currentPubkey)
                ? onEdit
                : undefined
            }
            onFollowThread={
              onFollowThread ? (_msg) => onFollowThread() : undefined
            }
            onMarkUnread={onMarkUnread}
            onToggleReaction={onToggleReaction}
            onUnfollowThread={
              onUnfollowThread ? (_msg) => onUnfollowThread() : undefined
            }
            profiles={profiles}
            videoReviewContext={threadHeadVideoReviewContext}
          />
        </div>
      </div>

      <div className="px-3 pb-3 pt-1" data-testid="message-thread-replies">
        {repliesRenderState === "list" ? (
          <div
            className={cn(
              "relative w-full",
              // While a deferred render is in flight the painted reply list
              // lags the latest `threadReplies`. Dim it slightly so the
              // streaming-in reads as intentional instead of frozen — mirrors
              // the main timeline.
              isRepliesPending && "opacity-60 transition-opacity",
            )}
            data-render-pending={isRepliesPending ? "true" : undefined}
            style={{ height: `${virtualizer.getTotalSize()}px` }}
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
                {renderReplyItem(replyItems[virtualRow.index])}
              </div>
            ))}
          </div>
        ) : repliesRenderState === "empty" ? (
          // Only show the empty state when the thread is GENUINELY empty.
          // Keying off `deferredThreadReplies` would flash "No replies" for a
          // frame while a non-empty list streams in on the deferred commit.
          <div className="rounded-2xl border border-dashed border-border/70 bg-card/40 px-4 py-6 text-center">
            <p className="text-sm font-medium text-foreground/80">
              No replies in this branch yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Reply in the thread to continue this branch.
            </p>
          </div>
        ) : // "pending": deferred list is empty but the live list has content —
        // rows are streaming in on the deferred commit. Paint nothing rather
        // than flashing the empty state.
        null}
      </div>
    </div>
  );

  const threadFooter = (
    <>
      {!isAtBottom ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-36 z-20 flex justify-center px-4">
          <Button
            className="pointer-events-auto h-7 min-h-7 gap-1.5 rounded-full border-border/50 bg-background/85 px-2.5 text-2xs font-medium text-muted-foreground shadow-xs backdrop-blur-sm hover:bg-muted/70 hover:text-foreground [&_svg]:size-4"
            data-testid="thread-scroll-to-latest"
            onClick={() => scrollToBottom("smooth")}
            size="sm"
            type="button"
            variant="outline"
          >
            <ArrowDown aria-hidden />
            {newMessageCount > 0
              ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
              : "Jump to latest"}
          </Button>
        </div>
      ) : null}

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
        ref={threadComposerWrapperRef}
      >
        <div className="pointer-events-auto">
          <MessageComposer
            channelId={channelId}
            channelName={channelName}
            channelType={channel?.channelType ?? null}
            disabled={disabled || isSending || !channelId}
            draftKey={`thread:${threadHead.id}`}
            editTarget={editTarget}
            isSending={isSending}
            onCancelEdit={onCancelEdit}
            onCancelReply={composerReplyTarget ? onCancelReply : undefined}
            onEditLastOwnMessage={onEditLastOwnMessage}
            onEditSave={onEditSave}
            onSend={onSend}
            placeholder={`Reply in thread to ${threadHead.author}`}
            profiles={profiles}
            replyTarget={composerReplyTarget}
            typingParentEventId={threadHead.id}
            typingRootEventId={threadHead.rootId}
          />
          <div className="h-7 bg-background px-4 pb-1 pt-0 sm:px-6 -mt-1">
            <div className="mx-auto flex h-full w-full max-w-4xl items-center gap-2">
              {toolbarExtraActions ? (
                <div className="shrink-0">{toolbarExtraActions}</div>
              ) : null}
              {threadTypingPubkeys.length > 0 ? (
                <TypingIndicatorRow
                  channel={channel}
                  className="min-w-0 flex-1 px-0 py-0"
                  currentPubkey={currentPubkey}
                  profiles={profiles}
                  typingPubkeys={threadTypingPubkeys}
                  variant="activity"
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );

  const threadHeaderContent = (
    <>
      <AuxiliaryPanelHeaderGroup>
        {isSinglePanelView ? (
          <Button
            aria-label="Back to conversation"
            className="shrink-0"
            data-testid="message-thread-back"
            onClick={onClose}
            size="icon"
            type="button"
            variant="outline"
          >
            <ArrowLeft />
          </Button>
        ) : null}
        <AuxiliaryPanelTitle>Thread</AuxiliaryPanelTitle>
      </AuxiliaryPanelHeaderGroup>
      <Button
        aria-label="Close thread"
        className="ml-auto"
        data-testid="message-thread-close"
        onClick={onClose}
        size="icon"
        type="button"
        variant="ghost"
      >
        <X />
      </Button>
    </>
  );

  if (isSplitLayout) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AuxiliaryPanelHeader>{threadHeaderContent}</AuxiliaryPanelHeader>
        {threadScrollRegion}
        {threadFooter}
      </div>
    );
  }

  return (
    <>
      {isFloatingOverlay && <OverlayPanelBackdrop onClose={onClose} />}
      <aside
        className={cn(
          PANEL_BASE_CLASS,
          isSinglePanelView && "border-l-0",
          isFloatingOverlay && PANEL_OVERLAY_CLASS,
        )}
        data-testid="message-thread-panel"
        style={{
          width: isSinglePanelView
            ? "100%"
            : `min(${widthPx}px, calc(100% - ${THREAD_PANEL_MIN_WIDTH_PX}px))`,
        }}
      >
        <div
          className={cn(
            "flex cursor-default select-none items-center",
            isSinglePanelView
              ? `relative ${PANEL_SINGLE_COLUMN_HEADER_LAYER_CLASS} -mb-[4.75rem] min-h-[4.75rem] shrink-0 gap-2.5 bg-background/80 pb-[0.1875rem] pl-4 pr-2 pt-[2.6875rem] backdrop-blur-md supports-[backdrop-filter]:bg-background/70 sm:pr-3 dark:bg-background/70 dark:backdrop-blur-xl dark:supports-[backdrop-filter]:bg-background/55`
              : "relative z-50 min-h-11 shrink-0 gap-3 bg-background/80 px-3 py-1.5 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 dark:bg-background/70 dark:backdrop-blur-xl dark:supports-[backdrop-filter]:bg-background/55",
          )}
          data-tauri-drag-region
        >
          {threadHeaderContent}
        </div>

        {threadScrollRegion}
        {threadFooter}
      </aside>
    </>
  );
}
