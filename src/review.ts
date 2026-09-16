export type ReviewStats = {
  reviewed: number;
  eligible: number;
  percentCompleted: number;
};

/**
 * Every persisted review field under one owner, free of Obsidian APIs so it can
 * be tested directly. The plugin owns one instance, feeds it persisted data via
 * load(), and reads the fields back out when saving.
 *
 * The vault is the source of truth for what exists, so rename()/remove()
 * reconcile the stored paths against it rather than maintaining an
 * authoritative file list. That reconciliation covers excludedFolders too — it
 * lives here for exactly that reason.
 */
/**
 * The only way in. A folder that is not trimmed of whitespace or stripped of
 * trailing slashes matches nothing, silently, because `isEligible` tests for a
 * `${folder}/` prefix. Every writer of `excludedFolders` runs through here:
 * `setExcludedFolders` (the UI), `load` (the disk), and `renameFolder` (vault
 * reconciliation, which maps entries independently and can collide two onto one).
 */
function normalizeFolders(list: string[]): string[] {
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

export class Review {
  reviewedPaths = new Set<string>();
  reviewStartedAt?: string;
  excludedFolders: string[] = [];

  load(paths: string[], excludedFolders: string[], startedAt?: string): void {
    this.reviewedPaths = new Set(paths);
    this.excludedFolders = normalizeFolders(excludedFolders);
    this.reviewStartedAt = startedAt;
  }

  isEligible(path: string): boolean {
    return !this.excludedFolders.some((folder) =>
      path.startsWith(`${folder}/`),
    );
  }

  /**
   * One of three writers, all of which go through `normalizeFolders`. It is the
   * function, not this method, that is the only way in — see its docstring.
   */
  setExcludedFolders(list: string[]): void {
    this.excludedFolders = normalizeFolders(list);
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

  stats(eligible: string[]): ReviewStats {
    const reviewed = eligible.filter((p) => this.reviewedPaths.has(p)).length;
    const eligibleCount = eligible.length;
    return {
      reviewed,
      eligible: eligibleCount,
      percentCompleted: eligibleCount
        ? Math.round((reviewed / eligibleCount) * 100)
        : 0,
    };
  }

  rename(oldPath: string, newPath: string, isFolder: boolean): boolean {
    if (!isFolder) {
      if (!this.reviewedPaths.has(oldPath)) return false;
      this.reviewedPaths.delete(oldPath);
      this.reviewedPaths.add(newPath);
      return true;
    }
    return this.renameFolder(oldPath, newPath);
  }

  remove(path: string, isFolder: boolean): boolean {
    return isFolder ? this.removeFolder(path) : this.reviewedPaths.delete(path);
  }

  private renameFolder(oldPath: string, newPath: string): boolean {
    const oldPrefix = `${oldPath}/`;
    const newPrefix = `${newPath}/`;
    let changed = false;

    const moved: string[] = [];
    for (const p of this.reviewedPaths) {
      if (p.startsWith(oldPrefix)) {
        this.reviewedPaths.delete(p);
        moved.push(newPrefix + p.slice(oldPrefix.length));
        changed = true;
      }
    }
    for (const p of moved) this.reviewedPaths.add(p);

    // The excluded folder itself, and any excluded folder beneath it.
    this.excludedFolders = normalizeFolders(
      this.excludedFolders.map((folder) => {
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

    return changed;
  }

  private removeFolder(folderPath: string): boolean {
    const prefix = `${folderPath}/`;
    let changed = false;

    for (const p of this.reviewedPaths) {
      if (p.startsWith(prefix)) {
        this.reviewedPaths.delete(p);
        changed = true;
      }
    }

    const kept = this.excludedFolders.filter(
      (folder) => folder !== folderPath && !folder.startsWith(prefix),
    );
    if (kept.length !== this.excludedFolders.length) {
      this.excludedFolders = kept;
      changed = true;
    }

    return changed;
  }
}
