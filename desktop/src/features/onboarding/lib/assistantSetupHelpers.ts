import { openDm } from "@/shared/api/tauri";
import type { Channel, ManagedAgent } from "@/shared/api/types";
import type { AssistantProfileAnswer } from "./personalAssistantProfile";

export type StoredAssistantSetup = {
  agentPubkey: string;
  channelId?: string;
  introSent?: boolean;
};

export type LocalMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

function storageKey(ownerPubkey: string) {
  return `sprout-onboarding-assistant.v2:${ownerPubkey}`;
}

export function readStoredAssistant(
  ownerPubkey: string,
): StoredAssistantSetup | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(storageKey(ownerPubkey));
    return raw ? (JSON.parse(raw) as StoredAssistantSetup) : null;
  } catch {
    return null;
  }
}

export function writeStoredAssistant(
  ownerPubkey: string,
  value: StoredAssistantSetup,
) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(storageKey(ownerPubkey), JSON.stringify(value));
}

export function clearStoredAssistant(ownerPubkey: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(storageKey(ownerPubkey));
}

export function createFallbackProvider() {
  return {
    command: "sprout-agent",
    defaultArgs: [],
    mcpCommand: "sprout-dev-mcp",
  };
}

export async function resolveSetupChannel(
  agent: ManagedAgent,
): Promise<Channel> {
  return openDm({ pubkeys: [agent.pubkey] });
}

export function isAgentRunning(agent: Pick<ManagedAgent, "status">) {
  return agent.status === "running" || agent.status === "deployed";
}

const PLANT_ASSISTANT_NAMES = [
  "Spriggles",
  "Budley",
  "Moss Boss",
  "Rooty Tooty",
  "Fernsworth",
  "Tiny Tendril",
  "Captain Clover",
  "Professor Peapod",
];

export function pickPlantAssistantName() {
  return PLANT_ASSISTANT_NAMES[
    Math.floor(Math.random() * PLANT_ASSISTANT_NAMES.length)
  ];
}

export function buildInitialMessages(
  displayName: string,
  assistantName: string,
): LocalMessage[] {
  const userName = displayName.trim();
  return [
    {
      id: "boot",
      role: "assistant",
      text: `Booting ${assistantName}...`,
    },
    {
      id: "intro",
      role: "assistant",
      text: userName
        ? `Hi ${userName}. I am ${assistantName}. You can call me whatever you want. I am here to help set up your Sprout environment and learn how you like to work. What should we tune first?`
        : `Hi. I am ${assistantName}. You can call me whatever you want. I am here to help set up your Sprout environment and learn how you like to work. What should we tune first?`,
    },
  ];
}

export function parseRequestedAssistantName(text: string) {
  const match = text.match(
    /\b(?:call\s+you|change\s+your\s+name\s+to|your\s+name\s+is|name\s+you)\s+(.+?)(?:[.!?]+)?$/i,
  );
  const requestedName = match?.[1]?.trim();
  if (!requestedName) {
    return null;
  }
  return (
    requestedName
      .replace(/^["']|["']$/g, "")
      .slice(0, 48)
      .trim() || null
  );
}

export function buildAssistantAcknowledgement(
  answer: AssistantProfileAnswer,
  visibleText: string,
  assistantName: string,
) {
  const requestedName = parseRequestedAssistantName(visibleText);
  if (requestedName) {
    return `${requestedName}. Got it. I will answer to that while we set up your Sprout environment.`;
  }
  if (/\bwhat(?:'s| is)\s+your\s+name\b/i.test(visibleText)) {
    return `My name is ${assistantName}. You can change it whenever you want.`;
  }

  if (answer.kind === "primary-use") {
    if (answer.value === "messages") {
      return "Got it. I will focus on helping you keep up with messages and spot what needs attention.";
    }
    if (answer.value === "execution") {
      return "Got it. I will bias toward next steps, momentum, and helping you get work done.";
    }
    if (answer.value === "thinking") {
      return "Got it. I will help you think through ideas and make trade-offs clearer.";
    }
    return "Got it. I will adapt around what you describe.";
  }

  if (answer.kind === "working-style") {
    if (answer.value === "reactive") {
      return "Understood. I will wait for you to ask before jumping in.";
    }
    if (answer.value === "balanced") {
      return "Understood. I will nudge only when something seems worth your attention.";
    }
    return "Understood. I will be more proactive about keeping things moving.";
  }

  if (answer.kind === "response-style") {
    if (answer.value === "brief") {
      return "Done. I will keep responses short and direct.";
    }
    if (answer.value === "thoughtful") {
      return "Done. I will add context when it helps you make a better call.";
    }
    return "Done. I will keep things casual and collaborative.";
  }

  if (answer.kind === "boundary") {
    return "Understood. I will ask before taking action for you.";
  }

  return "Got it. I added that to how I should work with you.";
}
