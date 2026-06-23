import {
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  CircleDot,
  Copy,
  ExternalLink,
  FileDiff,
  FolderGit2,
  GitBranch,
  GitFork,
  ListTodo,
  MessageSquare,
  Users,
} from "lucide-react";
import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  type Project,
  type ProjectIssueStatusInput,
  useCreateProjectIssueMutation,
  useProjectIssuesQuery,
  useProjectQuery,
  useRepoStateQuery,
  useSetProjectIssueStatusMutation,
} from "@/features/projects/hooks";
import type { ProjectIssue } from "@/features/projects/projectIssues.mjs";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { topChromeInset } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";
import { isSafeUrl } from "@/shared/lib/url";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Textarea } from "@/shared/ui/textarea";
import { UserAvatar } from "@/shared/ui/UserAvatar";

type RepoStateData = ReturnType<typeof useRepoStateQuery>["data"];

function CloneUrlRow({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  }, [url]);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <GitFork className="h-4 w-4 shrink-0 text-muted-foreground" />
      <code className="min-w-0 flex-1 truncate text-xs">{url}</code>
      <Button
        className="h-6 w-6 shrink-0"
        onClick={handleCopy}
        size="icon"
        variant="ghost"
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

function ProjectStatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
}) {
  return (
    <Card className="flex items-center gap-3 p-3">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="truncate text-sm font-semibold text-foreground">
          {value}
        </p>
      </div>
    </Card>
  );
}

function ProjectIssueComposer({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (input: {
    title: string;
    content?: string;
    labels?: string[];
  }) => Promise<void>;
}) {
  const [title, setTitle] = React.useState("");
  const [content, setContent] = React.useState("");
  const [labels, setLabels] = React.useState("Feature");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;
    setErrorMessage(null);
    try {
      await onCreate({
        title: title.trim(),
        content: content.trim() || undefined,
        labels: labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
      });
      setTitle("");
      setContent("");
      setLabels("Feature");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create issue.",
      );
    }
  }

  return (
    <form
      className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3"
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <input
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-hidden placeholder:text-muted-foreground focus:border-muted-foreground/60"
        disabled={disabled}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Add issue title"
        value={title}
      />
      <Textarea
        className="min-h-20 resize-none text-sm"
        disabled={disabled}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Describe the work, acceptance criteria, or context for agents."
        value={content}
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-hidden placeholder:text-muted-foreground focus:border-muted-foreground/60"
          disabled={disabled}
          onChange={(event) => setLabels(event.target.value)}
          placeholder="Labels, comma separated"
          value={labels}
        />
        <Button disabled={disabled || !title.trim()} type="submit">
          {disabled ? "Creating..." : "Create issue"}
        </Button>
      </div>
      {errorMessage ? (
        <p className="text-sm text-destructive">{errorMessage}</p>
      ) : null}
    </form>
  );
}

function IssueStatusButton({
  issue,
  status,
  children,
  onSetStatus,
}: {
  issue: ProjectIssue;
  status: ProjectIssueStatusInput["status"];
  children: React.ReactNode;
  onSetStatus: (input: ProjectIssueStatusInput) => Promise<void>;
}) {
  return (
    <Button
      className="h-7 px-2 text-xs"
      onClick={() => {
        void onSetStatus({ issueId: issue.id, status });
      }}
      size="sm"
      type="button"
      variant="ghost"
    >
      {children}
    </Button>
  );
}

