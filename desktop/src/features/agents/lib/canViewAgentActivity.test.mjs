import assert from "node:assert/strict";
import test from "node:test";

import { resolveCanViewAgentActivity } from "./canViewAgentActivity.ts";

test("resolveCanViewAgentActivity returns true when relay confirms ownership", () => {
  const result = resolveCanViewAgentActivity({
    relayOwnership: {
      agentPubkey: "aa".repeat(32),
      ownerPubkey: "bb".repeat(32),
      isOwner: true,
    },
    isManagedAgent: false,
    isOwnershipLoading: false,
    isOwnershipError: false,
    isManagedLoading: false,
  });

  assert.equal(result.canView, true);
  assert.equal(result.isLoading, false);
});

test("resolveCanViewAgentActivity returns false when relay denies ownership", () => {
  const result = resolveCanViewAgentActivity({
    relayOwnership: {
      agentPubkey: "aa".repeat(32),
      ownerPubkey: "bb".repeat(32),
      isOwner: false,
    },
    isManagedAgent: true,
    isOwnershipLoading: false,
    isOwnershipError: false,
    isManagedLoading: false,
  });

  assert.equal(result.canView, false);
  assert.equal(result.isLoading, false);
});

test("resolveCanViewAgentActivity optimistically allows locally managed agents while loading", () => {
  const result = resolveCanViewAgentActivity({
    relayOwnership: undefined,
    isManagedAgent: true,
    isOwnershipLoading: true,
    isOwnershipError: false,
    isManagedLoading: false,
  });

  assert.equal(result.canView, true);
  assert.equal(result.isLoading, true);
});

test("resolveCanViewAgentActivity stays closed for non-managed agents while loading", () => {
  const result = resolveCanViewAgentActivity({
    relayOwnership: undefined,
    isManagedAgent: false,
    isOwnershipLoading: true,
    isOwnershipError: false,
    isManagedLoading: false,
  });

  assert.equal(result.canView, false);
  assert.equal(result.isLoading, true);
});

test("resolveCanViewAgentActivity keeps locally managed agents visible when ownership lookup errors", () => {
  const result = resolveCanViewAgentActivity({
    relayOwnership: undefined,
    isManagedAgent: true,
    isOwnershipLoading: false,
    isOwnershipError: true,
    isManagedLoading: false,
  });

  assert.equal(result.canView, true);
  assert.equal(result.isLoading, false);
});

test("resolveCanViewAgentActivity stays closed for non-managed agents when ownership lookup errors", () => {
  const result = resolveCanViewAgentActivity({
    relayOwnership: undefined,
    isManagedAgent: false,
    isOwnershipLoading: false,
    isOwnershipError: true,
    isManagedLoading: false,
  });

  assert.equal(result.canView, false);
  assert.equal(result.isLoading, false);
});
