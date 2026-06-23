import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import {
  KIND_GIT_ISSUE,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_OPEN,
  KIND_REPO_ANNOUNCEMENT,
  KIND_REPO_STATE,
} from "@/shared/constants/kinds";
import type { RelayEvent } from "@/shared/api/types";
import {
  createChannel,
  getIdentity,
  getRelayHttpUrl,
  signRelayEvent,
} from "@/shared/api/tauri";
import {
  buildProjectCloneUrl,
  buildRepoAnnouncementTags,
  eventToProject,
  getTag,
  projectEventsToProjects,
} from "./projectEvents.mjs";
import {
  buildGitIssueTags,
  buildGitStatusTags,
  projectIssueEventsToIssues,
  type ProjectIssue,
} from "./projectIssues.mjs";

export type Project = {
  id: string;
  dtag: string;
  name: string;
  description: string;
  cloneUrls: string[];
  webUrl: string | null;
  owner: string;
  contributors: string[];
  createdAt: number;
  projectChannelId: string | null;
  status: string;
  defaultBranch: string;
  repoAddress: string;
};

export type CreateProjectInput = {
  name: string;
  repoId: string;
  description?: string;
  visibility?: "open" | "private";
  defaultBranch?: string;
};

export type RepoState = {
  branches: Array<{ name: string; commit: string }>;
  tags: Array<{ name: string; commit: string }>;
  head: string | null;
  updatedAt: number;
};

export type CreateProjectIssueInput = {
  title: string;
  content?: string;
  labels?: string[];
};

export type ProjectIssueStatusInput = {
  issueId: string;
  status: "open" | "resolved" | "closed" | "draft";
  content?: string;
};

async function fetchProjects(): Promise<Project[]> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_REPO_ANNOUNCEMENT],
    limit: 200,
  });

  return projectEventsToProjects(events) as Project[];
}

async function fetchProject(projectId: string): Promise<Project | null> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_REPO_ANNOUNCEMENT],
    "#d": [projectId],
    limit: 10,
  });

  const projects = projectEventsToProjects(events) as Project[];
  return projects.length > 0 ? projects[0] : null;
}

function eventToRepoState(event: RelayEvent): RepoState {
  const branches: RepoState["branches"] = [];
  const tags: RepoState["tags"] = [];
  let head: string | null = null;

  for (const tag of event.tags) {
    const [name, value] = tag;
    if (!name || !value) {
      continue;
    }

    if (name.startsWith("refs/heads/")) {
      branches.push({ name: name.slice("refs/heads/".length), commit: value });
    } else if (name.startsWith("refs/tags/")) {
      tags.push({ name: name.slice("refs/tags/".length), commit: value });
    } else if (name === "HEAD") {
      head = value.replace(/^ref:\s*/, "");
    }
  }

  return {
    branches,
    tags,
    head,
    updatedAt: event.created_at,
  };
}

async function fetchRepoState(project: Project): Promise<RepoState | null> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_REPO_STATE],
    authors: [project.owner],
    "#d": [project.dtag],
    limit: 1,
  });

  return events.length > 0 ? eventToRepoState(events[0]) : null;
}

async function fetchProjectIssues(project: Project): Promise<ProjectIssue[]> {
  const [issueEvents, statusEvents] = await Promise.all([
    relayClient.fetchEvents({
      kinds: [KIND_GIT_ISSUE],
      "#a": [project.repoAddress],
      limit: 200,
    }),
    relayClient.fetchEvents({
      kinds: [
        KIND_GIT_STATUS_OPEN,
        KIND_GIT_STATUS_MERGED,
        KIND_GIT_STATUS_CLOSED,
        KIND_GIT_STATUS_DRAFT,
      ],
      "#a": [project.repoAddress],
      limit: 500,
    }),
  ]);

  return projectIssueEventsToIssues(issueEvents, statusEvents);
}

