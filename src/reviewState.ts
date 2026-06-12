export function isExcluded(
  filePath: string,
  excludedFolders: string[],
): boolean {
  return excludedFolders.some((folder) => filePath.startsWith(`${folder}/`));
}

export function computeStats(reviewedCount: number, eligibleCount: number) {
  const notReviewed = eligibleCount - reviewedCount;
  const percentCompleted = eligibleCount
    ? Math.round((reviewedCount / eligibleCount) * 100)
    : 0;

  return {
    reviewed: reviewedCount,
    eligible: eligibleCount,
    notReviewed,
    percentCompleted,
  };
}

export function rewriteReviewedPaths(
  reviewedPaths: Set<string>,
  oldPath: string,
  newPath: string,
): boolean {
  const oldPrefix = `${oldPath}/`;
  const newPrefix = `${newPath}/`;
  const toAdd: string[] = [];
  let changed = false;
  for (const p of reviewedPaths) {
    if (p.startsWith(oldPrefix)) {
      reviewedPaths.delete(p);
      toAdd.push(newPrefix + p.slice(oldPrefix.length));
      changed = true;
    }
  }
  for (const p of toAdd) {
    reviewedPaths.add(p);
  }
  return changed;
}

export function removeByPrefix(
  reviewedPaths: Set<string>,
  folderPath: string,
): boolean {
  const prefix = `${folderPath}/`;
  let changed = false;
  for (const p of reviewedPaths) {
    if (p.startsWith(prefix)) {
      reviewedPaths.delete(p);
      changed = true;
    }
  }
  return changed;
}
