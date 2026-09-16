import { describe, expect, test } from "bun:test";
import { Review } from "./review";

function reviewWith(
  paths: string[],
  excludedFolders: string[] = [],
  startedAt?: string,
): Review {
  const review = new Review();
  review.load(paths, excludedFolders, startedAt);
  return review;
}

describe("isEligible", () => {
  test("excludes a file in an excluded folder", () => {
    expect(reviewWith([], ["templates"]).isEligible("templates/note.md")).toBe(
      false,
    );
  });

  test("excludes a file in a nested subfolder", () => {
    expect(
      reviewWith([], ["templates"]).isEligible("templates/sub/note.md"),
    ).toBe(false);
  });

  // The `${folder}/` boundary: "templates" must not match "templates-extra".
  test("does not exclude a path that only shares a prefix", () => {
    expect(
      reviewWith([], ["templates"]).isEligible("templates-extra/note.md"),
    ).toBe(true);
  });

  test("does not exclude a root-level file", () => {
    expect(reviewWith([], ["templates"]).isEligible("note.md")).toBe(true);
  });
});

describe("setExcludedFolders", () => {
  test("trims whitespace and strips trailing slashes", () => {
    const review = new Review();
    review.setExcludedFolders([" Templates ", "Daily//"]);
    expect(review.excludedFolders).toEqual(["Templates", "Daily"]);
  });

  test("drops empty entries", () => {
    const review = new Review();
    review.setExcludedFolders(["Templates", "", "   ", "/"]);
    expect(review.excludedFolders).toEqual(["Templates"]);
  });

  test("dedupes entries that normalize to the same folder", () => {
    const review = new Review();
    review.setExcludedFolders(["Templates", "Templates/", " Templates"]);
    expect(review.excludedFolders).toEqual(["Templates"]);
  });

  test("a normalized entry actually excludes", () => {
    const review = new Review();
    review.setExcludedFolders([" Templates/ "]);
    expect(review.isEligible("Templates/note.md")).toBe(false);
  });
});

describe("load", () => {
  test("replaces existing state", () => {
    const review = reviewWith(["a.md"], ["old"], "2026-01-01T00:00:00.000Z");
    review.load(["b.md"], ["new"]);
    expect(review.isReviewed("a.md")).toBe(false);
    expect(review.isReviewed("b.md")).toBe(true);
    expect(review.excludedFolders).toEqual(["new"]);
    expect(review.reviewStartedAt).toBeUndefined();
  });

  // The disk path. A synced or hand-edited data.json can hold anything, and an
  // entry with a trailing slash matches nothing because isEligible tests for a
  // `${folder}/` prefix — the user sees the folder listed as excluded and its
  // notes keep appearing in review.
  test("normalizes folders coming off disk", () => {
    const review = new Review();
    review.load([], ["Templates/", " Daily ", "", "Daily"]);
    expect(review.excludedFolders).toEqual(["Templates", "Daily"]);
    expect(review.isEligible("Templates/note.md")).toBe(false);
    expect(review.isEligible("Daily/note.md")).toBe(false);
  });
});

describe("markReviewed", () => {
  test("starts the review clock on first mark only", () => {
    const review = new Review();
    review.markReviewed("a.md", () => "first");
    review.markReviewed("b.md", () => "second");
    expect(review.reviewStartedAt).toBe("first");
  });

  test("keeps an existing review clock", () => {
    const review = reviewWith(["a.md"], [], "loaded");
    review.markReviewed("b.md", () => "later");
    expect(review.reviewStartedAt).toBe("loaded");
  });
});

describe("markUnreviewed", () => {
  test("removes the path but keeps the review clock", () => {
    const review = reviewWith(["a.md"], [], "loaded");
    review.markUnreviewed("a.md");
    expect(review.isReviewed("a.md")).toBe(false);
    expect(review.reviewStartedAt).toBe("loaded");
  });
});

describe("reset", () => {
  test("clears paths and the review clock", () => {
    const review = reviewWith(["a.md", "b.md"], [], "loaded");
    review.reset();
    expect(review.reviewedPaths.size).toBe(0);
    expect(review.reviewStartedAt).toBeUndefined();
  });

  test("leaves excluded folders alone", () => {
    const review = reviewWith(["a.md"], ["templates"]);
    review.reset();
    expect(review.excludedFolders).toEqual(["templates"]);
  });
});

