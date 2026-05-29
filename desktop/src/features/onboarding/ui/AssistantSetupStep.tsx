import * as React from "react";

import { useAvailableAcpProviders } from "@/features/agents/hooks";
import {
  useAgentTranscript,
  useObserverEvents,
} from "@/features/agents/ui/useObserverEvents";
import {
  createManagedAgent,
  deleteManagedAgent,
  listManagedAgents,
  sendChannelMessage,
  startManagedAgent,
  stopManagedAgent,
  updateManagedAgent,
} from "@/shared/api/tauri";
import type { Channel, ManagedAgent } from "@/shared/api/types";
import { Textarea } from "@/shared/ui/textarea";
import {
  buildAssistantAcknowledgement,
  buildInitialMessages,
  clearStoredAssistant,
  createFallbackProvider,
  isAgentRunning,
  type LocalMessage,
  parseRequestedAssistantName,
  pickPlantAssistantName,
  readStoredAssistant,
  resolveSetupChannel,
  writeStoredAssistant,
} from "../lib/assistantSetupHelpers";
import {
  applyAssistantProfileAnswer,
  buildPersonalAssistantPrompt,
  createInitialAssistantProfile,
  FIRST_ASSISTANT_PROMPT,
  getFollowupQuickReplies,
  getInitialQuickReplies,
  isAssistantProfileReady,
  PERSONAL_ASSISTANT_PROMPT_MARKER,
  type AssistantProfile,
  type AssistantProfileAnswer,
} from "../lib/personalAssistantProfile";
import { TerminalChoices, TerminalConversation } from "./AssistantTerminal";

type AssistantSetupStepProps = {
  actions: {
    back: () => void;
    complete: () => void;
  };
  initialProfile: {
    avatarUrl: string;
    displayName: string;
  };
  ownerPubkey: string | null;
};

type AssistantSetupState =
  | "creating"
  | "ready"
  | "degraded"
  | "error"
  | "finishing";

