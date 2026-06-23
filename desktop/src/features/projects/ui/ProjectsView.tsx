import {
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitFork,
  Plus,
  Users,
} from "lucide-react";
import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useCreateProjectMutation,
  useProjectsQuery,
} from "@/features/projects/hooks";
import { topChromeInset } from "@/shared/layout/chromeLayout";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { CreateProjectDialog } from "./CreateProjectDialog";

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      <FolderGit2 className="h-10 w-10 text-muted-foreground/40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No projects yet</p>
        <p className="text-sm text-muted-foreground">
          Create a Buzz-hosted Git project with a linked discussion channel.
        </p>
      </div>
      <Button
        className="mt-2 gap-1.5"
        data-testid="create-project-open"
        onClick={onCreate}
      >
        <Plus className="h-4 w-4" />
        Create Project
      </Button>
    </div>
  );
}

export function ProjectsView() {
  const { goProject } = useAppNavigation();
  const projectsQuery = useProjectsQuery();
  const createProjectMutation = useCreateProjectMutation();
  const [createOpen, setCreateOpen] = React.useState(false);
  const projects = projectsQuery.data ?? [];

  if (projectsQuery.isLoading) {
    return null;
  }

  if (projectsQuery.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <p className="text-sm text-red-400">Failed to load projects</p>
        <Button
          onClick={() => void projectsQuery.refetch()}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <>
        <EmptyState onCreate={() => setCreateOpen(true)} />
        <CreateProjectDialog
          isCreating={createProjectMutation.isPending}
          onCreate={async (input) => {
            const project = await createProjectMutation.mutateAsync(input);
            await goProject(project.dtag);
          }}
          onOpenChange={setCreateOpen}
          open={createOpen}
        />
      </>
    );
  }

  return (
    <>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4",
          topChromeInset.padding,
        )}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            {projects.length} {projects.length === 1 ? "project" : "projects"}
          </h2>
          <Button
            className="gap-1.5"
            data-testid="create-project-open"
            onClick={() => setCreateOpen(true)}
            size="sm"
          >
            <Plus className="h-4 w-4" />
            Create Project
          </Button>
        </div>

        <div className="space-y-2">
          {projects.map((project) => (
            <Card
              className="relative p-4 transition-colors hover:bg-muted/50"
              key={project.id}
            >
              <button
                className="absolute inset-0 rounded-lg"
                onClick={() => {
                  void goProject(project.dtag);
                }}
                type="button"
              >
                <span className="sr-only">View {project.name}</span>
              </button>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-semibold">
                      {project.name}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      {project.status}
                    </span>
                  </div>
                  {project.description ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {project.description}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground/70">
                    {project.cloneUrls.length > 0 ? (
                      <span className="flex min-w-0 items-center gap-1">
                        <GitFork className="h-4 w-4 shrink-0" />
                        <span className="truncate">{project.cloneUrls[0]}</span>
                      </span>
                    ) : null}
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-4 w-4" />
                      {project.defaultBranch}
                    </span>
                    {project.contributors.length > 0 ? (
                      <span className="flex items-center gap-1">
                        <Users className="h-4 w-4" />
                        {project.contributors.length}
                      </span>
                    ) : null}
                    {project.webUrl ? (
                      <span className="flex items-center gap-1">
                        <ExternalLink className="h-4 w-4" />
                        Web
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
      <CreateProjectDialog
        isCreating={createProjectMutation.isPending}
        onCreate={async (input) => {
          const project = await createProjectMutation.mutateAsync(input);
          await goProject(project.dtag);
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
    </>
  );
}
