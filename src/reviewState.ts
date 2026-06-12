export function isExcluded(
  filePath: string,
  excludedFolders: string[],
): boolean {
  return excludedFolders.some((folder) => filePath.startsWith(`${folder}/`));
}

export type ReviewStats = {
  reviewed: number;
  eligible: number;
  notReviewed: number;
  percentCompleted: number;
};

/**
 * The reviewed-set state machine, free of Obsidian APIs so it can be
 * tested directly. The plugin owns one instance, feeds it persisted
 * data via load(), and reads reviewedPaths/reviewStartedAt back out
 * when saving.
 */
export class ReviewState {
  reviewedPaths = new Set<string>();
  reviewStartedAt?: string;

  load(paths: string[], startedAt?: string): void {
    this.reviewedPaths = new Set(paths);
    this.reviewStartedAt = startedAt;
  }

  isReviewed(path: string): boolean {
    return this.reviewedPaths.has(path);
  }

  markReviewed(
    path: string,
    now: () => string = () => new Date().toISOString(),
  ): void {
    this.reviewedPaths.add(path);
    if (!this.reviewStartedAt) this.reviewStartedAt = now();
  }

  markUnreviewed(path: string): void {
    this.reviewedPaths.delete(path);
  }

  reset(): void {
    this.reviewedPaths.clear();
    this.reviewStartedAt = undefined;
  }

  pickRandomUnreviewed(
    eligible: string[],
    rng: () => number = Math.random,
  ): string | undefined {
    const unreviewed = eligible.filter((p) => !this.reviewedPaths.has(p));
    if (!unreviewed.length) return undefined;
    return unreviewed[Math.floor(rng() * unreviewed.length)];
  }

  stats(eligible: string[]): ReviewStats {
    const reviewed = eligible.filter((p) => this.reviewedPaths.has(p)).length;
    const eligibleCount = eligible.length;
    return {
      reviewed,
      eligible: eligibleCount,
      notReviewed: eligibleCount - reviewed,
      percentCompleted: eligibleCount
        ? Math.round((reviewed / eligibleCount) * 100)
        : 0,
    };
  }

  renameFile(oldPath: string, newPath: string): boolean {
    if (!this.reviewedPaths.has(oldPath)) return false;
    this.reviewedPaths.delete(oldPath);
    this.reviewedPaths.add(newPath);
    return true;
  }

  renameFolder(oldPath: string, newPath: string): boolean {
    const oldPrefix = `${oldPath}/`;
    const newPrefix = `${newPath}/`;
    const toAdd: string[] = [];
    let changed = false;
    for (const p of this.reviewedPaths) {
      if (p.startsWith(oldPrefix)) {
        this.reviewedPaths.delete(p);
        toAdd.push(newPrefix + p.slice(oldPrefix.length));
        changed = true;
      }
    }
    for (const p of toAdd) {
      this.reviewedPaths.add(p);
    }
    return changed;
  }

  deleteFile(path: string): boolean {
    return this.reviewedPaths.delete(path);
  }

  deleteFolder(folderPath: string): boolean {
    const prefix = `${folderPath}/`;
    let changed = false;
    for (const p of this.reviewedPaths) {
      if (p.startsWith(prefix)) {
        this.reviewedPaths.delete(p);
        changed = true;
      }
    }
    return changed;
  }
}
