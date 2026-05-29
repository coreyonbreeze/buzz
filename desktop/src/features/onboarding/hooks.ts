import * as React from "react";
import { useQueryClient, type QueryStatus } from "@tanstack/react-query";

import { channelsQueryKey } from "@/features/channels/hooks";
import { useProfileQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { getChannels, joinChannel } from "@/shared/api/tauri";

const DEFAULT_AUTO_JOIN_CHANNEL_NAME = "general";

async function autoJoinDefaultChannel(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  try {
    const channels = await getChannels();
    const target = channels.find(
      (channel) =>
        channel.name === DEFAULT_AUTO_JOIN_CHANNEL_NAME && !channel.isMember,
    );
    if (!target) {
      return;
    }
    await joinChannel(target.id);
    await queryClient.invalidateQueries({ queryKey: channelsQueryKey });
  } catch {
    // Silent — auto-join is best-effort; the user can still find and join
    // the channel manually from the channel browser.
  }
}

const ONBOARDING_COMPLETION_STORAGE_KEY = "sprout-onboarding-complete.v1";
const FORCE_ONBOARDING_STORAGE_KEY = "sprout-force-onboarding";
type OnboardingGateStage = "blocking" | "onboarding" | "ready";

/**
 * Developer/testing override: replay the onboarding flow even when the user
 * already has a profile or has completed it before. Enable by setting
 * `localStorage["sprout-force-onboarding"] = "true"` or loading with
 * `?onboarding=force` (or `?onboarding=1`). Cleared automatically once the
 * user finishes or skips so it never traps a real user.
 */
function isForceOnboarding(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const onboardingParam = new URLSearchParams(window.location.search).get(
      "onboarding",
    );
    if (onboardingParam === "force" || onboardingParam === "1") {
      window.localStorage.setItem(FORCE_ONBOARDING_STORAGE_KEY, "true");
      return true;
    }
  } catch {
    // Ignore malformed URLs and fall back to the storage flag.
  }

  return window.localStorage.getItem(FORCE_ONBOARDING_STORAGE_KEY) === "true";
}

function clearForceOnboarding() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(FORCE_ONBOARDING_STORAGE_KEY);
}

type UseFirstRunOnboardingGateOptions = {
  currentPubkey: string | null;
  hasExistingProfile: boolean;
  identityIsFetching: boolean;
  identityStatus: QueryStatus;
  isSharedIdentity: boolean;
  profileStatus: QueryStatus;
};

type OnboardingGateState = {
  currentPubkey: string | null;
  hasCompletedCurrentPubkey: boolean;
  hasSettledCurrentPubkey: boolean;
  isOpen: boolean;
};

function onboardingCompletionStorageKey(pubkey: string) {
  return `${ONBOARDING_COMPLETION_STORAGE_KEY}:${pubkey}`;
}

function readOnboardingCompletion(pubkey: string | null) {
  if (typeof window === "undefined" || !pubkey) {
    return false;
  }

  return (
    window.localStorage.getItem(onboardingCompletionStorageKey(pubkey)) ===
    "true"
  );
}

function createOnboardingGateState(pubkey: string | null): OnboardingGateState {
  const hasCompletedCurrentPubkey = readOnboardingCompletion(pubkey);

  return {
    currentPubkey: pubkey,
    hasCompletedCurrentPubkey,
    hasSettledCurrentPubkey: hasCompletedCurrentPubkey,
    isOpen: false,
  };
}

function resolveActiveGateState(
  gateState: OnboardingGateState,
  currentPubkey: string | null,
) {
  return gateState.currentPubkey === currentPubkey
    ? gateState
    : createOnboardingGateState(currentPubkey);
}

function updateActiveGateState(
  gateState: OnboardingGateState,
  currentPubkey: string | null,
  update: (activeGateState: OnboardingGateState) => OnboardingGateState,
) {
  return update(resolveActiveGateState(gateState, currentPubkey));
}

function isSettledQueryStatus(status: QueryStatus) {
  return status === "success" || status === "error";
}

function resolveOnboardingGateStage({
  currentPubkey,
  forceOnboarding,
  gateState,
  identityIsFetching,
  identityStatus,
}: {
  currentPubkey: string | null;
  forceOnboarding: boolean;
  gateState: OnboardingGateState;
  identityIsFetching: boolean;
  identityStatus: QueryStatus;
}): OnboardingGateStage {
  // Forced replay only needs an identity to scope the flow; once we have a
  // pubkey, show onboarding regardless of completion/profile state.
  if (forceOnboarding && currentPubkey !== null) {
    return "onboarding";
  }

  const isBlockingCurrentPubkey =
    currentPubkey !== null &&
    !gateState.hasCompletedCurrentPubkey &&
    (gateState.isOpen || !gateState.hasSettledCurrentPubkey);

  if (gateState.isOpen) {
    return "onboarding";
  }

  if (
    identityIsFetching ||
    !isSettledQueryStatus(identityStatus) ||
    isBlockingCurrentPubkey
  ) {
    return "blocking";
  }

  return "ready";
}

