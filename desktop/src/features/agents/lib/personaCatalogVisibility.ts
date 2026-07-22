const PERSONA_CATALOG_VISIBILITY_STORAGE_KEY =
  "buzz-persona-catalog-visibility-v1";

function resolveStorage<T extends "getItem" | "setItem">(
  storage: Pick<Storage, T> | null | undefined,
): Pick<Storage, T> | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSharedCatalogPersonaIds(
  storage?: Pick<Storage, "getItem"> | null,
): string[] {
  const targetStorage = resolveStorage(storage);
  if (!targetStorage) return [];

  try {
    const raw = targetStorage.getItem(PERSONA_CATALOG_VISIBILITY_STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function writeSharedCatalogPersonaIds(
  ids: readonly string[],
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const targetStorage = resolveStorage(storage);
  if (!targetStorage) return;

  try {
    targetStorage.setItem(
      PERSONA_CATALOG_VISIBILITY_STORAGE_KEY,
      JSON.stringify(ids),
    );
  } catch {
    // Catalog visibility is a convenience setting and should not block sharing.
  }
}
