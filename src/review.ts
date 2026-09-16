export type ReviewStats = {
  reviewed: number;
  eligible: number;
  percentCompleted: number;
};

export const CURRENT_SCHEMA_VERSION = 2;

/** The shape written to `data.json`. Arrays, because JSON has no Set. */
export type PluginData = {
  schemaVersion: number;
  reviewedPaths: string[];
  reviewStartedAt?: string;
  excludedFolders: string[];
  showStatusBar: boolean;
};

/**
 * The persisted document as one immutable value. Every change is a pure
 * function from this to the next one, and a transition that changes nothing
 * returns the same reference — which is the "nothing happened" signal that
 * rename and remove used to report as a boolean.
 *
 * The vault is the source of truth for what exists, so renamePath/removePath
 * reconcile the stored paths against it rather than maintaining an
 * authoritative file list. That reconciliation covers excludedFolders too — it
 * lives here for exactly that reason.
 */
export type PluginState = {
  readonly schemaVersion: number;
  readonly reviewedPaths: ReadonlySet<string>;
  readonly reviewStartedAt?: string;
  readonly excludedFolders: readonly string[];
  readonly showStatusBar: boolean;
};

/**
 * The only way in. A folder that is not trimmed of whitespace or stripped of
 * trailing slashes matches nothing, silently, because `isEligible` tests for a
 * `${folder}/` prefix. Every writer of `excludedFolders` runs through here:
 * `setExcludedFolders` (the UI), `normalizeState` (the disk), and `renamePath`
 * (vault reconciliation, which maps entries independently and can collide two
 * onto one).
 */
function normalizeFolders(list: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const folder = entry.trim().replace(/\/+$/, "");
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    normalized.push(folder);
  }
  return normalized;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function sameFolders(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((folder, i) => folder === b[i]);
}

/**
 * `data.json` is the least trustworthy thing the plugin reads: a hand-edit, a
 * sync conflict, or a schema written by a future version can put any shape in
 * it, and a spread happily overwrites a well-typed default with a wrong-typed
 * value. Coerce rather than throw — a bad field must degrade to its default so
 * the settings tab still renders and the user can repair it from the UI.
 */
export function normalizeState(raw: unknown): PluginState {
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
    reviewedPaths: new Set(stringArray(data.reviewedPaths)),
    reviewStartedAt:
      typeof startedAt === "string" && !Number.isNaN(Date.parse(startedAt))
        ? startedAt
        : undefined,
    excludedFolders: normalizeFolders(stringArray(data.excludedFolders)),
    showStatusBar:
      typeof data.showStatusBar === "boolean" ? data.showStatusBar : true,
  };
}

/** The inverse of normalizeState: the value as the JSON shape on disk. */
export function serialize(state: PluginState): PluginData {
  return {
    schemaVersion: state.schemaVersion,
    reviewedPaths: [...state.reviewedPaths],
    reviewStartedAt: state.reviewStartedAt,
    excludedFolders: [...state.excludedFolders],
    showStatusBar: state.showStatusBar,
  };
}

/** A fresh install, and the fallback for a `data.json` that cannot be read. */
export const EMPTY_STATE: PluginState = normalizeState(undefined);

// --- queries ---------------------------------------------------------------

export function isEligible(state: PluginState, path: string): boolean {
  return !state.excludedFolders.some((folder) => path.startsWith(`${folder}/`));
}

export function isReviewed(state: PluginState, path: string): boolean {
  return state.reviewedPaths.has(path);
}

export function stats(state: PluginState, eligible: string[]): ReviewStats {
  const reviewed = eligible.filter((p) => state.reviewedPaths.has(p)).length;
  const eligibleCount = eligible.length;
  return {
    reviewed,
    eligible: eligibleCount,
    percentCompleted: eligibleCount
      ? Math.round((reviewed / eligibleCount) * 100)
      : 0,
  };
}

// --- transitions -----------------------------------------------------------
// Each returns the next state, or `state` itself when nothing changed.

export function markReviewed(
  state: PluginState,
  path: string,
  now: () => string = () => new Date().toISOString(),
): PluginState {
  if (state.reviewedPaths.has(path) && state.reviewStartedAt) return state;

  return {
    ...state,
    reviewedPaths: new Set(state.reviewedPaths).add(path),
    reviewStartedAt: state.reviewStartedAt ?? now(),
  };
}

export function markUnreviewed(state: PluginState, path: string): PluginState {
  if (!state.reviewedPaths.has(path)) return state;

  const reviewedPaths = new Set(state.reviewedPaths);
  reviewedPaths.delete(path);
  return { ...state, reviewedPaths };
}

export function setExcludedFolders(
  state: PluginState,
  list: readonly string[],
): PluginState {
  const excludedFolders = normalizeFolders(list);
  if (sameFolders(excludedFolders, state.excludedFolders)) return state;

  return { ...state, excludedFolders };
}

export function setShowStatusBar(
  state: PluginState,
  showStatusBar: boolean,
): PluginState {
  if (showStatusBar === state.showStatusBar) return state;

  return { ...state, showStatusBar };
}

export function reset(state: PluginState): PluginState {
  if (!state.reviewedPaths.size && !state.reviewStartedAt) return state;

  return { ...state, reviewedPaths: new Set(), reviewStartedAt: undefined };
}

export function renamePath(
  state: PluginState,
  oldPath: string,
  newPath: string,
  isFolder: boolean,
): PluginState {
  if (!isFolder) {
    if (!state.reviewedPaths.has(oldPath)) return state;

    const reviewedPaths = new Set(state.reviewedPaths);
    reviewedPaths.delete(oldPath);
    reviewedPaths.add(newPath);
    return { ...state, reviewedPaths };
  }

  const oldPrefix = `${oldPath}/`;
  const newPrefix = `${newPath}/`;
  let changed = false;

  const reviewedPaths = new Set<string>();
  for (const p of state.reviewedPaths) {
    if (p.startsWith(oldPrefix)) {
      reviewedPaths.add(newPrefix + p.slice(oldPrefix.length));
      changed = true;
    } else {
      reviewedPaths.add(p);
    }
  }

  // The excluded folder itself, and any excluded folder beneath it.
  const excludedFolders = normalizeFolders(
    state.excludedFolders.map((folder) => {
      if (folder === oldPath) {
        changed = true;
        return newPath;
      }
      if (folder.startsWith(oldPrefix)) {
        changed = true;
        return newPrefix + folder.slice(oldPrefix.length);
      }
      return folder;
    }),
  );

  return changed ? { ...state, reviewedPaths, excludedFolders } : state;
}

export function removePath(
  state: PluginState,
  path: string,
  isFolder: boolean,
): PluginState {
  if (!isFolder) {
    if (!state.reviewedPaths.has(path)) return state;

    const reviewedPaths = new Set(state.reviewedPaths);
    reviewedPaths.delete(path);
    return { ...state, reviewedPaths };
  }

  const prefix = `${path}/`;
  let changed = false;

  const reviewedPaths = new Set<string>();
  for (const p of state.reviewedPaths) {
    if (p.startsWith(prefix)) changed = true;
    else reviewedPaths.add(p);
  }

  const excludedFolders = state.excludedFolders.filter(
    (folder) => folder !== path && !folder.startsWith(prefix),
  );
  if (excludedFolders.length !== state.excludedFolders.length) changed = true;

  return changed ? { ...state, reviewedPaths, excludedFolders } : state;
}
