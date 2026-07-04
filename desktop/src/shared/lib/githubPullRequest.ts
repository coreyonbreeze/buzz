import { useQuery } from "@tanstack/react-query";

import { invokeTauri } from "@/shared/api/tauri";

export type GithubPullRequestInfo = {
  title: string;
  /** GitHub PR state: `open` or `closed` (merged PRs report `closed`). */
  state: string;
  merged: boolean;
  draft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
};

export type GithubPullRequestRef = {
  owner: string;
  repo: string;
  number: number;
};

/** Parse `github.com/{owner}/{repo}/pull/{number}` out of a PR link. */
export function parseGithubPullRequestRef(
  href: string,
): GithubPullRequestRef | null {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase().replace(/^www\./, "") !== "github.com") {
    return null;
  }
  const [owner, repo, resource, number] = parsed.pathname
    .split("/")
    .filter(Boolean);
  if (!owner || !repo || resource !== "pull" || !/^\d+$/.test(number ?? "")) {
    return null;
  }
  return { owner, repo, number: Number(number) };
}

export function githubPullRequestStatus(info: GithubPullRequestInfo) {
  if (info.merged) return "merged" as const;
  if (info.state === "closed") return "closed" as const;
  if (info.draft) return "draft" as const;
  return "open" as const;
}

export function useGithubPullRequestQuery(ref: GithubPullRequestRef | null) {
  return useQuery({
    enabled: ref !== null,
    queryKey: [
      "github-pull-request",
      ref?.owner ?? "",
      ref?.repo ?? "",
      ref?.number ?? 0,
    ],
    queryFn: async () =>
      (await invokeTauri<GithubPullRequestInfo | null>(
        "fetch_github_pull_request",
        {
          owner: ref?.owner ?? "",
          repo: ref?.repo ?? "",
          number: ref?.number ?? 0,
        },
      )) ?? null,
    staleTime: 60_000,
    retry: 1,
  });
}