async function createProject(input: CreateProjectInput): Promise<Project> {
  const name = input.name.trim();
  const repoId = input.repoId.trim();
  const description = input.description?.trim() || undefined;
  const defaultBranch = input.defaultBranch?.trim() || "main";

  const [identity, relayHttpUrl] = await Promise.all([
    getIdentity(),
    getRelayHttpUrl(),
  ]);

  const channel = await createChannel({
    name,
    channelType: "stream",
    visibility: input.visibility ?? "open",
    description: description
      ? `Project discussion for ${name}: ${description}`
      : `Project discussion for ${name}`,
  });

  const cloneUrl = buildProjectCloneUrl({
    relayHttpUrl,
    owner: identity.pubkey,
    repoId,
  });

  const tags = buildRepoAnnouncementTags({
    repoId,
    name,
    description,
    cloneUrls: [cloneUrl],
    projectChannelId: channel.id,
    status: "active",
    defaultBranch,
  });
  const event = await signRelayEvent({
    kind: KIND_REPO_ANNOUNCEMENT,
    content: description ?? "",
    tags,
  });
  const published = await relayClient.publishEvent(
    event,
    "Timed out while creating the project.",
    "Failed to create the project.",
  );

  return eventToProject(published) as Project;
}

export const projectsQueryKey = ["projects"] as const;

export function useProjectsQuery() {
  return useQuery({
    queryKey: projectsQueryKey,
    queryFn: fetchProjects,
    staleTime: 60_000,
  });
}

export function useProjectQuery(projectId: string) {
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId),
    staleTime: 60_000,
  });
}

export function useRepoStateQuery(project: Project | null | undefined) {
  return useQuery({
    enabled: Boolean(project),
    queryKey: ["project", project?.id ?? "none", "repo-state"],
    queryFn: () => {
      if (!project) {
        throw new Error("No project selected.");
      }
      return fetchRepoState(project);
    },
    staleTime: 30_000,
  });
}

export function useProjectIssuesQuery(project: Project | null | undefined) {
  return useQuery({
    enabled: Boolean(project),
    queryKey: ["project", project?.id ?? "none", "issues"],
    queryFn: () => {
      if (!project) {
        throw new Error("No project selected.");
      }
      return fetchProjectIssues(project);
    },
    staleTime: 30_000,
  });
}

export function useCreateProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createProject,
    onSuccess: (createdProject) => {
      queryClient.setQueryData<Project[]>(projectsQueryKey, (current = []) => {
        const withoutProject = current.filter(
          (project) => project.id !== createdProject.id,
        );
        return [createdProject, ...withoutProject].sort(
          (left, right) => right.createdAt - left.createdAt,
        );
      });
      queryClient.setQueryData(
        ["project", createdProject.dtag],
        createdProject,
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    },
  });
}

export function useCreateProjectIssueMutation(
  project: Project | null | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateProjectIssueInput) => {
      if (!project) {
        throw new Error("No project selected.");
      }
      const tags = buildGitIssueTags({
        repoAddress: project.repoAddress,
        repoOwner: project.owner,
        title: input.title,
        labels: input.labels ?? [],
      });
      const event = await signRelayEvent({
        kind: KIND_GIT_ISSUE,
        content: input.content?.trim() ?? "",
        tags,
      });
      return relayClient.publishEvent(
        event,
        "Timed out while creating the issue.",
        "Failed to create the issue.",
      );
    },
    onSettled: async () => {
      if (!project) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: ["project", project.id, "issues"],
      });
    },
  });
}

function statusToKind(status: ProjectIssueStatusInput["status"]) {
  switch (status) {
    case "resolved":
      return KIND_GIT_STATUS_MERGED;
    case "closed":
      return KIND_GIT_STATUS_CLOSED;
    case "draft":
      return KIND_GIT_STATUS_DRAFT;
    default:
      return KIND_GIT_STATUS_OPEN;
  }
}

export function useSetProjectIssueStatusMutation(
  project: Project | null | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ProjectIssueStatusInput) => {
      if (!project) {
        throw new Error("No project selected.");
      }
      const tags = buildGitStatusTags({
        issueId: input.issueId,
        repoAddress: project.repoAddress,
        repoOwner: project.owner,
      });
      const event = await signRelayEvent({
        kind: statusToKind(input.status),
        content: input.content?.trim() ?? "",
        tags,
      });
      return relayClient.publishEvent(
        event,
        "Timed out while updating the issue.",
        "Failed to update the issue.",
      );
    },
    onSettled: async () => {
      if (!project) {
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: ["project", project.id, "issues"],
      });
    },
  });
}

export function getProjectDtag(event: RelayEvent): string | undefined {
  return getTag(event, "d");
}