function ProjectIssuesSection({
  issues,
  isLoading,
  onCreateIssue,
  creatingIssue,
  onSetStatus,
}: {
  issues: ProjectIssue[];
  isLoading: boolean;
  onCreateIssue: (input: {
    title: string;
    content?: string;
    labels?: string[];
  }) => Promise<void>;
  creatingIssue: boolean;
  onSetStatus: (input: ProjectIssueStatusInput) => Promise<void>;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <ListTodo className="h-4 w-4" />
          Issues
        </h3>
        <span className="text-xs text-muted-foreground">
          {issues.length} work item{issues.length === 1 ? "" : "s"}
        </span>
      </div>
      <ProjectIssueComposer disabled={creatingIssue} onCreate={onCreateIssue} />
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading issues...</p>
      ) : issues.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">
          No issues yet. Create a small, action-oriented issue to give humans
          and agents a clear unit of work.
        </Card>
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <Card className="space-y-2 p-3" key={issue.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {issue.title}
                  </p>
                  {issue.content ? (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {issue.content}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  {issue.status}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {issue.labels.map((label) => (
                  <span
                    className="rounded-md border border-border/70 px-1.5 py-0.5 text-2xs text-muted-foreground"
                    key={label}
                  >
                    {label}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
                <IssueStatusButton
                  issue={issue}
                  onSetStatus={onSetStatus}
                  status="open"
                >
                  Open
                </IssueStatusButton>
                <IssueStatusButton
                  issue={issue}
                  onSetStatus={onSetStatus}
                  status="draft"
                >
                  Triage
                </IssueStatusButton>
                <IssueStatusButton
                  issue={issue}
                  onSetStatus={onSetStatus}
                  status="resolved"
                >
                  Done
                </IssueStatusButton>
                <IssueStatusButton
                  issue={issue}
                  onSetStatus={onSetStatus}
                  status="closed"
                >
                  Close
                </IssueStatusButton>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function CodeStateSection({
  project,
  repoState,
  isLoading,
}: {
  project: Project;
  repoState: RepoStateData;
  isLoading: boolean;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <GitBranch className="h-4 w-4" />
        Code
      </h3>
      {isLoading ? (
        <Card className="p-4 text-sm text-muted-foreground">
          Loading repository state...
        </Card>
      ) : repoState ? (
        <Card className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <ProjectStatCard
              icon={GitBranch}
              label="Default"
              value={project.defaultBranch}
            />
            <ProjectStatCard
              icon={CircleDot}
              label="Branches"
              value={repoState.branches.length}
            />
            <ProjectStatCard
              icon={CheckCircle2}
              label="Tags"
              value={repoState.tags.length}
            />
          </div>
          {repoState.branches.length > 0 ? (
            <div className="space-y-1">
              {repoState.branches.slice(0, 6).map((branch) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-1.5 text-sm"
                  key={branch.name}
                >
                  <span className="min-w-0 truncate font-mono">
                    {branch.name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {branch.commit.slice(0, 8)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : (
        <Card className="p-4 text-sm text-muted-foreground">
          No commits have been pushed yet. Clone this repo, push the first
          branch, and Buzz will publish the repo state here.
        </Card>
      )}
    </section>
  );
}

type ProjectDetailScreenProps = {
  projectId: string;
};

export function ProjectDetailScreen({ projectId }: ProjectDetailScreenProps) {
  const { goChannel, goProjects } = useAppNavigation();
  const projectQuery = useProjectQuery(projectId);
  const project = projectQuery.data;
  const repoStateQuery = useRepoStateQuery(project);
  const issuesQuery = useProjectIssuesQuery(project);
  const createIssueMutation = useCreateProjectIssueMutation(project);
  const setIssueStatusMutation = useSetProjectIssueStatusMutation(project);

  const allPubkeys = React.useMemo(
    () =>
      project ? [project.owner, ...project.contributors].filter(Boolean) : [],
    [project],
  );
  const profilesQuery = useUsersBatchQuery(allPubkeys);
  const profiles = profilesQuery.data?.profiles;

  if (projectQuery.isLoading) {
    return null;
  }

  if (projectQuery.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
        <FolderGit2 className="h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm text-red-400">Failed to load project</p>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void projectQuery.refetch()}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
          <Button
            onClick={() => {
              void goProjects();
            }}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to Projects
          </Button>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
        <FolderGit2 className="h-10 w-10 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          This project could not be found.
        </p>
        <Button
          onClick={() => {
            void goProjects();
          }}
          size="sm"
          variant="outline"
        >
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Back to Projects
        </Button>
      </div>
    );
  }

  const createdDate = new Date(project.createdAt * 1_000).toLocaleDateString(
    undefined,
    { year: "numeric", month: "long", day: "numeric" },
  );
  const issues = issuesQuery.data ?? [];

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4",
          topChromeInset.padding,
        )}
      >
        <div className="mb-4">
          <Button
            className="gap-1.5 text-muted-foreground"
            onClick={() => {
              void goProjects();
            }}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Projects
          </Button>
        </div>

        <div className="mx-auto w-full max-w-4xl space-y-6">
          <section className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <FolderGit2 className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-lg font-semibold">{project.name}</h2>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    {project.status}
                  </span>
                </div>
                {project.description ? (
                  <p className="text-sm text-muted-foreground">
                    {project.description}
                  </p>
                ) : null}
              </div>
              {project.projectChannelId ? (
                <Button
                  className="shrink-0 gap-1.5"
                  onClick={() => {
                    if (project.projectChannelId) {
                      void goChannel(project.projectChannelId);
                    }
                  }}
                  size="sm"
                  variant="outline"
                >
                  <MessageSquare className="h-4 w-4" />
                  Open Discussion
                </Button>
              ) : null}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <ProjectStatCard
                icon={GitBranch}
                label="Branch"
                value={project.defaultBranch}
              />
              <ProjectStatCard
                icon={ListTodo}
                label="Issues"
                value={issues.length}
              />
              <ProjectStatCard
                icon={Users}
                label="Contributors"
                value={project.contributors.length}
              />
              <ProjectStatCard
                icon={MessageSquare}
                label="Discussion"
                value={project.projectChannelId ? "Linked" : "Not linked"}
              />
            </div>
          </section>

          {project.cloneUrls.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Clone
              </h3>
              <div className="space-y-1.5">
                {project.cloneUrls.map((url) => (
                  <CloneUrlRow key={url} url={url} />
                ))}
              </div>
            </section>
          ) : null}

          <CodeStateSection
            isLoading={repoStateQuery.isLoading}
            project={project}
            repoState={repoStateQuery.data}
          />

          <ProjectIssuesSection
            creatingIssue={createIssueMutation.isPending}
            isLoading={issuesQuery.isLoading}
            issues={issues}
            onCreateIssue={async (input) => {
              await createIssueMutation.mutateAsync(input);
            }}
            onSetStatus={async (input) => {
              await setIssueStatusMutation.mutateAsync(input);
            }}
          />

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Card className="space-y-2 p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Bot className="h-4 w-4" />
                Agent Work
              </h3>
              <p className="text-sm text-muted-foreground">
                Start agents from project issues so their summaries, branches,
                patches, and review notes stay attached to this project.
              </p>
            </Card>
            <Card className="space-y-2 p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <FileDiff className="h-4 w-4" />
                Code Discussion
              </h3>
              <p className="text-sm text-muted-foreground">
                Diff messages and NIP-34 patches render in the linked discussion
                channel, giving humans and agents a shared review surface.
              </p>
            </Card>
          </section>

          {project.webUrl && isSafeUrl(project.webUrl) ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Web
              </h3>
              <a
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                href={project.webUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink className="h-4 w-4" />
                {project.webUrl}
              </a>
            </section>
          ) : null}

          {project.contributors.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Users className="h-4 w-4" />
                  Contributors ({project.contributors.length})
                </span>
              </h3>
              <div className="space-y-1.5">
                {project.contributors.map((pubkey) => {
                  const label = resolveUserLabel({ pubkey, profiles });
                  const avatarUrl =
                    profiles?.[pubkey.toLowerCase()]?.avatarUrl ?? null;
                  return (
                    <div
                      className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-1.5"
                      key={pubkey}
                    >
                      <UserAvatar
                        avatarUrl={avatarUrl}
                        displayName={label}
                        size="xs"
                      />
                      <span className="truncate text-sm text-muted-foreground">
                        {label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Details
            </h3>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>Created: {createdDate}</p>
              <p className="truncate">
                Owner: {resolveUserLabel({ pubkey: project.owner, profiles })}
              </p>
              <p className="truncate">Repo: {project.repoAddress}</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