export function AssistantSetupStep({
  actions,
  initialProfile,
  ownerPubkey,
}: AssistantSetupStepProps) {
  const providersQuery = useAvailableAcpProviders();
  const availableProvider = React.useMemo(() => {
    const providers = providersQuery.data ?? [];
    return providers[0] ?? null;
  }, [providersQuery.data]);
  const [status, setStatus] = React.useState<AssistantSetupState>("creating");
  const [agent, setAgent] = React.useState<ManagedAgent | null>(null);
  const [channel, setChannel] = React.useState<Channel | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = React.useState<string | null>(null);
  const [profile, setProfile] = React.useState<AssistantProfile>(() =>
    createInitialAssistantProfile(),
  );
  const [draft, setDraft] = React.useState("");
  const [isSending, setIsSending] = React.useState(false);
  const [isWaitingForAgent, setIsWaitingForAgent] = React.useState(false);
  const [showQuickReplies, setShowQuickReplies] = React.useState(true);
  const [assistantName, setAssistantName] = React.useState(
    pickPlantAssistantName,
  );
  const [localMessages, setLocalMessages] = React.useState<LocalMessage[]>(() =>
    buildInitialMessages(initialProfile.displayName, assistantName),
  );
  const [rebuildNonce, setRebuildNonce] = React.useState(0);
  const lastBuiltNonceRef = React.useRef(-1);
  // Set by an explicit reset so the rebuild wipes the reused agent's
  // personality back to the initial prompt instead of preserving it.
  const resetRequestedRef = React.useRef(false);

  const liveTranscript = useAgentTranscript(agent !== null, agent?.pubkey);
  useObserverEvents(agent !== null, agent?.pubkey);
  const scopedTranscript = React.useMemo(
    () =>
      channel
        ? liveTranscript.filter((item) => item.channelId === channel.id)
        : [],
    [channel, liveTranscript],
  );
  const liveMessages = React.useMemo(
    () =>
      scopedTranscript
        .filter((item) => item.type === "message")
        .map(
          (item): LocalMessage => ({
            id: `live-${item.id}`,
            role: item.role,
            text: item.text,
          }),
        ),
    [scopedTranscript],
  );
  const liveMessageCountAtSendRef = React.useRef(0);

  React.useEffect(() => {
    if (
      isWaitingForAgent &&
      liveMessages.length > liveMessageCountAtSendRef.current
    ) {
      setIsWaitingForAgent(false);
    }
  }, [isWaitingForAgent, liveMessages.length]);

  React.useEffect(() => {
    if (!isWaitingForAgent) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setIsWaitingForAgent(false);
    }, 8000);
    return () => window.clearTimeout(timeout);
  }, [isWaitingForAgent]);

  const hiddenPrompt = React.useMemo(
    () => buildPersonalAssistantPrompt(profile),
    [profile],
  );
  const quickReplies = React.useMemo(
    () =>
      profile.answerCount === 0
        ? getInitialQuickReplies()
        : getFollowupQuickReplies(profile),
    [profile],
  );
  const displayedMessages = React.useMemo(() => {
    const messages =
      liveMessages.length > 0
        ? [...localMessages, ...liveMessages]
        : localMessages;
    if (!isWaitingForAgent) {
      return messages;
    }
    return [
      ...messages,
      {
        id: "waiting-for-agent",
        role: "assistant" as const,
        text: "waiting for agent...",
      },
    ];
  }, [isWaitingForAgent, liveMessages, localMessages]);
  const canFinish =
    status !== "creating" &&
    status !== "finishing" &&
    (isAssistantProfileReady(profile) || status === "degraded");

  React.useEffect(() => {
    if (
      !ownerPubkey ||
      providersQuery.isLoading ||
      lastBuiltNonceRef.current === rebuildNonce
    ) {
      return;
    }

    let cancelled = false;
    lastBuiltNonceRef.current = rebuildNonce;

    async function ensureAssistant() {
      if (!ownerPubkey) {
        return;
      }

      setStatus("creating");
      setErrorMessage(null);

      try {
        const stored = readStoredAssistant(ownerPubkey);
        const managedAgents = await listManagedAgents();

        // Every agent this flow has created carries a stable marker as the
        // first line of its system prompt. We keep exactly one personal
        // assistant and remove any duplicates from earlier sessions/resets.
        const personalAgents = managedAgents.filter((candidate) =>
          (candidate.systemPrompt ?? "").startsWith(
            PERSONAL_ASSISTANT_PROMPT_MARKER,
          ),
        );
        const personalAgentsByRecency = [...personalAgents].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        );

        // Prefer the agent stored for this owner, otherwise the most recent
        // personal agent. Anything else is a leftover to delete.
        const storedAgent = stored?.agentPubkey
          ? (personalAgents.find(
              (candidate) => candidate.pubkey === stored.agentPubkey,
            ) ?? null)
          : null;
        let nextAgent = storedAgent ?? personalAgentsByRecency[0] ?? null;
        let introSent =
          nextAgent !== null &&
          nextAgent.pubkey === stored?.agentPubkey &&
          stored?.introSent === true;

        const provider = availableProvider ?? createFallbackProvider();
        const canSpawn =
          availableProvider !== null || provider.command === "sprout-agent";

        for (const duplicate of personalAgents) {
          if (duplicate.pubkey === nextAgent?.pubkey) {
            continue;
          }
          try {
            await deleteManagedAgent(duplicate.pubkey);
          } catch {
            // Best-effort cleanup; keep going if one delete fails.
          }
        }

        const resetRequested = resetRequestedRef.current;
        resetRequestedRef.current = false;
        if (resetRequested) {
          introSent = false;
        }

        if (!nextAgent) {
          const created = await createManagedAgent({
            name: assistantName,
            acpCommand: "sprout-acp",
            agentCommand: provider.command,
            agentArgs: provider.defaultArgs,
            mcpCommand: provider.mcpCommand ?? "sprout-mcp-server",
            systemPrompt: hiddenPrompt,
            spawnAfterCreate: canSpawn,
            startOnAppLaunch: true,
            respondTo: "allowlist",
            respondToAllowlist: ownerPubkey ? [ownerPubkey] : [],
          });
          nextAgent = created.agent;
          introSent = false;

          if (created.spawnError) {
            setNoticeMessage(
              "Your assistant profile was saved, but Sprout cannot start it on this machine yet. You can finish now and turn it on later from Settings > Doctor.",
            );
          }
        } else if (canSpawn) {
          if (resetRequested && isAgentRunning(nextAgent)) {
            // On an explicit reset, bounce the process so the onboarding
            // session always gets a fresh relay connection. This avoids a
            // long-lived, wedged agent silently dropping messages — the
            // single biggest cause of "the agent isn't responding".
            await stopManagedAgent(nextAgent.pubkey);
            nextAgent = await startManagedAgent(nextAgent.pubkey);
          } else if (!isAgentRunning(nextAgent)) {
            nextAgent = await startManagedAgent(nextAgent.pubkey);
          }
        }

        if (ownerPubkey) {
          const updated = await updateManagedAgent({
            pubkey: nextAgent.pubkey,
            respondTo: "allowlist",
            respondToAllowlist: [ownerPubkey],
            // Only rewrite the personality on an explicit reset; a normal
            // mount must preserve a returning user's customized prompt.
            systemPrompt: resetRequested ? hiddenPrompt : undefined,
          });
          nextAgent = updated.agent;
        }

        const nextChannel = await resolveSetupChannel(nextAgent);
        const liveReady = canSpawn && isAgentRunning(nextAgent);

        if (!introSent && liveReady) {
          await sendChannelMessage(
            nextChannel.id,
            FIRST_ASSISTANT_PROMPT,
            null,
            undefined,
            [nextAgent.pubkey],
          );
          introSent = true;
        }

        writeStoredAssistant(ownerPubkey, {
          agentPubkey: nextAgent.pubkey,
          channelId: nextChannel.id,
          introSent,
        });

        if (cancelled) {
          return;
        }
        setAgent(nextAgent);
        setChannel(nextChannel);
        setStatus(liveReady ? "ready" : "degraded");
      } catch (error) {
        if (cancelled) {
          return;
        }
        setStatus("error");
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to prepare your assistant.",
        );
      }
    }

    void ensureAssistant();

    return () => {
      cancelled = true;
    };
  }, [
    assistantName,
    availableProvider,
    hiddenPrompt,
    ownerPubkey,
    providersQuery.isLoading,
    rebuildNonce,
  ]);

  async function sendAnswer(
    answer: AssistantProfileAnswer,
    visibleText: string,
  ) {
    const trimmedText = visibleText.trim();
    if (!trimmedText || !agent) {
      return;
    }

    setIsSending(true);
    setErrorMessage(null);
    setLocalMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: trimmedText,
      },
    ]);

    const nextProfile = applyAssistantProfileAnswer(profile, answer);
    const nextPrompt = buildPersonalAssistantPrompt(nextProfile);
    const requestedName = parseRequestedAssistantName(trimmedText);
    const nextAssistantName = requestedName ?? assistantName;
    setProfile(nextProfile);
    setShowQuickReplies(false);

    try {
      await updateManagedAgent({
        pubkey: agent.pubkey,
        name: requestedName ?? undefined,
        systemPrompt: nextPrompt,
      });
      if (requestedName) {
        setAssistantName(requestedName);
        setAgent((current) =>
          current ? { ...current, name: requestedName } : current,
        );
      }

      setLocalMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: buildAssistantAcknowledgement(
            answer,
            trimmedText,
            nextAssistantName,
          ),
        },
      ]);
      setShowQuickReplies(answer.kind !== "freeform");

      if (channel) {
        liveMessageCountAtSendRef.current = liveMessages.length;
        setIsWaitingForAgent(true);
        await sendChannelMessage(channel.id, trimmedText, null, undefined, [
          agent.pubkey,
        ]);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to save that preference.",
      );
    } finally {
      setIsSending(false);
    }
  }

  async function handleSendDraft() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft("");
    if (text.toLowerCase() === "reset" || text.toLowerCase() === "/reset") {
      resetAssistantSetup();
      return;
    }
    await sendAnswer({ kind: "freeform", value: text }, text);
  }

  function resetAssistantSetup() {
    // Drop the stored channel/intro state and rebuild. The rebuild reuses the
    // existing personal agent (matched by prompt marker) rather than creating
    // a new one, so the user is never left with duplicate assistants.
    if (ownerPubkey) {
      clearStoredAssistant(ownerPubkey);
    }
    resetRequestedRef.current = true;

    setProfile(createInitialAssistantProfile());
    setErrorMessage(null);
    setNoticeMessage(null);
    setIsWaitingForAgent(false);
    setShowQuickReplies(true);
    setAgent(null);
    setChannel(null);
    setStatus("creating");
    setLocalMessages([
      ...buildInitialMessages(initialProfile.displayName, assistantName),
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "Setup reset. Rebuilding your assistant from scratch...",
      },
    ]);

    setRebuildNonce((nonce) => nonce + 1);
  }

  async function handleFinish() {
    if (!agent) {
      actions.complete();
      return;
    }

    setStatus("finishing");
    setErrorMessage(null);
    try {
      const updated = await updateManagedAgent({
        pubkey: agent.pubkey,
        systemPrompt: buildPersonalAssistantPrompt(profile),
      });

      if (
        updated.agent.backend.type === "local" &&
        isAgentRunning(updated.agent)
      ) {
        await stopManagedAgent(updated.agent.pubkey);
        await startManagedAgent(updated.agent.pubkey);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to finish assistant setup.",
      );
      setStatus("ready");
      return;
    }

    actions.complete();
  }

  return (
    <div
      className="flex min-h-dvh flex-col bg-black font-mono text-white antialiased [font-synthesis:none] [text-rendering:optimizeLegibility]"
      data-testid="onboarding-assistant-step"
    >
      <div className="grid grid-cols-3 items-center px-4 py-2 text-muted-foreground sm:px-6">
        <div />
        <div className="font-sans text-center text-xs text-white">
          Sprout Onboarding
        </div>
        <div />
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4 text-sm leading-6 sm:p-6">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TerminalConversation
            assistantName={assistantName}
            messages={displayedMessages}
          />
          <div className="mt-1 space-y-1">
            {showQuickReplies ? (
              <TerminalChoices
                disabled={!agent || isSending || status === "creating"}
                onChoose={(reply) => {
                  void sendAnswer(reply.answer, reply.label);
                }}
                replies={quickReplies}
              />
            ) : null}
            <div className="grid grid-cols-[auto_1fr] items-start gap-2">
              <span>$</span>
              <div className="relative min-h-6">
                {draft.length === 0 ? (
                  <span className="pointer-events-none absolute left-0 top-[0.2rem] h-4 w-1.5 animate-pulse bg-white" />
                ) : null}
                <Textarea
                  className="min-h-6 resize-none border-0 bg-transparent p-0 font-mono text-sm leading-6 text-white shadow-none placeholder:text-transparent focus-visible:ring-0"
                  disabled={!agent || isSending || status === "creating"}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleSendDraft();
                    }
                  }}
                  value={draft}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="sr-only">
          {noticeMessage ? (
            <p className="mb-2 text-white/70">note: {noticeMessage}</p>
          ) : null}

          {errorMessage ? (
            <p className="mb-2 text-destructive">error: {errorMessage}</p>
          ) : null}

          <button
            className="sr-only"
            data-testid="onboarding-finish"
            disabled={!canFinish}
            onClick={() => {
              void handleFinish();
            }}
            type="button"
          >
            finish
          </button>
        </div>
      </div>
    </div>
  );
}
