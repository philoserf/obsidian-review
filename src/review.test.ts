import { describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  EMPTY_STATE,
  isEligible,
  isReviewed,
  markReviewed,
  markUnreviewed,
  normalizeState,
  type PluginState,
  removePath,
  renamePath,
  reset,
  serialize,
  setExcludedFolders,
  setShowStatusBar,
  stats,
} from "./review";

function stateWith(
  paths: string[],
  excludedFolders: string[] = [],
  startedAt?: string,
): PluginState {
  // Built directly rather than through normalizeState, so the tests can use
  // sentinel clock values ("loaded", "first") that are not parseable dates.
  return {
    ...normalizeState({ excludedFolders }),
    reviewedPaths: new Set(paths),
    reviewStartedAt: startedAt,
  };
}

describe("normalizeState", () => {
  test("passes a fully valid object through", () => {
    expect(
      serialize(
        normalizeState({
          reviewedPaths: ["a.md", "b.md"],
          reviewStartedAt: "2026-03-23T10:00:00.000Z",
          excludedFolders: ["templates"],
          showStatusBar: false,
        }),
      ),
    ).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      reviewedPaths: ["a.md", "b.md"],
      reviewStartedAt: "2026-03-23T10:00:00.000Z",
      excludedFolders: ["templates"],
      showStatusBar: false,
    });
  });

  test("supplies defaults for an empty object", () => {
    expect(serialize(normalizeState({}))).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      reviewedPaths: [],
      reviewStartedAt: undefined,
      excludedFolders: [],
      showStatusBar: true,
    });
  });

  test.each([[null], [undefined], ["not an object"], [42], [[]]])(
    "returns defaults for %p as the whole input",
    (raw) => {
      expect(serialize(normalizeState(raw))).toEqual({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        reviewedPaths: [],
        reviewStartedAt: undefined,
        excludedFolders: [],
        showStatusBar: true,
      });
    },
  );

  // isEligible calls excludedFolders.some(), which sits under stats() in the
  // settings tab — a non-array here used to leave the tab blank, so the user
  // could not repair the value that broke it.
  test("replaces a non-array excludedFolders with an empty list", () => {
    expect(normalizeState({ excludedFolders: null }).excludedFolders).toEqual(
      [],
    );
    expect(
      normalizeState({ excludedFolders: "templates" }).excludedFolders,
    ).toEqual([]);
  });

  // new Set("abc") yields {"a","b","c"} — silently reviewed one-character paths.
  test("replaces a string reviewedPaths with an empty list", () => {
    expect([...normalizeState({ reviewedPaths: "abc" }).reviewedPaths]).toEqual(
      [],
    );
  });

  test("drops non-string members of the path lists", () => {
    expect(
      serialize(
        normalizeState({
          reviewedPaths: ["a.md", 7, null, "b.md"],
          excludedFolders: ["templates", { path: "daily" }],
        }),
      ),
    ).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      reviewedPaths: ["a.md", "b.md"],
      reviewStartedAt: undefined,
      excludedFolders: ["templates"],
      showStatusBar: true,
    });
  });

  test("drops a reviewStartedAt that is not a parseable date", () => {
    expect(
      normalizeState({ reviewStartedAt: "yesterday" }).reviewStartedAt,
    ).toBeUndefined();
    expect(
      normalizeState({ reviewStartedAt: 1742731200000 }).reviewStartedAt,
    ).toBeUndefined();
  });

  test("keeps a date-only reviewStartedAt", () => {
    expect(
      normalizeState({ reviewStartedAt: "2026-03-23" }).reviewStartedAt,
    ).toBe("2026-03-23");
  });

  // The field that decides whether the plugin runs read-only, so degrading it
  // to the default is not the safe direction: the default reads as "not newer
  // than me" and disengages the fence on the one file it protects.
  test("reads a version written as a string as the number it means", () => {
    expect(normalizeState({ schemaVersion: "9" }).schemaVersion).toBe(9);
    expect(normalizeState({ schemaVersion: "2" }).schemaVersion).toBe(2);
  });

  // Nothing here claims to be from the future: an absent version is a fresh
  // install or a pre-v2 file, and the rest is unreadable junk.
  test("falls back to the current version for an unreadable schemaVersion", () => {
    expect(normalizeState({ schemaVersion: {} }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(normalizeState({ schemaVersion: true }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(normalizeState({ schemaVersion: "v9" }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(normalizeState({ schemaVersion: 2.5 }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(normalizeState({}).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("keeps a genuinely newer schemaVersion, so the fence can engage", () => {
    expect(normalizeState({ schemaVersion: 9 }).schemaVersion).toBe(9);
  });

  test("falls back to true for a non-boolean showStatusBar", () => {
    expect(normalizeState({ showStatusBar: null }).showStatusBar).toBe(true);
    expect(normalizeState({ showStatusBar: "false" }).showStatusBar).toBe(true);
  });

  // The disk path. A synced or hand-edited data.json can hold anything, and an
  // entry with a trailing slash matches nothing because isEligible tests for a
  // `${folder}/` prefix — the user sees the folder listed as excluded and its
  // notes keep appearing in review.
  test("normalizes folders coming off disk", () => {
    const state = normalizeState({
      excludedFolders: ["Templates/", " Daily ", "", "Daily"],
    });
    expect(state.excludedFolders).toEqual(["Templates", "Daily"]);
    expect(isEligible(state, "Templates/note.md")).toBe(false);
    expect(isEligible(state, "Daily/note.md")).toBe(false);
  });

  test("round-trips through serialize", () => {
    const state = stateWith(["a.md"], ["templates"], "2026-03-23");
    expect(normalizeState(serialize(state))).toEqual(state);
  });
});

describe("isEligible", () => {
  test("excludes a file in an excluded folder", () => {
    expect(isEligible(stateWith([], ["templates"]), "templates/note.md")).toBe(
      false,
    );
  });

  test("excludes a file in a nested subfolder", () => {
    expect(
      isEligible(stateWith([], ["templates"]), "templates/sub/note.md"),
    ).toBe(false);
  });

  // The `${folder}/` boundary: "templates" must not match "templates-extra".
  test("does not exclude a path that only shares a prefix", () => {
    expect(
      isEligible(stateWith([], ["templates"]), "templates-extra/note.md"),
    ).toBe(true);
  });

  test("does not exclude a root-level file", () => {
    expect(isEligible(stateWith([], ["templates"]), "note.md")).toBe(true);
  });
});

describe("setExcludedFolders", () => {
  test("trims whitespace and strips trailing slashes", () => {
    expect(
      setExcludedFolders(EMPTY_STATE, [" Templates ", "Daily//"])
        .excludedFolders,
    ).toEqual(["Templates", "Daily"]);
  });

  test("drops empty entries", () => {
    expect(
      setExcludedFolders(EMPTY_STATE, ["Templates", "", "   ", "/"])
        .excludedFolders,
    ).toEqual(["Templates"]);
  });

  test("dedupes entries that normalize to the same folder", () => {
    expect(
      setExcludedFolders(EMPTY_STATE, ["Templates", "Templates/", " Templates"])
        .excludedFolders,
    ).toEqual(["Templates"]);
  });

  test("a normalized entry actually excludes", () => {
    const state = setExcludedFolders(EMPTY_STATE, [" Templates/ "]);
    expect(isEligible(state, "Templates/note.md")).toBe(false);
  });

  test("returns the same state when the list is unchanged", () => {
    const state = stateWith([], ["Templates"]);
    expect(setExcludedFolders(state, ["Templates/"])).toBe(state);
  });
});

describe("markReviewed", () => {
  test("starts the review clock on first mark only", () => {
    let state = markReviewed(EMPTY_STATE, "a.md", () => "first");
    state = markReviewed(state, "b.md", () => "second");
    expect(state.reviewStartedAt).toBe("first");
  });

  test("keeps an existing review clock", () => {
    const state = markReviewed(
      stateWith(["a.md"], [], "loaded"),
      "b.md",
      () => "later",
    );
    expect(state.reviewStartedAt).toBe("loaded");
  });

  test("returns the same state for an already-reviewed path", () => {
    const state = stateWith(["a.md"], [], "loaded");
    expect(markReviewed(state, "a.md")).toBe(state);
  });
});

describe("markUnreviewed", () => {
  test("removes the path but keeps the review clock", () => {
    const state = markUnreviewed(stateWith(["a.md"], [], "loaded"), "a.md");
    expect(isReviewed(state, "a.md")).toBe(false);
    expect(state.reviewStartedAt).toBe("loaded");
  });

  test("returns the same state for an unreviewed path", () => {
    const state = stateWith(["a.md"]);
    expect(markUnreviewed(state, "x.md")).toBe(state);
  });
});

describe("setShowStatusBar", () => {
  test("flips the preference", () => {
    expect(setShowStatusBar(EMPTY_STATE, false).showStatusBar).toBe(false);
  });

  test("returns the same state when unchanged", () => {
    expect(setShowStatusBar(EMPTY_STATE, true)).toBe(EMPTY_STATE);
  });
});

describe("reset", () => {
  test("clears paths and the review clock", () => {
    const state = reset(stateWith(["a.md", "b.md"], [], "loaded"));
    expect(state.reviewedPaths.size).toBe(0);
    expect(state.reviewStartedAt).toBeUndefined();
  });

  test("leaves excluded folders alone", () => {
    expect(reset(stateWith(["a.md"], ["templates"])).excludedFolders).toEqual([
      "templates",
    ]);
  });

  test("returns the same state when there is nothing to reset", () => {
    expect(reset(EMPTY_STATE)).toBe(EMPTY_STATE);
  });
});

describe("stats", () => {
  test("computes stats for partial review", () => {
    const state = stateWith(["a.md", "b.md", "elsewhere.md"]);
    expect(stats(state, ["a.md", "b.md", "c.md", "d.md"])).toEqual({
      reviewed: 2,
      eligible: 4,
      percentCompleted: 50,
    });
  });

  test("handles zero eligible files", () => {
    expect(stats(EMPTY_STATE, []).percentCompleted).toBe(0);
  });
});

describe("rename a file", () => {
  test("moves a reviewed path", () => {
    const before = stateWith(["a.md"]);
    const after = renamePath(before, "a.md", "b.md", false);
    expect(after).not.toBe(before);
    expect(isReviewed(after, "b.md")).toBe(true);
    expect(isReviewed(after, "a.md")).toBe(false);
  });

  test("is a no-op for an unreviewed path", () => {
    const state = stateWith(["a.md"]);
    expect(renamePath(state, "x.md", "y.md", false)).toBe(state);
  });

  test("never touches excluded folders", () => {
    const state = stateWith([], ["Templates"]);
    expect(renamePath(state, "Templates", "Renamed", false)).toBe(state);
    expect(state.excludedFolders).toEqual(["Templates"]);
  });
});

describe("rename a folder", () => {
  // renamePath maps entries independently, so a rename can collide two
  // exclusions onto the same path.
  test("dedupes when a rename collides two exclusions", () => {
    const state = renamePath(stateWith([], ["A", "B"]), "B", "A", true);
    expect(state.excludedFolders).toEqual(["A"]);
  });

  test("dedupes when a nested exclusion collides with its parent", () => {
    const state = renamePath(
      stateWith([], ["Meta", "Meta/Templates"]),
      "Meta/Templates",
      "Meta",
      true,
    );
    expect(state.excludedFolders).toEqual(["Meta"]);
  });

  test("rewrites reviewed paths under it", () => {
    const before = stateWith(["folder/a.md", "folder/sub/b.md", "other/c.md"]);
    const after = renamePath(before, "folder", "renamed", true);
    expect(after).not.toBe(before);
    expect(isReviewed(after, "renamed/a.md")).toBe(true);
    expect(isReviewed(after, "renamed/sub/b.md")).toBe(true);
    expect(isReviewed(after, "other/c.md")).toBe(true);
    expect(after.reviewedPaths.size).toBe(3);
  });

  // #80: excluding Templates then moving it silently un-excluded everything
  // in it, while the settings tab went on listing the old path.
  test("rewrites the excluded folder itself", () => {
    const before = stateWith([], ["Templates"]);
    const after = renamePath(before, "Templates", "Meta/Templates", true);
    expect(after).not.toBe(before);
    expect(after.excludedFolders).toEqual(["Meta/Templates"]);
    expect(isEligible(after, "Meta/Templates/note.md")).toBe(false);
  });

  test("rewrites an excluded folder nested under the renamed one", () => {
    const before = stateWith([], ["Meta/Templates"]);
    const after = renamePath(before, "Meta", "Admin", true);
    expect(after).not.toBe(before);
    expect(after.excludedFolders).toEqual(["Admin/Templates"]);
  });

  test("is a no-op when nothing matches", () => {
    const state = stateWith(["other/a.md"], ["other"]);
    expect(renamePath(state, "folder", "renamed", true)).toBe(state);
    expect(isReviewed(state, "other/a.md")).toBe(true);
    expect(state.excludedFolders).toEqual(["other"]);
  });

  test("does not rewrite a path that only shares a prefix", () => {
    const state = stateWith(["folder-extra/a.md"], ["folder-extra"]);
    expect(renamePath(state, "folder", "renamed", true)).toBe(state);
    expect(isReviewed(state, "folder-extra/a.md")).toBe(true);
    expect(state.excludedFolders).toEqual(["folder-extra"]);
  });
});

describe("remove a folder", () => {
  test("removes all reviewed paths under it", () => {
    const before = stateWith(["folder/a.md", "folder/sub/b.md", "other/c.md"]);
    const after = removePath(before, "folder", true);
    expect(after).not.toBe(before);
    expect(after.reviewedPaths.size).toBe(1);
    expect(isReviewed(after, "other/c.md")).toBe(true);
  });

  test("drops the excluded folder and its descendants", () => {
    const before = stateWith([], ["folder", "folder/sub", "other"]);
    const after = removePath(before, "folder", true);
    expect(after).not.toBe(before);
    expect(after.excludedFolders).toEqual(["other"]);
  });

  test("is a no-op when nothing matches", () => {
    const state = stateWith(["other/a.md"], ["other"]);
    expect(removePath(state, "folder", true)).toBe(state);
  });

  test("does not remove a path that only shares a prefix", () => {
    const state = stateWith(["folder-extra/a.md"], ["folder-extra"]);
    expect(removePath(state, "folder", true)).toBe(state);
    expect(isReviewed(state, "folder-extra/a.md")).toBe(true);
    expect(state.excludedFolders).toEqual(["folder-extra"]);
  });
});
