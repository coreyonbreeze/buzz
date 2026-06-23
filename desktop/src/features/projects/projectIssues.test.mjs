import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitIssueTags,
  buildGitStatusTags,
  eventToProjectIssue,
  projectIssueEventsToIssues,
} from "./projectIssues.mjs";

const OWNER =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ISSUE_ID =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REPO_ADDRESS = `30617:${OWNER}:my-repo`;

function issueEvent(overrides = {}) {
  return {
    id: overrides.id ?? ISSUE_ID,
    pubkey: overrides.pubkey ?? OWNER,
    created_at: overrides.created_at ?? 100,
    kind: 1621,
    content: overrides.content ?? "Issue body",
    sig: "",
    tags: overrides.tags ?? [
      ["a", REPO_ADDRESS],
      ["p", OWNER],
      ["subject", "Fix the bug"],
      ["t", "Bug"],
    ],
  };
}

function statusEvent(kind, createdAt = 200) {
  return {
    id: `${kind}`,
    pubkey: OWNER,
    created_at: createdAt,
    kind,
    content: "",
    sig: "",
    tags: [
      ["e", ISSUE_ID, "", "root"],
      ["a", REPO_ADDRESS],
    ],
  };
}

test("projects issues derive title, labels, repo, and default backlog status", () => {
  const issue = eventToProjectIssue(issueEvent());

  assert.equal(issue.title, "Fix the bug");
  assert.equal(issue.repoAddress, REPO_ADDRESS);
  assert.deepEqual(issue.labels, ["Bug"]);
  assert.equal(issue.status, "Backlog");
});

test("latest NIP-34 status event wins", () => {
  const issue = eventToProjectIssue(issueEvent(), [
    statusEvent(1631, 150),
    statusEvent(1632, 250),
  ]);

  assert.equal(issue.status, "Closed");
  assert.equal(issue.updatedAt, 250);
});

test("labels provide intermediate workflow projection", () => {
  const issue = eventToProjectIssue(
    issueEvent({
      tags: [
        ["a", REPO_ADDRESS],
        ["p", OWNER],
        ["subject", "Review auth flow"],
        ["t", "in-review"],
      ],
    }),
  );

  assert.equal(issue.status, "In Review");
});

test("issue list sorts by latest status activity", () => {
  const first = issueEvent({ id: ISSUE_ID, created_at: 100 });
  const second = issueEvent({
    id: "d".repeat(64),
    created_at: 300,
    tags: [
      ["subject", "Second"],
      ["a", REPO_ADDRESS],
    ],
  });

  const issues = projectIssueEventsToIssues(
    [first, second],
    [statusEvent(1631, 400)],
  );

  assert.equal(issues[0].id, ISSUE_ID);
  assert.equal(issues[0].status, "Done");
});

test("builds NIP-34 issue tags", () => {
  assert.deepEqual(
    buildGitIssueTags({
      repoAddress: REPO_ADDRESS,
      repoOwner: OWNER,
      title: "Fix issue",
      labels: ["Bug", "Frontend"],
    }),
    [
      ["a", REPO_ADDRESS],
      ["p", OWNER],
      ["subject", "Fix issue"],
      ["t", "Bug"],
      ["t", "Frontend"],
    ],
  );
});

test("builds NIP-34 status root tags", () => {
  assert.deepEqual(
    buildGitStatusTags({
      issueId: ISSUE_ID,
      repoAddress: REPO_ADDRESS,
      repoOwner: OWNER,
    }),
    [
      ["e", ISSUE_ID, "", "root"],
      ["a", REPO_ADDRESS],
      ["p", OWNER],
    ],
  );
});
