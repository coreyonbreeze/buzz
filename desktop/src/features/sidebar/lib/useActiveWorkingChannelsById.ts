import * as React from "react";

import {
  type ActiveChannelTurnSummary,
  useActiveAgentTurnsBridge,
  useActiveAgentTurnsByChannel,
} from "@/features/agents/activeAgentTurnsStore";
import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { useManagedAgentObserverBridge } from "@/features/agents/observerRelayStore";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { ownsAuthorAgent } from "@/features/profile/lib/identity";
import { useIdentityQuery } from "@/shared/api/hooks";
import type {
  ManagedAgent,
  RelayAgent,
  UserProfileSummary,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

type WorkingAgentName = Pick<ManagedAgent, "pubkey" | "name">;
type WorkingAgent = Pick<ManagedAgent, "pubkey" | "name" | "status">;
type OwnedRelayWorkingAgent = Pick<RelayAgent, "pubkey" | "name"> & {
  status: "deployed";
};

export function resolveActiveWorkingChannelNames(
  summary: ActiveChannelTurnSummary,
  workingAgents: readonly WorkingAgentName[],
): ActiveChannelTurnSummary {
  const namesByPubkey = new Map(
    workingAgents.map((agent) => [normalizePubkey(agent.pubkey), agent.name]),
  );

  return {
    ...summary,
    agentNames: summary.agentPubkeys.flatMap((pubkey) => {
      const name = namesByPubkey.get(normalizePubkey(pubkey));
      return name ? [name] : [];
    }),
  };
}

export function getOwnedRelayWorkingAgents(
  relayAgents: readonly Pick<RelayAgent, "pubkey" | "name">[],
  profiles: Record<string, UserProfileSummary> | undefined,
  currentPubkey: string | undefined,
): OwnedRelayWorkingAgent[] {
  if (!currentPubkey) return [];

  return relayAgents.flatMap((agent) => {
    const profile = profiles?.[normalizePubkey(agent.pubkey)];
    if (!ownsAuthorAgent(profile, currentPubkey)) {
      return [];
    }

    return [{ pubkey: agent.pubkey, name: agent.name, status: "deployed" }];
  });
}

export function mergeWorkingAgents(
  managedAgents: readonly WorkingAgent[],
  ownedRelayAgents: readonly WorkingAgent[],
): WorkingAgent[] {
  const seenPubkeys = new Set<string>();
  const merged: WorkingAgent[] = [];

  for (const agent of [...managedAgents, ...ownedRelayAgents]) {
    const pubkey = normalizePubkey(agent.pubkey);
    if (seenPubkeys.has(pubkey)) continue;
    seenPubkeys.add(pubkey);
    merged.push(agent);
  }

  return merged;
}

export function useActiveWorkingChannelsById(): ReadonlyMap<
  string,
  ActiveChannelTurnSummary
> {
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;
  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgents = React.useMemo(
    () => managedAgentsQuery.data ?? [],
    [managedAgentsQuery.data],
  );
  const relayAgentsQuery = useRelayAgentsQuery();
  const relayAgents = React.useMemo(
    () => relayAgentsQuery.data ?? [],
    [relayAgentsQuery.data],
  );
  const relayAgentPubkeys = React.useMemo(
    () => relayAgents.map((agent) => agent.pubkey),
    [relayAgents],
  );
  const relayAgentProfilesQuery = useUsersBatchQuery(relayAgentPubkeys, {
    enabled: relayAgentPubkeys.length > 0,
  });
  const ownedRelayAgents = React.useMemo(
    () =>
      getOwnedRelayWorkingAgents(
        relayAgents,
        relayAgentProfilesQuery.data?.profiles,
        currentPubkey,
      ),
    [currentPubkey, relayAgentProfilesQuery.data?.profiles, relayAgents],
  );
  const workingAgents = React.useMemo(
    () => mergeWorkingAgents(managedAgents, ownedRelayAgents),
    [managedAgents, ownedRelayAgents],
  );

  useManagedAgentObserverBridge(workingAgents);
  useActiveAgentTurnsBridge(workingAgents);

  const activeWorkingChannels = useActiveAgentTurnsByChannel();
  return React.useMemo(
    () =>
      new Map(
        activeWorkingChannels.map((summary) => {
          const resolvedSummary = resolveActiveWorkingChannelNames(
            summary,
            workingAgents,
          );
          return [resolvedSummary.channelId, resolvedSummary];
        }),
      ),
    [activeWorkingChannels, workingAgents],
  );
}
