import assert from "node:assert/strict";
import test from "node:test";

import {
  readSharedCatalogPersonaIds,
  writeSharedCatalogPersonaIds,
} from "./personaCatalogVisibility.ts";

test("catalog visibility reads stored persona ids", () => {
  const storage = {
    getItem: () => JSON.stringify(["custom:analyst", 42, "custom:writer"]),
  };

  assert.deepEqual(readSharedCatalogPersonaIds(storage), [
    "custom:analyst",
    "custom:writer",
  ]);
});

test("catalog visibility tolerates unavailable and invalid storage", () => {
  assert.deepEqual(readSharedCatalogPersonaIds(null), []);
  assert.deepEqual(
    readSharedCatalogPersonaIds({ getItem: () => "not-json" }),
    [],
  );
  assert.deepEqual(readSharedCatalogPersonaIds({ getItem: () => "{}" }), []);
  assert.deepEqual(
    readSharedCatalogPersonaIds({
      getItem: () => {
        throw new Error("unavailable");
      },
    }),
    [],
  );
});

test("catalog visibility persists persona ids without blocking on storage errors", () => {
  let storedKey = "";
  let storedValue = "";
  writeSharedCatalogPersonaIds(["custom:analyst"], {
    setItem: (key, value) => {
      storedKey = key;
      storedValue = value;
    },
  });

  assert.equal(storedKey, "buzz-persona-catalog-visibility-v1");
  assert.equal(storedValue, '["custom:analyst"]');
  assert.doesNotThrow(() =>
    writeSharedCatalogPersonaIds(["custom:analyst"], {
      setItem: () => {
        throw new Error("unavailable");
      },
    }),
  );
});
