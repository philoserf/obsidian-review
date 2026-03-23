import { describe, expect, test } from "bun:test";
import { computeStats, type SnapshotFile } from "./main";

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
