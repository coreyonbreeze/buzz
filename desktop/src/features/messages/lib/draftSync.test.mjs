import assert from "node:assert/strict";
import test from "node:test";

function makeLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

globalThis.window = {
  localStorage: makeLocalStorage(),
  setTimeout,
  clearTimeout,
};
Object.defineProperty(globalThis, "localStorage", {
  get: () => globalThis.window.localStorage,
});

import { DraftSyncManager } from "./draftSync.ts";
import {
  clearAllDrafts,
  initDraftStore,
  loadDraftEntry,
  saveDraftEntry,
} from "./useDrafts.ts";

const pubkey = "a".repeat(64);
const channelA = "550e8400-e29b-41d4-a716-446655440000";
const channelB = "550e8400-e29b-41d4-a716-446655440001";

function wrapped({ id, createdAt, address, channelId, content }) {
  return {
    id,
    created_at: createdAt,
    kind: 31234,
    pubkey,
    content,
    sig: "",
    tags: [
      ["d", address],
      ["h", channelId],
      ["k", "9"],
    ],
  };
}

function payload(channelId, content) {
  return JSON.stringify({
    kind: 9,
    created_at: 1,
    pubkey,
    content,
    tags: [["h", channelId]],
  });
}

function setup() {
  globalThis.window.localStorage = makeLocalStorage();
  clearAllDrafts();
  initDraftStore(pubkey, "wss://relay.example");
}

test("test_two_addresses_out_of_order_each_merge_current_head", async () => {
  setup();
  const events = [
    wrapped({
      id: "new-a",
      createdAt: 20,
      address: "address-a",
      channelId: channelA,
      content: "cipher-a",
    }),
    wrapped({
      id: "old-b",
      createdAt: 10,
      address: "address-b",
      channelId: channelB,
      content: "cipher-b",
    }),
  ];
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    decrypt: async (cipher) =>
      cipher === "cipher-a" ? payload(channelA, "A") : payload(channelB, "B"),
    deriveAddress: async (draftKey) =>
      draftKey === channelA ? "address-a" : "address-b",
    fetchEvents: async () => events,
  });

  await manager.fetchAllOwnDrafts();
  assert.equal(loadDraftEntry(channelA)?.content, "A");
  assert.equal(loadDraftEntry(channelB)?.content, "B");
});

test("test_older_event_for_same_address_does_not_replace_newer_draft", async () => {
  setup();
  const newer = wrapped({
    id: "newer",
    createdAt: 2,
    address: "address-a",
    channelId: channelA,
    content: "new-cipher",
  });
  const older = wrapped({
    id: "older",
    createdAt: 1,
    address: "address-a",
    channelId: channelA,
    content: "old-cipher",
  });
  let events = [newer];
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    decrypt: async (cipher) =>
      payload(channelA, cipher === "new-cipher" ? "new draft" : "old draft"),
    deriveAddress: async () => "address-a",
    fetchEvents: async () => events,
  });

  await manager.fetchAllOwnDrafts();
  events = [older];
  await manager.fetchAllOwnDrafts();
  assert.equal(loadDraftEntry(channelA)?.content, "new draft");
});

test("test_decrypted_context_with_mismatched_address_is_rejected", async () => {
  setup();
  const address = "address-from-event";
  const mismatched = wrapped({
    id: "mismatched-address",
    createdAt: 2,
    address,
    channelId: channelA,
    content: "mismatched-cipher",
  });
  const valid = wrapped({
    id: "valid-address",
    createdAt: 1,
    address,
    channelId: channelA,
    content: "valid-cipher",
  });
  let events = [mismatched];
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    decrypt: async (cipher) =>
      cipher === "mismatched-cipher"
        ? JSON.stringify({
            kind: 9,
            created_at: 1,
            pubkey,
            content: "must not restore",
            tags: [
              ["h", channelA],
              ["e", "other-root", "", "reply"],
            ],
          })
        : payload(channelA, "valid draft"),
    deriveAddress: async (draftKey) =>
      draftKey === channelA ? address : "address-derived-from-context",
    fetchEvents: async () => events,
  });

  await manager.fetchAllOwnDrafts();
  assert.equal(loadDraftEntry(channelA), undefined);
  events = [valid];
  await manager.fetchAllOwnDrafts();
  assert.equal(loadDraftEntry(channelA)?.content, "valid draft");
});

test("test_tombstone_failure_sidecar_suppresses_remote_resurrection", async () => {
  setup();
  const remote = wrapped({
    id: "remote",
    createdAt: 1,
    address: "address-a",
    channelId: channelA,
    content: "cipher",
  });
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    deriveAddress: async () => "address-a",
    sign: async (input) => ({
      ...remote,
      id: "tombstone",
      created_at: 2,
      content: input.content,
    }),
    publishEvent: async () => {
      throw new Error("offline");
    },
    decrypt: async () => payload(channelA, "must not return"),
    fetchEvents: async () => [remote],
  });

  await manager.queueDeletion(channelA, channelA);
  await manager.fetchAllOwnDrafts();
  assert.equal(loadDraftEntry(channelA), undefined);
  assert.match(
    localStorage.getItem(`buzz-draft-sync.v1:wss://relay.example:${pubkey}`) ??
      "",
    /address-a/,
  );
});

