export type PluginData = {
  schemaVersion: number;
  reviewedPaths: string[];
  reviewStartedAt?: string;
  excludedFolders: string[];
  showStatusBar: boolean;
};

export const CURRENT_SCHEMA_VERSION = 2;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * `data.json` is the least trustworthy thing the plugin reads: a hand-edit, a
 * sync conflict, or a schema written by a future version can put any shape in
 * it, and a spread happily overwrites a well-typed default with a wrong-typed
 * value. Coerce rather than throw — a bad field must degrade to its default so
 * the settings tab still renders and the user can repair it from the UI.
 */
export function normalizeData(raw: unknown): PluginData {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const startedAt = data.reviewStartedAt;

  return {
    // The field that decides whether the plugin runs read-only, so it is the
    // last one that should be trusted raw. A numeric string would be coerced
    // by `>` and then stored back as a string; anything non-coercible compares
    // false, disengaging the write fence entirely.
    schemaVersion:
      typeof data.schemaVersion === "number" &&
      Number.isInteger(data.schemaVersion)
        ? data.schemaVersion
        : CURRENT_SCHEMA_VERSION,
    reviewedPaths: stringArray(data.reviewedPaths),
    reviewStartedAt:
      typeof startedAt === "string" && !Number.isNaN(Date.parse(startedAt))
        ? startedAt
        : undefined,
    excludedFolders: stringArray(data.excludedFolders),
    showStatusBar:
      typeof data.showStatusBar === "boolean" ? data.showStatusBar : true,
  };
}
