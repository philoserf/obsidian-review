import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION, normalizeData } from "./data";

describe("normalizeData", () => {
  test("passes a fully valid object through", () => {
    expect(
      normalizeData({
        reviewedPaths: ["a.md", "b.md"],
        reviewStartedAt: "2026-03-23T10:00:00.000Z",
        excludedFolders: ["templates"],
        showStatusBar: false,
      }),
    ).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      reviewedPaths: ["a.md", "b.md"],
      reviewStartedAt: "2026-03-23T10:00:00.000Z",
      excludedFolders: ["templates"],
      showStatusBar: false,
    });
  });

  test("supplies defaults for an empty object", () => {
    expect(normalizeData({})).toEqual({
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
      expect(normalizeData(raw)).toEqual({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        reviewedPaths: [],
        reviewStartedAt: undefined,
        excludedFolders: [],
        showStatusBar: true,
      });
    },
  );

  // isExcluded calls excludedFolders.some(), which sits under getStats() in the
  // settings tab — a non-array here used to leave the tab blank, so the user
  // could not repair the value that broke it.
  test("replaces a non-array excludedFolders with an empty list", () => {
    expect(normalizeData({ excludedFolders: null }).excludedFolders).toEqual(
      [],
    );
    expect(
      normalizeData({ excludedFolders: "templates" }).excludedFolders,
    ).toEqual([]);
  });

  // new Set("abc") yields {"a","b","c"} — silently reviewed one-character paths.
  test("replaces a string reviewedPaths with an empty list", () => {
    expect(normalizeData({ reviewedPaths: "abc" }).reviewedPaths).toEqual([]);
  });

  test("drops non-string members of the path lists", () => {
    expect(
      normalizeData({
        reviewedPaths: ["a.md", 7, null, "b.md"],
        excludedFolders: ["templates", { path: "daily" }],
      }),
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
      normalizeData({ reviewStartedAt: "yesterday" }).reviewStartedAt,
    ).toBeUndefined();
    expect(
      normalizeData({ reviewStartedAt: 1742731200000 }).reviewStartedAt,
    ).toBeUndefined();
  });

  test("keeps a date-only reviewStartedAt", () => {
    expect(
      normalizeData({ reviewStartedAt: "2026-03-23" }).reviewStartedAt,
    ).toBe("2026-03-23");
  });

  // The field that decides whether the plugin runs read-only. A numeric string
  // is coerced by `>` and then stored back as a string; anything non-coercible
  // compares false, so the write fence never engages and the next save
  // overwrites a newer file with this version's schema.
  test("falls back to the current version for a non-number schemaVersion", () => {
    expect(normalizeData({ schemaVersion: "9" }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(normalizeData({ schemaVersion: {} }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(normalizeData({ schemaVersion: true }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(normalizeData({ schemaVersion: 2.5 }).schemaVersion).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    expect(normalizeData({}).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("keeps a genuinely newer schemaVersion, so the fence can engage", () => {
    expect(normalizeData({ schemaVersion: 9 }).schemaVersion).toBe(9);
  });

  test("falls back to true for a non-boolean showStatusBar", () => {
    expect(normalizeData({ showStatusBar: null }).showStatusBar).toBe(true);
    expect(normalizeData({ showStatusBar: "false" }).showStatusBar).toBe(true);
  });
});
