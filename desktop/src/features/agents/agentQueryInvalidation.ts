import type { QueryClient } from "@tanstack/react-query";

import { channelsQueryKey } from "@/features/channels/hooks";
import type { Channel } from "@/shared/api/types";

export const relayAgentsQueryKey = ["relay-agents"] as const;
export const managedAgentsQueryKey = ["managed-agents"] as const;

type InvalidateAgentQueriesOptions = {
  refetchChannels?: boolean;
};

async function invalidateAgentQueries(
  queryClient: QueryClient,
  channelId: string | null,
  options: InvalidateAgentQueriesOptions = {},
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
    queryClient.invalidateQueries({ queryKey: relayAgentsQueryKey }),
    queryClient.invalidateQueries({
      queryKey: channelsQueryKey,
      refetchType: options.refetchChannels === false ? "none" : "active",
    }),
    ...(channelId
      ? [
          queryClient.invalidateQueries({
            queryKey: ["channels", channelId, "members"],
          }),
        ]
      : []),
  ]);
}

function refreshAgentQueriesInBackground(task: () => Promise<unknown>) {
  void task().catch((error) => {
    console.error("Failed to refresh agent queries", error);
  });
}

export function invalidateAgentQueriesInBackground(
  queryClient: QueryClient,
  channelId: string | null,
  options?: InvalidateAgentQueriesOptions,
) {
  refreshAgentQueriesInBackground(() =>
    invalidateAgentQueries(queryClient, channelId, options),
  );
}

export function isCachedDmChannel(
  queryClient: QueryClient,
  channelId: string | null,
) {
  if (!channelId) {
    return false;
  }

  return Boolean(
    queryClient
      .getQueryData<Channel[]>(channelsQueryKey)
      ?.some(
        (channel) => channel.id === channelId && channel.channelType === "dm",
      ),
  );
}

export function invalidateManagedAgentQueriesInBackground(
  queryClient: QueryClient,
) {
  refreshAgentQueriesInBackground(() =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
      queryClient.invalidateQueries({ queryKey: relayAgentsQueryKey }),
    ]),
  );
}
