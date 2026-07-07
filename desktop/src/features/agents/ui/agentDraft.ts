import type { ParsedPersonaPreview } from "@/shared/api/tauriPersonas";
import type { AgentTemplate, ManagedAgent } from "@/shared/api/types";

/**
 * A prefilled starting point for the Create Agent dialog. Drafts come from
 * the wizard's start step (blank / template / import) or from duplicating an
 * existing agent. Submitting the dialog creates a managed agent directly —
 * no persona record is involved.
 */
export type AgentDraft = {
  title: string;
  description: string;
  submitLabel: string;
  name: string;
  avatarUrl: string;
  systemPrompt: string;
  /** Preferred ACP runtime id (e.g. "goose"). Hint only — the dialog falls back when unavailable. */
  runtime: string | null;
  model: string | null;
  provider: string | null;
  envVars: Record<string, string>;
};

type ImportedAvatarPreview = Pick<
  ParsedPersonaPreview,
  "avatarDataUrl" | "avatarRef"
>;

function isSafeImportedAvatarRef(
  ref: string | null | undefined,
): ref is string {
  const trimmed = ref?.trim();
  if (!trimmed) return false;

  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      (parsed.protocol === "data:" && trimmed.startsWith("data:image/"))
    );
  } catch {
    return false;
  }
}

export function importedAvatarUrl(preview: ImportedAvatarPreview) {
  if (preview.avatarDataUrl) return preview.avatarDataUrl;
  return isSafeImportedAvatarRef(preview.avatarRef) ? preview.avatarRef : "";
}

export function blankAgentDraft(): AgentDraft {
  return {
    title: "Create agent",
    description: "Set up a new agent and start it in this workspace.",
    submitLabel: "Create agent",
    name: "",
    avatarUrl: "",
    systemPrompt: "",
    runtime: null,
    model: null,
    provider: null,
    envVars: {},
  };
}

export function templateAgentDraft(template: AgentTemplate): AgentDraft {
  return {
    title: `New ${template.displayName}`,
    // Intentionally blank: the template name in the title says enough, and
    // the dialog hides the description line when it's empty.
    description: "",
    submitLabel: "Create agent",
    name: template.displayName,
    avatarUrl: template.avatarUrl ?? "",
    systemPrompt: template.systemPrompt,
    runtime: template.runtime,
    model: template.model,
    provider: template.provider,
    envVars: {},
  };
}

export function importAgentDraft(preview: ParsedPersonaPreview): AgentDraft {
  return {
    title: `Import ${preview.displayName}`,
    description: "Review and create this imported agent.",
    submitLabel: "Create agent",
    name: preview.displayName,
    avatarUrl: importedAvatarUrl(preview),
    systemPrompt: preview.systemPrompt,
    runtime: preview.runtime,
    model: preview.model,
    provider: preview.provider,
    envVars: {},
  };
}

export function duplicateAgentDraft(agent: ManagedAgent): AgentDraft {
  return {
    title: `Duplicate ${agent.name}`,
    description:
      "Create a new agent by copying this one and adjusting it as needed.",
    submitLabel: "Create agent",
    name: `${agent.name} copy`,
    avatarUrl: agent.avatarUrl ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    // agentCommand is the resolved/effective harness command; the dialog
    // matches it against the runtime catalog by command.
    runtime: agent.agentCommand || null,
    model: agent.model,
    provider: agent.provider,
    // Carry env vars into the duplicate. Without this, a duplicated agent
    // that relies on an API key in envVars would silently fail at spawn
    // until the user re-entered every credential. The values are visible in
    // the dialog and can be cleared for a blank slate.
    envVars: { ...agent.envVars },
  };
}
