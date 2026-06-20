import assert from "node:assert/strict";
import test from "node:test";

import { computeThreadBadgeCounts } from "./threadBadgeCounts.ts";
import { buildDirectRepliesByParentId } from "./subtreeCreatedAt.ts";

// Minimal TimelineMessage shape the badge counter reads: id, parentId,
// createdAt, pubkey. createdAt defaults high so replies count unread against a
// null frontier unless a test sets it lower.
const msg = (id, parentId, createdAt = 100, pubkey = "author") => ({
  id,
  parentId,
  createdAt,
  pubkey,
});

const countAll = () => true;
const counts = (messages, frontiers, isNotified = countAll, currentPubkey) =>
  computeThreadBadgeCounts(
    messages,
    buildDirectRepliesByParentId(messages),
    frontiers,
    isNotified,
    currentPubkey,
  );

test("computeThreadBadgeCounts_directRepliesOnly_countsEach", () => {
  const messages = [msg("root", null), msg("a", "root"), msg("b", "root")];
  assert.equal(counts(messages, undefined).get("root"), 2);
});

test("computeThreadBadgeCounts_nestedReply_countsTowardRoot", () => {
  // root -> a -> b: b is a reply-to-a-reply. Pre-fix it lived under a's key
  // and was never tallied toward root; the subtree walk must count it.
  const messages = [msg("root", null), msg("a", "root"), msg("b", "a")];
  assert.equal(counts(messages, undefined).get("root"), 2);
});

test("computeThreadBadgeCounts_deepChain_countsWholeSubtree", () => {
  // root -> a -> b -> c -> d: every descendant tallies toward the root.
  const messages = [
    msg("root", null),
    msg("a", "root"),
    msg("b", "a"),
    msg("c", "b"),
    msg("d", "c"),
  ];
  assert.equal(counts(messages, undefined).get("root"), 4);
});

test("computeThreadBadgeCounts_branchingSubtree_countsAllBranches", () => {
  // root -> a -> {b, c}; root -> d. Four descendants across two branches.
  const messages = [
    msg("root", null),
    msg("a", "root"),
    msg("b", "a"),
    msg("c", "a"),
    msg("d", "root"),
  ];
  assert.equal(counts(messages, undefined).get("root"), 4);
});

test("computeThreadBadgeCounts_rootWithNoReplies_omitted", () => {
  const messages = [msg("root", null)];
  assert.equal(counts(messages, undefined).has("root"), false);
});

test("computeThreadBadgeCounts_notNotified_omitted", () => {
  const messages = [msg("root", null), msg("a", "root"), msg("b", "a")];
  assert.equal(counts(messages, undefined, () => false).size, 0);
});

test("computeThreadBadgeCounts_frontierCoversNestedReplies_excludesRead", () => {
  // Frontier 150: a (100) is read, only nested b (200) remains unread.
  const messages = [
    msg("root", null),
    msg("a", "root", 100),
    msg("b", "a", 200),
  ];
  const frontiers = new Map([["root", 150]]);
  assert.equal(counts(messages, frontiers).get("root"), 1);
});

test("computeThreadBadgeCounts_frontierCoversWholeSubtree_omitsRoot", () => {
  const messages = [
    msg("root", null),
    msg("a", "root", 100),
    msg("b", "a", 120),
  ];
  const frontiers = new Map([["root", 150]]);
  assert.equal(counts(messages, frontiers).has("root"), false);
});

test("computeThreadBadgeCounts_selfAuthoredNestedReply_notCounted", () => {
  // A nested reply authored by the current user never counts as unread.
  const messages = [
    msg("root", null),
    msg("a", "root", 100, "other"),
    msg("b", "a", 200, "ME"),
  ];
  assert.equal(counts(messages, undefined, countAll, "me").get("root"), 1);
});

test("computeThreadBadgeCounts_multipleRoots_eachCountsOwnSubtree", () => {
  const messages = [
    msg("root1", null),
    msg("a", "root1"),
    msg("b", "a"),
    msg("root2", null),
    msg("c", "root2"),
  ];
  const result = counts(messages, undefined);
  assert.equal(result.get("root1"), 2);
  assert.equal(result.get("root2"), 1);
});

// --- LP4 Case 1 demonstration: orphaned subtree from a broken parent chain ---
//
// The roll-up keys each reply under its immediate `parentId` and walks the
// adjacency map down from true roots (collectSubtreeReplies). A descendant is
// only reached if its FULL parent chain is present in the loaded timeline.
// Pagination / load windows can drop an intermediate ancestor, which severs the
// chain: the deep reply still sits under its (absent) parent's key, but that key
// is never visited from any root's bucket, so it is never tallied at the root.
//
// These two tests pin the exact trigger — a missing middle ancestor — and pass
// against TODAY'S behavior. The first DOCUMENTS THE DEFECT (root undercounts /
// shows no badge); the second is the contrasting full-chain control.

test("computeThreadBadgeCounts_brokenParentChain_orphanedReplyMissesRoot_DEFECT", () => {
  // Full thread is root -> a -> b -> c, but intermediate ancestor `b` is NOT in
  // the loaded array (unloaded by the timeline window). `c` is genuinely unread.
  // DEFECT: `c` is keyed under "b", and "b" is never reached from root's bucket
  // (root -> [a], a -> [] because b is absent), so `c` is orphaned. The root
  // badge counts only `a` (1), NOT the 2 it would show with the chain intact.
  // With the bug, opening the thread shows `c` unread at its level while the
  // channel-root summary undercounts it.
  const loaded = [
    msg("root", null),
    msg("a", "root"),
    // msg("b", "a") — intentionally absent: unloaded intermediate ancestor.
    msg("c", "b"),
  ];
  assert.equal(counts(loaded, undefined).get("root"), 1);
});

test("computeThreadBadgeCounts_brokenParentChain_orphanedSoleReply_noBadge_DEFECT", () => {
  // Sharper form: root's ONLY unread content is the deep reply `c`, and its
  // intermediate ancestor `b` is unloaded. DEFECT: root shows NO badge at all
  // (count absent) even though `c` is genuinely unread, because the orphaned
  // `c` is unreachable from root and root then has zero tallied replies.
  const loaded = [
    msg("root", null),
    // msg("b", "root") — intentionally absent: unloaded intermediate ancestor.
    msg("c", "b"),
  ];
  assert.equal(counts(loaded, undefined).has("root"), false);
});

test("computeThreadBadgeCounts_fullParentChain_orphanRollsUp_DESIRED", () => {
  // Control: the SAME thread with the intermediate ancestor `b` present. The
  // chain root -> a -> b -> c is intact, so every descendant rolls up and the
  // root badge correctly counts 3. This is the behavior the broken-chain cases
  // above SHOULD produce once the deep reply's ancestors are guaranteed loaded.
  const loaded = [
    msg("root", null),
    msg("a", "root"),
    msg("b", "a"),
    msg("c", "b"),
  ];
  assert.equal(counts(loaded, undefined).get("root"), 3);
});
