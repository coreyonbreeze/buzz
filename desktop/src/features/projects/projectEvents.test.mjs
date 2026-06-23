import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectCloneUrl,
  buildRepoAnnouncementTags,
  eventToProject,
  isValidRepoId,
  normalizeProjectSlug,
  projectEventsToProjects,
} from "./projectEvents.mjs";

const OWNER =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function repoEvent(overrides = {}) {
  return {
    id: overrides.id ?? "event-id",
    pubkey: overrides.pubkey ?? OWNER,
    created_at: overrides.created_at ?? 123,
    kind: overrides.kind ?? 30617,
    content: overrides.content ?? "",
    sig: "",
    tags: overrides.tags ?? [
      ["d", "my-repo"],
      ["name", "My Repo"],
    ],
  };
}

test("validates repo ids with relay-compatible constraints", () => {
  assert.equal(isValidRepoId("my-repo_1.2"), true);
  assert.equal(isValidRepoId(""), false);
  assert.equal(isValidRepoId(".hidden"), false);
  assert.equal(isValidRepoId("some..repo"), false);
  assert.equal(isValidRepoId("bad repo"), false);
  assert.equal(isValidRepoId("a".repeat(65)), false);
});

test("normalizes project names into repo slugs", () => {
  assert.equal(
    normalizeProjectSlug(" Projects With Git! "),
    "projects-with-git",
  );
  assert.equal(normalizeProjectSlug("...Alpha__Beta..."), "alpha__beta");
  assert.equal(normalizeProjectSlug("A".repeat(80)), "a".repeat(64));
});

test("builds canonical Buzz git clone URL", () => {
  assert.equal(
    buildProjectCloneUrl({
      relayHttpUrl: "https://relay.example.com/",
      owner: OWNER,
      repoId: "my-repo",
    }),
    `https://relay.example.com/git/${OWNER}/my-repo`,
  );
});

test("builds repo announcement tags with project channel metadata", () => {
  const tags = buildRepoAnnouncementTags({
    repoId: "my-repo",
    name: "My Repo",
    description: "Outcome-focused project",
    cloneUrls: [`https://relay.example.com/git/${OWNER}/my-repo`],
    projectChannelId: "8e2b99ba-8a1c-4a3a-9714-b4b824d93810",
    status: "active",
    defaultBranch: "main",
    contributors: [OWNER],
  });

  assert.deepEqual(tags[0], ["d", "my-repo"]);
  assert.ok(tags.some((tag) => tag[0] === "h" && tag[1].startsWith("8e2b")));
  assert.ok(tags.some((tag) => tag[0] === "status" && tag[1] === "active"));
  assert.ok(
    tags.some((tag) => tag[0] === "default-branch" && tag[1] === "main"),
  );
  assert.ok(tags.some((tag) => tag[0] === "p" && tag[1] === OWNER));
});

test("projects projection carries repo, Git, and discussion metadata", () => {
  const project = eventToProject(
    repoEvent({
      tags: [
        ["d", "my-repo"],
        ["name", "My Repo"],
        ["description", "A test repo"],
        ["clone", "https://relay.example.com/git/owner/my-repo"],
        ["h", "project-channel"],
        ["status", "paused"],
        ["default-branch", "trunk"],
        ["p", OWNER],
      ],
    }),
  );

  assert.equal(project.id, `${OWNER}:my-repo`);
  assert.equal(project.projectChannelId, "project-channel");
  assert.equal(project.status, "paused");
  assert.equal(project.defaultBranch, "trunk");
  assert.equal(project.repoAddress, `30617:${OWNER}:my-repo`);
  assert.deepEqual(project.contributors, [OWNER]);
});

test("dedups project events by owner, kind, and d-tag", () => {
  const older = repoEvent({ id: "old", created_at: 1 });
  const newer = repoEvent({ id: "new", created_at: 2 });
  const projects = projectEventsToProjects([older, newer]);

  assert.equal(projects.length, 1);
  assert.equal(projects[0].createdAt, 2);
});
