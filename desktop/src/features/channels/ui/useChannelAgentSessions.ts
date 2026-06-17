import * as React from "react";

import { useAgentOwnershipQuery } from "@/features/agents/hooks/useCanViewAgentActivity";
import type { TimelineMessage } from "@/features/messages/types";
import type { Channel, ChannelMember } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import type { PanelValueSetter } from "./useChannelPanelHistoryState";

import {
  type ChannelAgentSessionAgent,
  getChannelAgentSessionAgents,
  resolveOpenAgentSessionAgent,
} from "../lib/agentSessionCandidates";

export type { ChannelAgentSessionAgent } from "../lib/agentSessionCandidates";
export {
  buildChannelAgentSessionCandidates,
  getChannelAgentSessionAgents,
  resolveOpenAgentSessionAgent,
} from "../lib/agentSessionCandidates";

type UseChannelAgentSessionsOptions = {
  activeChannel: Channel | null;
  activeChannelId: string | null;
  agentCandidates: ChannelAgentSessionAgent[];
  agentsLoaded: boolean;
  channelMembers?: ChannelMember[];
  handleOpenThread: (message: TimelineMessage) => void;
  openAgentSessionPubkey: string | null;
  setExpandedThreadReplyIds: (value: Set<string>) => void;
  setOpenAgentSessionPubkey: PanelValueSetter;
  setOpenThreadHeadId: (value: string | null) => void;
  setProfilePanelPubkey: (value: string | null) => void;
  setThreadReplyTargetId: (value: string | null) => void;
  setThreadScrollTargetId: (value: string | null) => void;
};

export function useChannelAgentSessions({
  activeChannel,
  activeChannelId,
  agentCandidates,
  agentsLoaded,
  channelMembers,
  handleOpenThread,
  openAgentSessionPubkey,
  setExpandedThreadReplyIds,
  setOpenAgentSessionPubkey,
  setOpenThreadHeadId,
  setProfilePanelPubkey,
  setThreadReplyTargetId,
  setThreadScrollTargetId,
}: UseChannelAgentSessionsOptions) {
  const channelAgentSessionAgents = React.useMemo(
    () =>
      getChannelAgentSessionAgents({
        activeChannel,
        activeChannelId,
        agents: agentCandidates,
        channelMembers,
      }),
    [activeChannel, activeChannelId, agentCandidates, channelMembers],
  );

  const ownershipQuery = useAgentOwnershipQuery(openAgentSessionPubkey);

  const openAgentSessionAgent = React.useMemo(
    () =>
      resolveOpenAgentSessionAgent({
        allAgentCandidates: agentCandidates,
        channelAgentSessionAgents,
        openAgentSessionPubkey,
      }),
    [agentCandidates, channelAgentSessionAgents, openAgentSessionPubkey],
  );

  const closeAgentSession = React.useCallback(() => {
    setOpenAgentSessionPubkey(null);
  }, [setOpenAgentSessionPubkey]);

  const openAgentSession = React.useCallback(
    (pubkey: string) => {
      setOpenThreadHeadId(null);
      setExpandedThreadReplyIds(new Set());
      setThreadScrollTargetId(null);
      setThreadReplyTargetId(null);
      setProfilePanelPubkey(null);
      setOpenAgentSessionPubkey(pubkey);
    },
    [
      setExpandedThreadReplyIds,
      setOpenAgentSessionPubkey,
      setOpenThreadHeadId,
      setProfilePanelPubkey,
      setThreadReplyTargetId,
      setThreadScrollTargetId,
    ],
  );

  const selectAgentSession = React.useCallback(
    (pubkey: string) => {
      setOpenAgentSessionPubkey(pubkey);
    },
    [setOpenAgentSessionPubkey],
  );

  const openThreadAndCloseAgentSession = React.useCallback(
    (message: TimelineMessage) => {
      setOpenAgentSessionPubkey(null);
      setProfilePanelPubkey(null);
      handleOpenThread(message);
    },
    [handleOpenThread, setOpenAgentSessionPubkey, setProfilePanelPubkey],
  );

  React.useEffect(() => {
    if (!openAgentSessionPubkey) {
      return;
    }

    const inChannelList = channelAgentSessionAgents.some(
      (agent) =>
        normalizePubkey(agent.pubkey) ===
        normalizePubkey(openAgentSessionPubkey),
    );
    if (inChannelList) {
      return;
    }

    // Wait until the agent/channel/member queries have settled before treating
    // an out-of-channel open session as stale — a reload restoring the
    // agentSession URL param shows an empty list mid-fetch.
    if (!agentsLoaded) {
      return;
    }

    if (ownershipQuery.isLoading || ownershipQuery.data === undefined) {
      return;
    }

    // Owners keep the panel open even when the agent is out of the channel
    // list; non-owners get the stale param auto-closed.
    if (!ownershipQuery.data.isOwner) {
      setOpenAgentSessionPubkey(null, { replace: true });
    }
  }, [
    agentsLoaded,
    channelAgentSessionAgents,
    openAgentSessionPubkey,
    ownershipQuery.data,
    ownershipQuery.isLoading,
    setOpenAgentSessionPubkey,
  ]);

  return {
    channelAgentSessionAgents,
    closeAgentSession,
    openAgentSession,
    openAgentSessionAgent,
    openAgentSessionPubkey,
    openThreadAndCloseAgentSession,
    selectAgentSession,
  };
}
