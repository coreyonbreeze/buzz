import assert from "node:assert/strict";
import test from "node:test";

import {
  getCatalogPersonas,
  getCatalogSelectionState,
  getLibraryPersonas,
  getPersonaLabelsById,
  getPersonaLibraryState,
  isCatalogPersonaSelected,
} from "./catalog.ts";

function createPersona(id, displayName, overrides = {}) {
  return {
    id,
    displayName,
    avatarUrl: overrides.avatarUrl ?? null,
    systemPrompt: overrides.systemPrompt ?? `${displayName} prompt`,
    runtime: overrides.runtime ?? null,
    model: overrides.model ?? null,
    isBuiltIn: overrides.isBuiltIn ?? false,
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00Z",
  };
}

test("getCatalogPersonas hides built-ins and includes shared custom agents", () => {
  const personas = [
    createPersona("builtin:fizz", "Fizz", { isBuiltIn: true, isActive: false }),
    createPersona("custom:builder", "Builder"),
  ];

  assert.deepEqual(
    getCatalogPersonas(personas, new Set(["custom:builder"])).map(
      (persona) => persona.id,
    ),
    ["custom:builder"],
  );
});

test("getCatalogSelectionState only selects shared custom agents", () => {
  const personas = [
    createPersona("builtin:fizz", "Fizz", { isBuiltIn: true, isActive: true }),
    createPersona("custom:builder", "Builder"),
  ];

  const state = getCatalogSelectionState(
    personas,
    new Set(["builtin:fizz", "custom:builder"]),
  );

  assert.deepEqual(
    state.catalogPersonas.map((persona) => persona.id),
    ["custom:builder"],
  );
  assert.deepEqual(
    state.selectedCatalogPersonas.map((persona) => persona.id),
    ["custom:builder"],
  );
  assert.deepEqual(
    state.unselectedCatalogPersonas.map((persona) => persona.id),
    [],
  );
});

test("getCatalogPersonas keeps chooser order stable when selection changes", () => {
  const inactive = [
    createPersona("custom:fizz", "Fizz", { isActive: false }),
    createPersona("custom:reviewer", "Reviewer", {
      isActive: true,
    }),
  ];
  const active = [
    createPersona("custom:fizz", "Fizz", { isActive: true }),
    createPersona("custom:reviewer", "Reviewer", {
      isActive: false,
    }),
  ];
  const shared = new Set(["custom:fizz", "custom:reviewer"]);

  assert.deepEqual(
    getCatalogPersonas(inactive, shared).map((persona) => persona.id),
    getCatalogPersonas(active, shared).map((persona) => persona.id),
  );
});

test("isCatalogPersonaSelected treats active catalog personas as selected", () => {
  assert.equal(
    isCatalogPersonaSelected(
      createPersona("builtin:fizz", "Fizz", {
        isBuiltIn: true,
        isActive: true,
      }),
    ),
    true,
  );
  assert.equal(
    isCatalogPersonaSelected(
      createPersona("builtin:fizz", "Fizz", {
        isBuiltIn: true,
        isActive: false,
      }),
    ),
    false,
  );
  assert.equal(
    isCatalogPersonaSelected(createPersona("custom:builder", "Builder")),
    true,
  );
});

test("getPersonaLabelsById keeps every returned persona addressable", () => {
  const personas = [
    createPersona("builtin:fizz", "Fizz", { isBuiltIn: true, isActive: false }),
    createPersona("custom:builder", "Builder"),
  ];

  assert.deepEqual(getPersonaLabelsById(personas), {
    "builtin:fizz": "Fizz",
    "custom:builder": "Builder",
  });
});

test("getPersonaLibraryState keeps built-ins in the library but not the catalog", () => {
  const personas = [
    createPersona("builtin:fizz", "Fizz", { isBuiltIn: true, isActive: true }),
    createPersona("custom:builder", "Builder"),
  ];

  const state = getPersonaLibraryState(
    personas,
    new Set(["builtin:fizz", "custom:builder"]),
  );

  assert.deepEqual(
    state.libraryPersonas.map((persona) => persona.id),
    ["builtin:fizz", "custom:builder"],
  );
  assert.deepEqual(
    state.catalogPersonas.map((persona) => persona.id),
    ["custom:builder"],
  );
  assert.equal(state.personaLabelsById["builtin:fizz"], "Fizz");
});

test("getLibraryPersonas keeps active custom personas even when catalog entries are similar", () => {
  const avatarUrl = "https://example.test/coordinator.png";
  const personas = [
    createPersona("builtin:work-coordinator", "Work Coordinator", {
      avatarUrl,
      isBuiltIn: true,
      isActive: false,
    }),
    createPersona("custom:work-coordinator", "Work Coordinator", {
      avatarUrl,
      isActive: true,
    }),
    createPersona("custom:builder", "Builder", { isActive: true }),
  ];

  assert.deepEqual(
    getLibraryPersonas(personas).map((persona) => persona.id),
    ["custom:work-coordinator", "custom:builder"],
  );
});
