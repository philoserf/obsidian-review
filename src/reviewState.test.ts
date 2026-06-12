import { describe, expect, test } from "bun:test";
import { isExcluded, ReviewState } from "./reviewState";

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

function stateWith(paths: string[], startedAt?: string): ReviewState {
  const state = new ReviewState();
  state.load(paths, startedAt);
  return state;
}

describe("load", () => {
  test("replaces existing state", () => {
    const state = stateWith(["a.md"], "2026-01-01T00:00:00.000Z");
    state.load(["b.md"]);
    expect(state.isReviewed("a.md")).toBe(false);
    expect(state.isReviewed("b.md")).toBe(true);
    expect(state.reviewStartedAt).toBeUndefined();
  });
});

describe("markReviewed", () => {
  test("adds the path", () => {
    const state = new ReviewState();
    state.markReviewed("a.md");
    expect(state.isReviewed("a.md")).toBe(true);
  });

  test("starts the review clock on first mark only", () => {
    const state = new ReviewState();
    state.markReviewed("a.md", () => "first");
    state.markReviewed("b.md", () => "second");
    expect(state.reviewStartedAt).toBe("first");
  });

  test("keeps an existing review clock", () => {
    const state = stateWith(["a.md"], "loaded");
    state.markReviewed("b.md", () => "later");
    expect(state.reviewStartedAt).toBe("loaded");
  });
});

describe("markUnreviewed", () => {
  test("removes the path but keeps the review clock", () => {
    const state = stateWith(["a.md"], "loaded");
    state.markUnreviewed("a.md");
    expect(state.isReviewed("a.md")).toBe(false);
    expect(state.reviewStartedAt).toBe("loaded");
  });
});

describe("reset", () => {
  test("clears paths and the review clock", () => {
    const state = stateWith(["a.md", "b.md"], "loaded");
    state.reset();
    expect(state.reviewedPaths.size).toBe(0);
    expect(state.reviewStartedAt).toBeUndefined();
  });
});

describe("pickRandomUnreviewed", () => {
  test("picks only from unreviewed files", () => {
    const state = stateWith(["a.md"]);
    const eligible = ["a.md", "b.md", "c.md"];
    expect(state.pickRandomUnreviewed(eligible, () => 0)).toBe("b.md");
    expect(state.pickRandomUnreviewed(eligible, () => 0.99)).toBe("c.md");
  });

  test("returns undefined when everything is reviewed", () => {
    const state = stateWith(["a.md"]);
    expect(state.pickRandomUnreviewed(["a.md"])).toBeUndefined();
  });

  test("returns undefined for no eligible files", () => {
    expect(new ReviewState().pickRandomUnreviewed([])).toBeUndefined();
  });
});

describe("stats", () => {
  test("computes stats for partial review", () => {
    const state = stateWith(["a.md", "b.md", "elsewhere.md"]);
    const eligible = ["a.md", "b.md", "c.md", "d.md"];
    expect(state.stats(eligible)).toEqual({
      reviewed: 2,
      eligible: 4,
      notReviewed: 2,
      percentCompleted: 50,
    });
  });

  test("handles zero eligible files", () => {
    const stats = new ReviewState().stats([]);
    expect(stats.percentCompleted).toBe(0);
    expect(stats.notReviewed).toBe(0);
  });

  test("handles fully reviewed", () => {
    const state = stateWith(["a.md"]);
    const stats = state.stats(["a.md"]);
    expect(stats.percentCompleted).toBe(100);
    expect(stats.notReviewed).toBe(0);
  });
});

describe("renameFile", () => {
  test("moves a reviewed path", () => {
    const state = stateWith(["a.md"]);
    expect(state.renameFile("a.md", "b.md")).toBe(true);
    expect(state.isReviewed("b.md")).toBe(true);
    expect(state.isReviewed("a.md")).toBe(false);
  });

  test("returns false for an unreviewed path", () => {
    const state = stateWith(["a.md"]);
    expect(state.renameFile("x.md", "y.md")).toBe(false);
  });
});

describe("renameFolder", () => {
  test("rewrites paths under renamed folder", () => {
    const state = stateWith(["folder/a.md", "folder/sub/b.md", "other/c.md"]);
    expect(state.renameFolder("folder", "renamed")).toBe(true);
    expect(state.isReviewed("renamed/a.md")).toBe(true);
    expect(state.isReviewed("renamed/sub/b.md")).toBe(true);
    expect(state.isReviewed("other/c.md")).toBe(true);
    expect(state.isReviewed("folder/a.md")).toBe(false);
    expect(state.reviewedPaths.size).toBe(3);
  });

  test("returns false when no paths match", () => {
    const state = stateWith(["other/a.md"]);
    expect(state.renameFolder("folder", "renamed")).toBe(false);
    expect(state.isReviewed("other/a.md")).toBe(true);
  });

  test("does not rewrite path that only shares a prefix", () => {
    const state = stateWith(["folder-extra/a.md"]);
    expect(state.renameFolder("folder", "renamed")).toBe(false);
    expect(state.isReviewed("folder-extra/a.md")).toBe(true);
  });
});

describe("deleteFile", () => {
  test("removes a reviewed path", () => {
    const state = stateWith(["a.md"]);
    expect(state.deleteFile("a.md")).toBe(true);
    expect(state.isReviewed("a.md")).toBe(false);
  });

  test("returns false for an unreviewed path", () => {
    expect(new ReviewState().deleteFile("a.md")).toBe(false);
  });
});

describe("deleteFolder", () => {
  test("removes all paths under folder", () => {
    const state = stateWith(["folder/a.md", "folder/sub/b.md", "other/c.md"]);
    expect(state.deleteFolder("folder")).toBe(true);
    expect(state.reviewedPaths.size).toBe(1);
    expect(state.isReviewed("other/c.md")).toBe(true);
  });

  test("returns false when no paths match", () => {
    expect(stateWith(["other/a.md"]).deleteFolder("folder")).toBe(false);
  });

  test("does not remove path that only shares a prefix", () => {
    const state = stateWith(["folder-extra/a.md"]);
    expect(state.deleteFolder("folder")).toBe(false);
    expect(state.isReviewed("folder-extra/a.md")).toBe(true);
  });
});
