import { describe, expect, test } from "bun:test";
import {
  computeStats,
  markFolderDeleted,
  rewritePaths,
  type SnapshotFile,
} from "./main";

function file(path: string, status: SnapshotFile["status"]): SnapshotFile {
  return { path, status };
}

describe("computeStats", () => {
  test("mixed snapshot", () => {
    const files = [
      file("a.md", "reviewed"),
      file("b.md", "to_review"),
      file("c.md", "to_review"),
      file("d.md", "deleted"),
      file("e.md", "reviewed"),
    ];

    const stats = computeStats(files, 10);
    expect(stats.total).toBe(5);
    expect(stats.deleted).toBe(1);
    expect(stats.reviewed).toBe(2);
    expect(stats.toReview).toBe(2);
    expect(stats.active).toBe(4);
    expect(stats.percentCompleted).toBe(50);
    expect(stats.percentDeleted).toBe(20);
    expect(stats.notInSnapshot).toBe(6);
  });

  test("empty snapshot", () => {
    const stats = computeStats([], 10);
    expect(stats.percentCompleted).toBe(0);
    expect(stats.percentDeleted).toBe(0);
    expect(stats.notInSnapshot).toBe(10);
  });

  test("fully reviewed", () => {
    const stats = computeStats(
      [file("a.md", "reviewed"), file("b.md", "reviewed")],
      2,
    );
    expect(stats.percentCompleted).toBe(100);
    expect(stats.toReview).toBe(0);
  });

  test("all deleted", () => {
    const stats = computeStats(
      [file("a.md", "deleted"), file("b.md", "deleted")],
      5,
    );
    expect(stats.percentCompleted).toBe(0);
    expect(stats.percentDeleted).toBe(100);
  });
});

describe("rewritePaths", () => {
  test("rewrites child paths under renamed folder", () => {
    const files = [
      file("folder/a.md", "to_review"),
      file("folder/sub/b.md", "reviewed"),
      file("other/c.md", "to_review"),
    ];
    const changed = rewritePaths(files, "folder", "renamed");
    expect(changed).toBe(true);
    expect(files[0].path).toBe("renamed/a.md");
    expect(files[1].path).toBe("renamed/sub/b.md");
    expect(files[2].path).toBe("other/c.md");
  });

  test("returns false when no paths match", () => {
    const files = [file("other/a.md", "to_review")];
    const changed = rewritePaths(files, "folder", "renamed");
    expect(changed).toBe(false);
    expect(files[0].path).toBe("other/a.md");
  });

  test("does not rewrite path that only shares a prefix", () => {
    const files = [file("folder-extra/a.md", "to_review")];
    const changed = rewritePaths(files, "folder", "renamed");
    expect(changed).toBe(false);
    expect(files[0].path).toBe("folder-extra/a.md");
  });
});

describe("markFolderDeleted", () => {
  test("marks all contained files as deleted", () => {
    const files = [
      file("folder/a.md", "to_review"),
      file("folder/sub/b.md", "reviewed"),
      file("other/c.md", "to_review"),
    ];
    const changed = markFolderDeleted(files, "folder");
    expect(changed).toBe(true);
    expect(files[0].status).toBe("deleted");
    expect(files[1].status).toBe("deleted");
    expect(files[2].status).toBe("to_review");
  });

  test("returns false when no files match", () => {
    const files = [file("other/a.md", "to_review")];
    expect(markFolderDeleted(files, "folder")).toBe(false);
  });

  test("does not match path that only shares a prefix", () => {
    const files = [file("folder-extra/a.md", "to_review")];
    expect(markFolderDeleted(files, "folder")).toBe(false);
    expect(files[0].status).toBe("to_review");
  });

  test("skips files already marked as deleted", () => {
    const files = [
      file("folder/a.md", "deleted"),
      file("folder/b.md", "to_review"),
    ];
    const changed = markFolderDeleted(files, "folder");
    expect(changed).toBe(true);
    expect(files[0].status).toBe("deleted");
    expect(files[1].status).toBe("deleted");
  });

  test("returns false when all contained files already deleted", () => {
    const files = [
      file("folder/a.md", "deleted"),
      file("folder/b.md", "deleted"),
    ];
    expect(markFolderDeleted(files, "folder")).toBe(false);
  });
});