export function useFirstRunOnboardingGate({
  currentPubkey,
  hasExistingProfile,
  identityIsFetching,
  identityStatus,
  isSharedIdentity,
  profileStatus,
}: UseFirstRunOnboardingGateOptions) {
  const [gateState, setGateState] = React.useState<OnboardingGateState>(() =>
    createOnboardingGateState(currentPubkey),
  );
  const activeGateState = resolveActiveGateState(gateState, currentPubkey);
  const { hasCompletedCurrentPubkey, hasSettledCurrentPubkey } =
    activeGateState;

  React.useEffect(() => {
    setGateState((current) =>
      current.currentPubkey === currentPubkey
        ? current
        : createOnboardingGateState(currentPubkey),
    );
  }, [currentPubkey]);

  React.useEffect(() => {
    // Fast-path: shared identity worktrees have already onboarded in the
    // main checkout. Skip unconditionally without waiting for the relay
    // profile query. Guarded by !hasCompletedCurrentPubkey so it fires once.
    if (
      isSharedIdentity &&
      currentPubkey &&
      identityStatus === "success" &&
      !hasCompletedCurrentPubkey
    ) {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          onboardingCompletionStorageKey(currentPubkey),
          "true",
        );
      }
      setGateState((current) =>
        updateActiveGateState(current, currentPubkey, (activeGateState) => ({
          ...activeGateState,
          hasCompletedCurrentPubkey: true,
          hasSettledCurrentPubkey: true,
          isOpen: false,
        })),
      );
      return;
    }

    // Original guard — restored to simple form.
    if (hasSettledCurrentPubkey || !currentPubkey) {
      return;
    }

    if (identityStatus === "error") {
      setGateState((current) =>
        updateActiveGateState(current, currentPubkey, (activeGateState) => ({
          ...activeGateState,
          hasSettledCurrentPubkey: true,
        })),
      );
      return;
    }

    if (identityStatus !== "success") {
      return;
    }

    if (!isSettledQueryStatus(profileStatus)) {
      return;
    }

    // If the relay already has a real profile for this pubkey, the user has
    // been onboarded elsewhere — skip the gate and persist the completion so
    // future launches in this data dir don't re-check.
    if (hasExistingProfile) {
      if (typeof window !== "undefined" && currentPubkey) {
        window.localStorage.setItem(
          onboardingCompletionStorageKey(currentPubkey),
          "true",
        );
      }
    }

    setGateState((current) =>
      updateActiveGateState(current, currentPubkey, (activeGateState) => {
        const alreadyOnboarded =
          activeGateState.hasCompletedCurrentPubkey || hasExistingProfile;
        return {
          ...activeGateState,
          hasCompletedCurrentPubkey: alreadyOnboarded,
          hasSettledCurrentPubkey: true,
          isOpen: !alreadyOnboarded,
        };
      }),
    );
  }, [
    currentPubkey,
    hasCompletedCurrentPubkey,
    hasExistingProfile,
    hasSettledCurrentPubkey,
    identityStatus,
    isSharedIdentity,
    profileStatus,
  ]);

  const skipForNow = React.useCallback(() => {
    clearForceOnboarding();
    setGateState((current) =>
      updateActiveGateState(current, currentPubkey, (activeGateState) => ({
        ...activeGateState,
        hasSettledCurrentPubkey: true,
        isOpen: false,
      })),
    );
  }, [currentPubkey]);

  const complete = React.useCallback(() => {
    clearForceOnboarding();
    if (typeof window !== "undefined" && currentPubkey) {
      window.localStorage.setItem(
        onboardingCompletionStorageKey(currentPubkey),
        "true",
      );
    }

    setGateState({
      currentPubkey,
      hasCompletedCurrentPubkey: true,
      hasSettledCurrentPubkey: true,
      isOpen: false,
    });
  }, [currentPubkey]);

  return {
    complete,
    skipForNow,
    stage: resolveOnboardingGateStage({
      currentPubkey,
      forceOnboarding: isForceOnboarding(),
      gateState: activeGateState,
      identityIsFetching,
      identityStatus,
    }),
  };
}

function hasRealDisplayName(displayName?: string | null): boolean {
  if (!displayName) return false;
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  return !lower.startsWith("npub1") && !lower.startsWith("nostr:npub1");
}

export function useAppOnboardingState(isSharedIdentity: boolean) {
  const queryClient = useQueryClient();
  const identityQuery = useIdentityQuery();
  const identity = identityQuery.data;
  const currentPubkey = identity?.pubkey ?? null;
  const profileQuery = useProfileQuery();
  const onboardingGate = useFirstRunOnboardingGate({
    currentPubkey,
    hasExistingProfile: hasRealDisplayName(profileQuery.data?.displayName),
    identityIsFetching: identityQuery.fetchStatus === "fetching",
    identityStatus: identityQuery.status,
    isSharedIdentity,
    profileStatus: profileQuery.status,
  });
  const gateComplete = onboardingGate.complete;
  const completeAndAutoJoin = React.useCallback(() => {
    gateComplete();
    void autoJoinDefaultChannel(queryClient);
  }, [gateComplete, queryClient]);
  const flow = {
    actions: {
      complete: completeAndAutoJoin,
      skipForNow: onboardingGate.skipForNow,
    },
    initialProfile: {
      profile: profileQuery.data,
    },
  };

  return {
    currentPubkey,
    flow,
    stage: onboardingGate.stage,
  };
}
