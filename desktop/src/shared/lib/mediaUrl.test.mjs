import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beginRelayOriginFetch,
  getCachedRelayOrigin,
  mediaProxyUrl,
  resetMediaCaches,
  subscribeRelayOrigin,
  withDeadline,
} from "./mediaUrl.ts";

const HASH = "a".repeat(64);

test("mediaProxyUrl: uses the IPv4 loopback literal for the localhost proxy", () => {
  assert.equal(
    mediaProxyUrl(54321, `${HASH}.png`),
    `http://127.0.0.1:54321/media/${HASH}.png`,
  );
});

test("relay-origin store: a resolved origin publishes and notifies subscribers", () => {
  resetMediaCaches();
  let notifications = 0;
  const unsubscribe = subscribeRelayOrigin(() => notifications++);

  const publish = beginRelayOriginFetch();
  publish("https://relay.example");

  assert.equal(getCachedRelayOrigin(), "https://relay.example");
  assert.equal(notifications, 1);

  unsubscribe();
  resetMediaCaches();
});

test("relay-origin store: unsubscribe removes exactly its own listener", () => {
  resetMediaCaches();
  let kept = 0;
  let dropped = 0;
  const unsubscribeKept = subscribeRelayOrigin(() => kept++);
  const unsubscribeDropped = subscribeRelayOrigin(() => dropped++);

  // Dropping one listener must not affect the other.
  unsubscribeDropped();
  beginRelayOriginFetch()("https://relay.example");
  assert.equal(kept, 1);
  assert.equal(dropped, 0);

  unsubscribeKept();
  resetMediaCaches();
});

test("relay-origin store: reset notifies only on an actual snapshot change", () => {
  resetMediaCaches();
  let notifications = 0;
  const unsubscribe = subscribeRelayOrigin(() => notifications++);

  // Origin already null → reset is a no-op for listeners.
  resetMediaCaches();
  assert.equal(notifications, 0);

  // Now resolve, then reset: the reset clears a non-null origin, so it fires.
  beginRelayOriginFetch()("https://relay.example");
  assert.equal(notifications, 1);
  resetMediaCaches();
  assert.equal(getCachedRelayOrigin(), null);
  assert.equal(notifications, 2);

  unsubscribe();
});

test("relay-origin store: a late fetch from the previous community never regresses the snapshot", () => {
  resetMediaCaches();
  const unsubscribe = subscribeRelayOrigin(() => {});

  // Community A starts a fetch, then the user switches workspaces (reset),
  // then community B starts its own fetch.
  const publishA = beginRelayOriginFetch();
  resetMediaCaches();
  const publishB = beginRelayOriginFetch();

  // A resolves late — its generation is stale, so it must be discarded.
  publishA("https://relay-a.example");
  assert.equal(getCachedRelayOrigin(), null);

  // B resolves — it is current, so it wins.
  publishB("https://relay-b.example");
  assert.equal(getCachedRelayOrigin(), "https://relay-b.example");

  // A late duplicate from A after B must still not clobber B.
  publishA("https://relay-a.example");
  assert.equal(getCachedRelayOrigin(), "https://relay-b.example");

  unsubscribe();
  resetMediaCaches();
});

test("relay-origin store: a failed attempt then a later success publishes exactly once", () => {
  // Mirrors the `fetchProxyPort` retry loop: each poll attempt calls
  // `beginRelayOriginFetch()` and only publishes if the invoke resolves. An
  // early attempt whose invoke rejects (Tauri bridge not ready) never calls its
  // publisher, so nothing is published; a later attempt succeeds and publishes.
  resetMediaCaches();
  let notifications = 0;
  const unsubscribe = subscribeRelayOrigin(() => notifications++);

  // Attempt 1: invoke rejects — publisher is never invoked.
  beginRelayOriginFetch();
  assert.equal(getCachedRelayOrigin(), null);
  assert.equal(notifications, 0);

  // Attempt 2: invoke resolves — publishes once, notifies once.
  beginRelayOriginFetch()("https://relay.example");
  assert.equal(getCachedRelayOrigin(), "https://relay.example");
  assert.equal(notifications, 1);

  unsubscribe();
  resetMediaCaches();
});

test("relay-origin store: a reset between a failed attempt and its late success discards the stale result", () => {
  // A workspace switch (reset) during the retry sequence must invalidate a
  // still-in-flight attempt from the previous community, even if that attempt
  // eventually resolves after the switch.
  resetMediaCaches();
  const unsubscribe = subscribeRelayOrigin(() => {});

  // Attempt from community A begins, then the user switches (reset), then a
  // fresh attempt from community B begins and succeeds.
  const publishA = beginRelayOriginFetch();
  resetMediaCaches();
  beginRelayOriginFetch()("https://relay-b.example");
  assert.equal(getCachedRelayOrigin(), "https://relay-b.example");

  // A's invoke finally resolves late — stale generation, so it is dropped.
  publishA("https://relay-a.example");
  assert.equal(getCachedRelayOrigin(), "https://relay-b.example");

  unsubscribe();
  resetMediaCaches();
});

test("withDeadline: a never-settling invoke resolves to null at the deadline", async () => {
  // The poll loop bounds each invoke by the remaining budget so a wedged IPC
  // bridge (a promise that never settles) can't hang startup past the timeout.
  const neverSettles = new Promise(() => {});
  const result = await withDeadline(neverSettles, Date.now() + 20);
  assert.equal(result, null);
});

test("withDeadline: a value that settles before the deadline is returned", async () => {
  const result = await withDeadline(
    Promise.resolve("http://relay.example"),
    Date.now() + 1000,
  );
  assert.equal(result, "http://relay.example");
});

test("withDeadline: an already-passed deadline resolves to null without awaiting", async () => {
  const result = await withDeadline(new Promise(() => {}), Date.now() - 1);
  assert.equal(result, null);
});

test("withDeadline: a rejection before the deadline propagates to the caller", async () => {
  await assert.rejects(
    withDeadline(Promise.reject(new Error("ipc failed")), Date.now() + 1000),
    /ipc failed/,
  );
});

test("withDeadline: a rejection after the deadline is observed, not unhandled", async () => {
  // The timeout wins first (deadline ~10ms), then the invoke rejects ~30ms
  // later. That late rejection must be swallowed by the internal no-op catch,
  // not surface as an unhandled rejection. Register a listener to prove it.
  let unhandled;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const slowReject = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("late ipc failure")), 30),
    );
    const result = await withDeadline(slowReject, Date.now() + 10);
    assert.equal(result, null);
    // Give the late rejection time to fire and be (not) reported.
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(unhandled, undefined);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
