import { describe, expect, test } from "bun:test";
import {
  computeStats,
  isExcluded,
  removeByPrefix,
  rewriteReviewedPaths,
} from "./reviewState";

describe("isExcluded", () => {
  test("excludes file in excluded folder", () => {
    expect(isExcluded("templates/note.md", ["templates"])).toBe(true);
  });

  test("excludes file in nested subfolder", () => {
    expect(isExcluded("templates/sub/note.md", ["templates"])).toBe(true);
  });

  test("does not exclude file outside excluded folders", () => {
    expect(isExcluded("projects/note.md", ["templates"])).toBe(false);
  });

  test("does not exclude file with matching prefix but no slash", () => {
    expect(isExcluded("templates-extra/note.md", ["templates"])).toBe(false);
  });

  test("handles multiple excluded folders", () => {
    expect(isExcluded("daily/2026-03-23.md", ["templates", "daily"])).toBe(
      true,
    );
  });

  test("returns false for empty excluded list", () => {
    expect(isExcluded("anything.md", [])).toBe(false);
  });

  test("does not exclude root-level file", () => {
    expect(isExcluded("note.md", ["templates"])).toBe(false);
  });
});

describe("computeStats", () => {
  test("computes stats for partial review", () => {
    const stats = computeStats(5, 20);
    expect(stats.reviewed).toBe(5);
    expect(stats.eligible).toBe(20);
    expect(stats.notReviewed).toBe(15);
    expect(stats.percentCompleted).toBe(25);
  });

  test("handles zero eligible files", () => {
    const stats = computeStats(0, 0);
    expect(stats.percentCompleted).toBe(0);
    expect(stats.notReviewed).toBe(0);
  });

  test("handles fully reviewed", () => {
    const stats = computeStats(10, 10);
    expect(stats.percentCompleted).toBe(100);
    expect(stats.notReviewed).toBe(0);
  });
});

describe("rewriteReviewedPaths", () => {
  test("rewrites paths under renamed folder", () => {
    const paths = new Set(["folder/a.md", "folder/sub/b.md", "other/c.md"]);
    const changed = rewriteReviewedPaths(paths, "folder", "renamed");
    expect(changed).toBe(true);
    expect(paths.has("renamed/a.md")).toBe(true);
    expect(paths.has("renamed/sub/b.md")).toBe(true);
    expect(paths.has("other/c.md")).toBe(true);
    expect(paths.has("folder/a.md")).toBe(false);
    expect(paths.size).toBe(3);
  });

  test("returns false when no paths match", () => {
    const paths = new Set(["other/a.md"]);
    expect(rewriteReviewedPaths(paths, "folder", "renamed")).toBe(false);
    expect(paths.has("other/a.md")).toBe(true);
  });

  test("does not rewrite path that only shares a prefix", () => {
    const paths = new Set(["folder-extra/a.md"]);
    expect(rewriteReviewedPaths(paths, "folder", "renamed")).toBe(false);
    expect(paths.has("folder-extra/a.md")).toBe(true);
  });
});

describe("removeByPrefix", () => {
  test("removes all paths under folder", () => {
    const paths = new Set(["folder/a.md", "folder/sub/b.md", "other/c.md"]);
    const changed = removeByPrefix(paths, "folder");
    expect(changed).toBe(true);
    expect(paths.size).toBe(1);
    expect(paths.has("other/c.md")).toBe(true);
  });

  test("returns false when no paths match", () => {
    const paths = new Set(["other/a.md"]);
    expect(removeByPrefix(paths, "folder")).toBe(false);
  });

  test("does not remove path that only shares a prefix", () => {
    const paths = new Set(["folder-extra/a.md"]);
    expect(removeByPrefix(paths, "folder")).toBe(false);
    expect(paths.has("folder-extra/a.md")).toBe(true);
  });
});