describe("stats", () => {
  test("computes stats for partial review", () => {
    const review = reviewWith(["a.md", "b.md", "elsewhere.md"]);
    expect(review.stats(["a.md", "b.md", "c.md", "d.md"])).toEqual({
      reviewed: 2,
      eligible: 4,
      percentCompleted: 50,
    });
  });

  test("handles zero eligible files", () => {
    expect(new Review().stats([]).percentCompleted).toBe(0);
  });
});

describe("rename a file", () => {
  test("moves a reviewed path", () => {
    const review = reviewWith(["a.md"]);
    expect(review.rename("a.md", "b.md", false)).toBe(true);
    expect(review.isReviewed("b.md")).toBe(true);
    expect(review.isReviewed("a.md")).toBe(false);
  });

  test("returns false for an unreviewed path", () => {
    expect(reviewWith(["a.md"]).rename("x.md", "y.md", false)).toBe(false);
  });

  test("never touches excluded folders", () => {
    const review = reviewWith([], ["Templates"]);
    expect(review.rename("Templates", "Renamed", false)).toBe(false);
    expect(review.excludedFolders).toEqual(["Templates"]);
  });
});

describe("rename a folder", () => {
  // renameFolder maps entries independently, so a rename can collide two
  // exclusions onto the same path.
  test("dedupes when a rename collides two exclusions", () => {
    const review = reviewWith([], ["A", "B"]);
    review.rename("B", "A", true);
    expect(review.excludedFolders).toEqual(["A"]);
  });

  test("dedupes when a nested exclusion collides with its parent", () => {
    const review = reviewWith([], ["Meta", "Meta/Templates"]);
    review.rename("Meta/Templates", "Meta", true);
    expect(review.excludedFolders).toEqual(["Meta"]);
  });

  test("rewrites reviewed paths under it", () => {
    const review = reviewWith(["folder/a.md", "folder/sub/b.md", "other/c.md"]);
    expect(review.rename("folder", "renamed", true)).toBe(true);
    expect(review.isReviewed("renamed/a.md")).toBe(true);
    expect(review.isReviewed("renamed/sub/b.md")).toBe(true);
    expect(review.isReviewed("other/c.md")).toBe(true);
    expect(review.reviewedPaths.size).toBe(3);
  });

  // #80: excluding Templates then moving it silently un-excluded everything
  // in it, while the settings tab went on listing the old path.
  test("rewrites the excluded folder itself", () => {
    const review = reviewWith([], ["Templates"]);
    expect(review.rename("Templates", "Meta/Templates", true)).toBe(true);
    expect(review.excludedFolders).toEqual(["Meta/Templates"]);
    expect(review.isEligible("Meta/Templates/note.md")).toBe(false);
  });

  test("rewrites an excluded folder nested under the renamed one", () => {
    const review = reviewWith([], ["Meta/Templates"]);
    expect(review.rename("Meta", "Admin", true)).toBe(true);
    expect(review.excludedFolders).toEqual(["Admin/Templates"]);
  });

  test("returns false when nothing matches", () => {
    const review = reviewWith(["other/a.md"], ["other"]);
    expect(review.rename("folder", "renamed", true)).toBe(false);
    expect(review.isReviewed("other/a.md")).toBe(true);
    expect(review.excludedFolders).toEqual(["other"]);
  });

  test("does not rewrite a path that only shares a prefix", () => {
    const review = reviewWith(["folder-extra/a.md"], ["folder-extra"]);
    expect(review.rename("folder", "renamed", true)).toBe(false);
    expect(review.isReviewed("folder-extra/a.md")).toBe(true);
    expect(review.excludedFolders).toEqual(["folder-extra"]);
  });
});

describe("remove a folder", () => {
  test("removes all reviewed paths under it", () => {
    const review = reviewWith(["folder/a.md", "folder/sub/b.md", "other/c.md"]);
    expect(review.remove("folder", true)).toBe(true);
    expect(review.reviewedPaths.size).toBe(1);
    expect(review.isReviewed("other/c.md")).toBe(true);
  });

  test("drops the excluded folder and its descendants", () => {
    const review = reviewWith([], ["folder", "folder/sub", "other"]);
    expect(review.remove("folder", true)).toBe(true);
    expect(review.excludedFolders).toEqual(["other"]);
  });

  test("returns false when nothing matches", () => {
    expect(reviewWith(["other/a.md"], ["other"]).remove("folder", true)).toBe(
      false,
    );
  });

  test("does not remove a path that only shares a prefix", () => {
    const review = reviewWith(["folder-extra/a.md"], ["folder-extra"]);
    expect(review.remove("folder", true)).toBe(false);
    expect(review.isReviewed("folder-extra/a.md")).toBe(true);
    expect(review.excludedFolders).toEqual(["folder-extra"]);
  });
});