test("test_remote_tombstone_removes_known_draft", async () => {
  setup();
  const remote = wrapped({
    id: "remote",
    createdAt: 1,
    address: "address-a",
    channelId: channelA,
    content: "cipher",
  });
  const tombstone = wrapped({
    id: "tombstone",
    createdAt: 2,
    address: "address-a",
    channelId: channelA,
    content: "",
  });
  let events = [remote];
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    decrypt: async () => payload(channelA, "draft"),
    deriveAddress: async () => "address-a",
    fetchEvents: async () => events,
  });

  await manager.fetchAllOwnDrafts();
  assert.equal(loadDraftEntry(channelA)?.content, "draft");
  events = [tombstone];
  await manager.fetchAllOwnDrafts();
  assert.equal(loadDraftEntry(channelA), undefined);
});

function draft(channelId, content, pendingImeta = []) {
  return {
    channelId,
    content,
    selectionStart: content.length,
    selectionEnd: content.length,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    pendingImeta,
    spoileredAttachmentUrls: [],
    status: "active",
  };
}

test("test_pending_local_publish_observing_tombstone_does_not_resurrect_draft", async () => {
  setup();
  const tombstone = wrapped({
    id: "tombstone",
    createdAt: 2,
    address: "address-a",
    channelId: channelA,
    content: "",
  });
  const published = [];
  const local = draft(channelA, "local edit");
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    deriveAddress: async () => "address-a",
    fetchEvents: async () => [tombstone],
    sign: async (input) => ({ ...tombstone, ...input, id: "signed" }),
    publishEvent: async (event) => published.push(event),
  });

  saveDraftEntry(channelA, local);
  manager.queuePublish(channelA, local);
  await manager.destroy();

  assert.equal(published.length, 0);
  assert.equal(loadDraftEntry(channelA), undefined);
});

test("test_remote_update_does_not_overwrite_pending_local_edit", async () => {
  setup();
  const remote = wrapped({
    id: "remote",
    createdAt: 2,
    address: "address-a",
    channelId: channelA,
    content: "remote-cipher",
  });
  const local = draft(channelA, "local edit");
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    decrypt: async () => payload(channelA, "remote edit"),
    deriveAddress: async () => "address-a",
    fetchEvents: async () => [remote],
  });

  saveDraftEntry(channelA, local);
  manager.queuePublish(channelA, local);
  await manager.fetchAllOwnDrafts();

  assert.equal(loadDraftEntry(channelA)?.content, "local edit");
});

test("test_deleting_one_draft_does_not_strand_another_pending_publish", async () => {
  setup();
  const published = [];
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    deriveAddress: async (draftKey) =>
      draftKey === channelA ? "address-a" : "address-b",
    fetchEvents: async () => [],
    encrypt: async () => "cipher",
    sign: async (input) => ({
      id: `signed-${input.content || "tombstone"}`,
      created_at: input.createdAt ?? 0,
      kind: input.kind,
      pubkey,
      content: input.content,
      sig: "",
      tags: input.tags,
    }),
    publishEvent: async (event) => published.push(event),
  });

  manager.queuePublish(channelA, draft(channelA, "draft A"));
  await manager.queueDeletion(channelB, channelB);
  await manager.destroy();

  assert.ok(published.some((event) => event.content === "cipher"));
});

test("test_tombstone_rebases_after_future_remote_head", async () => {
  setup();
  const future = Math.floor(Date.now() / 1_000) + 10_000;
  const remote = wrapped({
    id: "remote",
    createdAt: future,
    address: "address-a",
    channelId: channelA,
    content: "cipher",
  });
  const signed = [];
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    decrypt: async () => payload(channelA, "draft"),
    deriveAddress: async () => "address-a",
    fetchEvents: async () => [remote],
    sign: async (input) => {
      signed.push(input);
      return { ...remote, ...input, id: "tombstone" };
    },
    publishEvent: async () => {},
  });

  await manager.fetchAllOwnDrafts();
  await manager.queueDeletion(channelA, channelA);

  assert.equal(signed[0].content, "");
  assert.equal(signed[0].createdAt, future + 1);
});

test("test_unuploaded_attachment_cancels_stale_text_publish", async () => {
  setup();
  const published = [];
  const manager = new DraftSyncManager(pubkey, "wss://relay.example", {
    deriveAddress: async () => "address-a",
    fetchEvents: async () => [],
    encrypt: async () => "cipher",
    sign: async (input) => ({
      id: "signed",
      created_at: input.createdAt ?? 0,
      kind: input.kind,
      pubkey,
      content: input.content,
      sig: "",
      tags: input.tags,
    }),
    publishEvent: async (event) => published.push(event),
  });

  manager.queuePublish(channelA, draft(channelA, "text"));
  manager.queuePublish(
    channelA,
    draft(channelA, "text", [{ uploaded: false }]),
  );
  await manager.destroy();

  assert.equal(published.length, 0);
});
