import * as React from "react";
import { listen } from "@tauri-apps/api/event";

import {
  AGENT_WINDOW_ATTACH_EVENT,
  AGENT_WINDOW_ATTACH_STORAGE_KEY,
  type AgentWindowAttachRequest,
} from "@/features/agents/lib/openAgentConversationWindow";
import { revealDesktopAppWindow } from "@/features/notifications/lib/desktop";

type GoChannelWithAgentSession = (
  channelId: string,
  options?: { agentSession?: string },
) => Promise<unknown>;

function isAgentWindowAttachRequest(
  payload: unknown,
): payload is AgentWindowAttachRequest {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "agentPubkey" in payload &&
    "channelId" in payload &&
    typeof payload.agentPubkey === "string" &&
    payload.agentPubkey.length > 0 &&
    typeof payload.channelId === "string" &&
    payload.channelId.length > 0
  );
}

function parseAgentWindowAttachRequest(
  raw: string | null,
): AgentWindowAttachRequest | null {
  if (!raw) {
    return null;
  }

  try {
    const payload = JSON.parse(raw) as unknown;
    return isAgentWindowAttachRequest(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function useAgentWindowAttachRequests(
  goChannel: GoChannelWithAgentSession,
) {
  const handleAgentWindowAttachRequest = React.useEffectEvent(
    async (payload: unknown) => {
      if (!isAgentWindowAttachRequest(payload)) {
        return;
      }

      window.localStorage.removeItem(AGENT_WINDOW_ATTACH_STORAGE_KEY);
      await revealDesktopAppWindow();
      await goChannel(payload.channelId, {
        agentSession: payload.agentPubkey,
      });
    },
  );

  const consumePendingAgentWindowAttachRequest = React.useEffectEvent(() => {
    const payload = parseAgentWindowAttachRequest(
      window.localStorage.getItem(AGENT_WINDOW_ATTACH_STORAGE_KEY),
    );
    if (!payload) {
      return;
    }

    void handleAgentWindowAttachRequest(payload);
  });

  React.useEffect(() => {
    let isCancelled = false;
    let unlisten: (() => void) | null = null;

    consumePendingAgentWindowAttachRequest();

    function handleStorage(event: StorageEvent) {
      if (
        event.storageArea !== window.localStorage ||
        event.key !== AGENT_WINDOW_ATTACH_STORAGE_KEY
      ) {
        return;
      }

      const payload = parseAgentWindowAttachRequest(event.newValue);
      if (payload) {
        void handleAgentWindowAttachRequest(payload);
      }
    }

    function handleFocus() {
      consumePendingAgentWindowAttachRequest();
    }

    window.addEventListener("storage", handleStorage);
    window.addEventListener("focus", handleFocus);

    void listen<unknown>(AGENT_WINDOW_ATTACH_EVENT, (event) => {
      void handleAgentWindowAttachRequest(event.payload);
    }).then((dispose) => {
      if (isCancelled) {
        dispose();
        return;
      }

      unlisten = dispose;
    });

    return () => {
      isCancelled = true;
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", handleFocus);
      unlisten?.();
    };
  }, []);
}
