import assert from "node:assert/strict";
import test from "node:test";

import {
  getDefaultModelConfigRuntimeId,
  getPreferredRuntimeIdForSelection,
  loadStoredOnboardingRuntimeSelection,
  runtimeCanAdvanceOnboarding,
  runtimeCanBeSelected,
  runtimeIsInstalled,
  runtimeSelectionNeedsDefaultModelConfig,
  runtimeSelectionNeedsDefaultsStep,
  storeOnboardingRuntimeSelection,
} from "./onboardingRuntimeSelection.ts";

function runtime(id, availability, status) {
  return { id, availability, authStatus: { status } };
}

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
}

test("known onboarding harnesses can be selected regardless of setup state", () => {
  for (const id of ["claude", "codex"]) {
    assert.equal(
      runtimeCanBeSelected(runtime(id, "available", "logged_in")),
      true,
    );
    assert.equal(
      runtimeCanBeSelected(runtime(id, "available", "not_applicable")),
      true,
    );
    assert.equal(
      runtimeCanBeSelected(runtime(id, "available", "logged_out")),
      true,
    );
    assert.equal(
      runtimeCanBeSelected(runtime(id, "available", "config_invalid")),
      true,
    );
    assert.equal(
      runtimeCanBeSelected(runtime(id, "available", "unknown")),
      true,
    );
    assert.equal(
      runtimeCanBeSelected(runtime(id, "not_installed", "logged_out")),
      true,
    );
  }

  for (const id of ["buzz-agent", "goose"]) {
    assert.equal(
      runtimeCanBeSelected(runtime(id, "available", "not_applicable")),
      true,
    );
    assert.equal(
      runtimeCanBeSelected(runtime(id, "not_installed", "not_applicable")),
      true,
    );
  }
});

test("unknown runtimes are not onboarding choices", () => {
  assert.equal(
    runtimeCanBeSelected(runtime("custom", "available", "logged_in")),
    false,
  );
});

test("selected runtimes can advance only after setup is complete", () => {
  assert.equal(
    runtimeCanAdvanceOnboarding(runtime("claude", "available", "logged_in")),
    true,
  );
  assert.equal(
    runtimeCanAdvanceOnboarding(
      runtime("buzz-agent", "available", "not_applicable"),
    ),
    true,
  );
  assert.equal(
    runtimeCanAdvanceOnboarding(runtime("claude", "available", "logged_out")),
    false,
  );
  assert.equal(
    runtimeCanAdvanceOnboarding(runtime("codex", "not_installed", "unknown")),
    false,
  );
  assert.equal(
    runtimeCanAdvanceOnboarding(
      runtime("claude", "adapter_missing", "unknown"),
    ),
    false,
  );
});

test("provider-backed selections drive the default model config step", () => {
  assert.equal(
    runtimeSelectionNeedsDefaultModelConfig(["claude", "codex"]),
    false,
  );
  assert.equal(
    runtimeSelectionNeedsDefaultModelConfig(["claude", "goose"]),
    true,
  );
  assert.equal(
    getDefaultModelConfigRuntimeId(["claude", "codex", "goose", "buzz-agent"]),
    "buzz-agent",
  );
});

test("onboarding display order drives the preferred runtime", () => {
  assert.equal(
    getPreferredRuntimeIdForSelection([
      "buzz-agent",
      "goose",
      "codex",
      "claude",
    ]),
    "claude",
  );
  assert.equal(
    getPreferredRuntimeIdForSelection(["buzz-agent", "goose", "codex"]),
    "codex",
  );
  assert.equal(
    getPreferredRuntimeIdForSelection(["buzz-agent", "goose"]),
    "goose",
  );
  assert.equal(getPreferredRuntimeIdForSelection(["buzz-agent"]), "buzz-agent");
  assert.equal(getPreferredRuntimeIdForSelection(["custom"]), "custom");
  assert.equal(getPreferredRuntimeIdForSelection([]), null);
});

test("any harness selection drives the defaults step", () => {
  assert.equal(runtimeSelectionNeedsDefaultsStep([]), false);
  assert.equal(runtimeSelectionNeedsDefaultsStep(["claude"]), true);
  assert.equal(runtimeSelectionNeedsDefaultsStep(["codex"]), true);
  assert.equal(runtimeSelectionNeedsDefaultsStep(["claude", "codex"]), true);
  assert.equal(runtimeSelectionNeedsDefaultsStep(["goose"]), true);
});

test("installed means selectable and set up", () => {
  assert.equal(
    runtimeIsInstalled(runtime("claude", "available", "logged_in")),
    true,
  );
  assert.equal(
    runtimeIsInstalled(runtime("claude", "available", "logged_out")),
    false,
  );
  assert.equal(
    runtimeIsInstalled(runtime("custom", "available", "logged_in")),
    false,
  );
});

test("runtime selection round-trips through storage", () => {
  const storage = createMemoryStorage();
  storeOnboardingRuntimeSelection(["claude", "buzz-agent"], storage);
  assert.deepEqual(loadStoredOnboardingRuntimeSelection(storage), [
    "claude",
    "buzz-agent",
  ]);
});

test("storing overwrites the previous runtime selection", () => {
  const storage = createMemoryStorage();
  storeOnboardingRuntimeSelection(["claude", "codex"], storage);
  storeOnboardingRuntimeSelection(["goose"], storage);
  assert.deepEqual(loadStoredOnboardingRuntimeSelection(storage), ["goose"]);
});

test("loading with nothing stored returns an empty selection", () => {
  assert.deepEqual(
    loadStoredOnboardingRuntimeSelection(createMemoryStorage()),
    [],
  );
});

test("corrupt or non-array stored selections are treated as empty", () => {
  assert.deepEqual(
    loadStoredOnboardingRuntimeSelection(
      createMemoryStorage({
        "buzz-machine-onboarding-runtime-selection.v1": "{not json",
      }),
    ),
    [],
  );
  assert.deepEqual(
    loadStoredOnboardingRuntimeSelection(
      createMemoryStorage({
        "buzz-machine-onboarding-runtime-selection.v1": '{"claude":true}',
      }),
    ),
    [],
  );
});

test("non-string entries are dropped from a stored selection", () => {
  const storage = createMemoryStorage({
    "buzz-machine-onboarding-runtime-selection.v1":
      '["claude", 7, null, "goose"]',
  });
  assert.deepEqual(loadStoredOnboardingRuntimeSelection(storage), [
    "claude",
    "goose",
  ]);
});
