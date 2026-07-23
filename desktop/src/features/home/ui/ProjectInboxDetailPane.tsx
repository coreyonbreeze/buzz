import { ArrowLeft, ExternalLink } from "lucide-react";
import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import type { ProjectInboxWorkItem } from "@/features/home/lib/projectInbox";
import { ProjectIssueDetail } from "@/features/projects/ui/ProjectIssuesPanel";
import {
  ProjectPullRequestDetail,
  PullRequestDetailHeader,
  PullRequestMetaRail,
} from "@/features/projects/ui/ProjectPullRequestsPanel";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { openProjectMergeRecoveryTerminal } from "@/shared/api/projectGit";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { Button } from "@/shared/ui/button";

type ProjectInboxDetailPaneProps = {
  isSinglePanelView?: boolean;
  onBack?: () => void;
  onOpenProject: () => void;
  profiles?: UserProfileLookup;
  workItem: ProjectInboxWorkItem;
};

/** Renders a canonical Buzz Git work item with its existing project actions. */
export function ProjectInboxDetailPane({
  isSinglePanelView = false,
  onBack,
  onOpenProject,
  profiles,
  workItem,
}: ProjectInboxDetailPaneProps) {
  const { activeCommunity } = useCommunities();
  const handleOpenMergeRecoveryTerminal = React.useCallback(
    async (input: {
      expectedCommit: string;
      sourceBranch: string;
      sourceCloneUrl: string;
      targetBranch: string;
    }) => {
      if (workItem.type !== "pull-request") {
        throw new Error("Merge recovery is only available for pull requests.");
      }
      const targetCloneUrl = workItem.project.cloneUrls[0];
      if (!targetCloneUrl) {
        throw new Error("This project has no clone URL.");
      }
      return openProjectMergeRecoveryTerminal({
        ...input,
        projectDtag: workItem.project.dtag,
        reposDir: activeCommunity?.reposDir,
        targetCloneUrl,
      });
    },
    [activeCommunity?.reposDir, workItem],
  );

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background/60"
      data-testid="home-project-inbox-detail"
    >
      <TopChromeInsetHeader flush transparent>
        <div className="flex min-h-13 items-center justify-between gap-3 px-5 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {isSinglePanelView && onBack ? (
              <Button
                aria-label="Back to Inbox"
                onClick={onBack}
                size="icon"
                type="button"
                variant="ghost"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            ) : null}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {workItem.project.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {workItem.type === "pull-request" ? "Pull request" : "Issue"}
              </p>
            </div>
          </div>
          <Button
            className="shrink-0"
            onClick={onOpenProject}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ExternalLink className="h-4 w-4" />
            Open project
          </Button>
        </div>
      </TopChromeInsetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {workItem.type === "pull-request" ? (
          <div className="grid xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-w-0">
              <PullRequestDetailHeader
                profiles={profiles}
                pullRequest={workItem.pullRequest}
              />
              <ProjectPullRequestDetail
                mode="conversation"
                onOpenTerminal={handleOpenMergeRecoveryTerminal}
                profiles={profiles}
                project={workItem.project}
                pullRequest={workItem.pullRequest}
              />
            </div>
            <PullRequestMetaRail
              profiles={profiles}
              project={workItem.project}
              pullRequest={workItem.pullRequest}
            />
          </div>
        ) : (
          <ProjectIssueDetail
            issue={workItem.issue}
            profiles={profiles}
            project={workItem.project}
          />
        )}
      </div>
    </section>
  );
}
