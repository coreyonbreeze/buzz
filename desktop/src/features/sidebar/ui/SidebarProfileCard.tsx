import * as React from "react";

import { getPresenceLabel } from "@/features/presence/lib/presence";
import { PresenceDot } from "@/features/presence/ui/PresenceBadge";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { ProfilePopover } from "@/features/profile/ui/ProfilePopover";
import type { Workspace } from "@/features/workspaces/types";
import { WorkspaceSwitcher } from "@/features/workspaces/ui/WorkspaceSwitcher";
import type { PresenceStatus, Profile, UserStatus } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";

type SidebarProfileCardProps = {
  activeWorkspace: Workspace | null;
  isPresencePending?: boolean;
  onClearUserStatus: () => void;
  onOpenAddWorkspace: () => void;
  onOpenSettings: (section?: "profile" | "appearance") => void;
  onRemoveWorkspace: (id: string) => void;
  onSetPresenceStatus?: (status: PresenceStatus) => void;
  onSetUserStatus: (text: string, emoji: string) => void;
  onSwitchWorkspace: (id: string) => void;
  onUpdateWorkspace: (
    id: string,
    updates: Partial<Pick<Workspace, "name" | "relayUrl" | "token">>,
  ) => void;
  profile?: Profile;
  resolvedDisplayName: string;
  selfPresenceStatus: PresenceStatus;
  selfUserStatus?: UserStatus;
  workspaces: Workspace[];
};

export function SidebarProfileCard({
  activeWorkspace,
  isPresencePending,
  onClearUserStatus,
  onOpenAddWorkspace,
  onOpenSettings,
  onRemoveWorkspace,
  onSetPresenceStatus,
  onSetUserStatus,
  onSwitchWorkspace,
  onUpdateWorkspace,
  profile,
  resolvedDisplayName,
  selfPresenceStatus,
  selfUserStatus,
  workspaces,
}: SidebarProfileCardProps) {
  const [profilePopoverOpen, setProfilePopoverOpen] = React.useState(false);
  const profileCardRef = React.useRef<HTMLDivElement | null>(null);
  const toggleProfilePopover = React.useCallback(
    () => setProfilePopoverOpen((prev) => !prev),
    [],
  );
  const hasStatus = Boolean(selfUserStatus?.text || selfUserStatus?.emoji);
  const workspaceLabel = activeWorkspace?.name ?? "No workspace";
  const readonlyWorkspaceLabel = (
    <span className="flex min-w-0 items-center gap-1 text-xs leading-snug text-sidebar-foreground/70">
      <span aria-hidden="true" className="shrink-0 text-[10px] leading-none">
        🌱
      </span>
      <span className="truncate">{workspaceLabel}</span>
    </span>
  );

  return (
    <div
      className="group/profile-card rounded-xl px-2 py-2 transition-colors hover:bg-sidebar-border/35 dark:hover:bg-sidebar-border/30"
      data-testid="sidebar-profile-card"
      ref={profileCardRef}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          aria-label={`Open profile menu for ${resolvedDisplayName}`}
          className="relative shrink-0 rounded-xl outline-hidden focus:outline-none focus-visible:outline-none"
          data-testid="sidebar-profile-avatar-button"
          onClick={toggleProfilePopover}
          type="button"
        >
          <ProfileAvatar
            avatarUrl={profile?.avatarUrl ?? null}
            className="h-8 w-8 rounded-xl text-xs"
            iconClassName="h-4 w-4"
            label={resolvedDisplayName}
            testId="sidebar-profile-avatar"
          />
          <span
            aria-label={getPresenceLabel(selfPresenceStatus)}
            className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sidebar"
            data-testid="self-presence-badge"
            role="img"
          >
            <PresenceDot className="h-2 w-2" status={selfPresenceStatus} />
          </span>
        </button>

        <div className="min-w-0 flex-1">
          <ProfilePopover
            open={profilePopoverOpen}
            onOpenChange={setProfilePopoverOpen}
            displayName={resolvedDisplayName}
            avatarUrl={profile?.avatarUrl ?? null}
            currentStatus={selfPresenceStatus}
            isStatusPending={isPresencePending}
            userStatusText={selfUserStatus?.text}
            userStatusEmoji={selfUserStatus?.emoji}
            onSetStatus={onSetPresenceStatus ?? (() => {})}
            onSetUserStatus={onSetUserStatus}
            onClearUserStatus={onClearUserStatus}
            onOpenSettings={onOpenSettings}
            triggerContainerRef={profileCardRef}
            workspaceSwitcherSlot={
              <WorkspaceSwitcher
                activeWorkspace={activeWorkspace}
                onAddWorkspace={onOpenAddWorkspace}
                onRemoveWorkspace={onRemoveWorkspace}
                onSwitchWorkspace={onSwitchWorkspace}
                onUpdateWorkspace={onUpdateWorkspace}
                variant="profile-menu"
                workspaces={workspaces}
              />
            }
          >
            <button
              className="block w-full min-w-0 rounded-sm text-left text-sidebar-foreground outline-hidden focus:outline-none focus-visible:outline-none"
              data-testid="open-settings"
              type="button"
            >
              <p
                className="truncate text-sm font-semibold leading-tight text-current"
                data-testid="sidebar-profile-name"
              >
                {resolvedDisplayName}
              </p>
            </button>
          </ProfilePopover>

          {hasStatus ? (
            <div className="relative mt-0.5">
              <button
                aria-label={`Open profile menu for ${resolvedDisplayName}`}
                className={cn(
                  "flex w-full min-w-0 items-center truncate rounded-sm text-left text-xs leading-snug text-sidebar-foreground/70 outline-hidden transition-opacity duration-150 focus:outline-none focus-visible:outline-none group-hover/profile-card:opacity-0",
                  profilePopoverOpen && "opacity-100",
                )}
                data-testid="sidebar-profile-user-status"
                onClick={toggleProfilePopover}
                type="button"
              >
                {selfUserStatus?.emoji ? (
                  <span className="mr-1">{selfUserStatus.emoji}</span>
                ) : null}
                <span className="truncate">{selfUserStatus?.text}</span>
              </button>
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 flex min-w-0 items-center text-xs leading-snug text-sidebar-foreground/70 opacity-0 transition-opacity duration-150 group-hover/profile-card:opacity-100",
                  profilePopoverOpen && "opacity-0",
                )}
              >
                {readonlyWorkspaceLabel}
              </div>
            </div>
          ) : (
            <div className="relative mt-0.5">{readonlyWorkspaceLabel}</div>
          )}
        </div>
      </div>
    </div>
  );
}
