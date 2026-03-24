# Review Plugin Walkthrough

*2026-03-24T01:26:14Z by Showboat 0.6.1*
<!-- showboat-id: fa7d392e-b720-4120-a4ad-2cde5b226282 -->

## Overview

An Obsidian plugin that helps users randomly review vault notes and track progress. The plugin maintains a `Set<string>` of reviewed file paths — every markdown file in the vault is implicitly part of the review. Files are either reviewed or not reviewed; the vault itself is the source of truth for which files exist.

**Key features:** random file selection, status bar indicator, review menu modal, excluded folders, review reset.

**Tech stack:** TypeScript, Obsidian API, Bun (bundler + test runner), Biome (lint/format).

## Architecture

The plugin is a single-file application (`src/main.ts`) with one utility module (`src/folderSuggest.ts`). Four exported pure functions handle testable logic; the rest is Obsidian API integration.

```bash
find src build.ts version-bump.ts -name '*.ts' | sort | while read f; do echo "$f ($(wc -l < "$f") lines)"; done
```

```output
build.ts (      18 lines)
src/__mocks__/obsidian.ts (      67 lines)
src/folderSuggest.ts (      31 lines)
src/main.test.ts (     107 lines)
src/main.ts (     566 lines)
version-bump.ts (      19 lines)
```

## Data Model

The plugin persists a flat JSON object via Obsidian's `loadData`/`saveData`. At runtime, `reviewedPaths` is deserialized into a `Set<string>` for O(1) lookups.

```bash
sed -n '16,31p' src/main.ts
```

```output

type PluginData = {
  schemaVersion: number;
  reviewedPaths: string[];
  reviewStartedAt?: string;
  excludedFolders: string[];
  showStatusBar: boolean;
};

const CURRENT_SCHEMA_VERSION = 2;

const DEFAULT_DATA: PluginData = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  reviewedPaths: [],
  excludedFolders: [],
  showStatusBar: true,
```

## Exported Functions

Four pure functions are exported for direct testing. They handle exclusion checks, stats computation, and set mutations for folder rename/delete events.

### isExcluded

Checks whether a file path falls under any excluded folder using prefix matching with a trailing slash to avoid false positives (e.g., `templates/` won't match `templates-extra/`).

```bash
sed -n '33,38p' src/main.ts
```

```output

export function isExcluded(
  filePath: string,
  excludedFolders: string[],
): boolean {
  return excludedFolders.some((folder) => filePath.startsWith(`${folder}/`));
```

### computeStats

Derives review statistics from two counts. No access to the file list — the caller provides already-counted values.

```bash
sed -n '40,52p' src/main.ts
```

```output

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
```

### rewriteReviewedPaths

Handles folder renames by updating all reviewed paths under the old prefix. Uses a two-pass approach: collect paths to add in a buffer, then apply them after iteration completes.

```bash
sed -n '54,74p' src/main.ts
```

```output

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
```

### removeByPrefix

Handles folder deletions by removing all reviewed paths under the folder prefix.

```bash
sed -n '76,89p' src/main.ts
```

```output

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
```

## Plugin Lifecycle

`ReviewPlugin` extends Obsidian's `Plugin` base class. On load, it deserializes settings, registers commands, event handlers, and UI elements.

### Settings Load/Save

Settings are loaded from Obsidian's data store, merged with defaults, and migrated from older schema versions. The `reviewedPaths` array is converted to a `Set` for runtime use. On save, the Set is spread back to an array for JSON serialization.

```bash
sed -n '153,172p' src/main.ts
```

```output
  loadSettings = async () => {
    const saved = await this.loadData();
    this.data = { ...DEFAULT_DATA, ...saved };
    // Migrate showStatusBar from pre-1.2 nested settings shape
    if (
      saved?.settings?.showStatusBar !== undefined &&
      saved.showStatusBar === undefined
    ) {
      this.data.showStatusBar = saved.settings.showStatusBar;
    }
    delete (this.data as Record<string, unknown>).settings;
    delete (this.data as Record<string, unknown>).snapshot;
    this.data.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.reviewedPaths = new Set(this.data.reviewedPaths);
  };

  saveSettings = async () => {
    this.data.reviewedPaths = [...this.reviewedPaths];
    await this.saveData(this.data);
  };
```

### File Status and Eligibility

A file's review status is derived at runtime — never stored. `getActiveFileStatus` returns `"reviewed"`, `"not_reviewed"`, or `undefined` (for non-markdown or excluded files).

```bash
sed -n '185,199p' src/main.ts
```

```output
  isFileEligible = (path: string): boolean => {
    return !isExcluded(path, this.data.excludedFolders);
  };

  getEligibleFiles = (): TFile[] => {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.isFileEligible(f.path));
  };

  getActiveFileStatus = (): "reviewed" | "not_reviewed" | undefined => {
    const file = this.getActiveMarkdownFile();
    if (!file || !this.isFileEligible(file.path)) return undefined;
    return this.isReviewed(file.path) ? "reviewed" : "not_reviewed";
  };
```

### Core Review Operations

`markReviewed` adds a path to the reviewed set and sets `reviewStartedAt` on first use. `markUnreviewed` removes it. `resetReview` clears the entire set after confirmation. `openRandomFile` picks from eligible unreviewed files.

```bash
sed -n '211,235p' src/main.ts
```

```output
  };

  openRandomFile = () => {
    const files = this.getEligibleFiles().filter(
      (f) => !this.isReviewed(f.path),
    );
    if (!files.length) {
      new Notice("All files are reviewed");
      return;
    }
    const randomFile = files[Math.floor(Math.random() * files.length)];
    const leaf = this.app.workspace.getLeaf(false);
    leaf.openFile(randomFile);
  };

  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    this.reviewedPaths.add(file.path);
    if (!this.data.reviewStartedAt) {
      this.data.reviewStartedAt = new Date().toISOString();
    }

    this.statusBar.update();
```

### Event Handlers

Vault rename and delete events keep the reviewed set in sync. Folder operations delegate to the exported pure functions; single-file operations use direct Set manipulation.

```bash
sed -n '267,296p' src/main.ts
```

```output
      modal.open();
    });
  };

  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
    if (file instanceof TFolder) {
      if (rewriteReviewedPaths(this.reviewedPaths, oldPath, file.path)) {
        await this.saveSettings();
      }
      return;
    }

    if (this.isReviewed(oldPath)) {
      this.reviewedPaths.delete(oldPath);
      this.reviewedPaths.add(file.path);
      await this.saveSettings();
    }
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    if (file instanceof TFolder) {
      if (removeByPrefix(this.reviewedPaths, file.path)) {
        this.statusBar.update();
        await this.saveSettings();
      }
      return;
    }

    if (this.isReviewed(file.path)) {
      this.reviewedPaths.delete(file.path);
```

## UI Components

### StatusBar

Displays "Reviewed" or "Not reviewed" for the active file. Hidden when the file is non-markdown, excluded, or the setting is disabled. The click listener is registered via `plugin.registerDomEvent` so Obsidian automatically removes it on plugin unload.

```bash
sed -n '304,329p' src/main.ts
```

```output
  private element: HTMLElement;
  private plugin: ReviewPlugin;
  private statusSpan: Element;

  constructor(element: HTMLElement, plugin: ReviewPlugin) {
    this.element = element;
    this.plugin = plugin;
    this.statusSpan = element.createSpan("status");

    this.statusSpan.setText("Not reviewed");
    element.addClass("mod-clickable");
    plugin.registerDomEvent(element, "click", this.onClick);

    this.update();
  }

  update = () => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) {
      this.setIsVisible(false);
      return;
    }

    this.setIsVisible(this.plugin.data.showStatusBar);

    if (status === "reviewed") {
```

### FolderSuggest

Autocomplete component for excluded folder inputs. Extends Obsidian's `AbstractInputSuggest` and queries `app.vault.getAllFolders()` for suggestions.

```bash
sed -n '3,19p' src/folderSuggest.ts
```

```output
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private onSelectCallback?: (value: string) => void;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    onSelectCallback?: (value: string) => void,
  ) {
    super(app, inputEl);
    this.onSelectCallback = onSelectCallback;
  }

  getSuggestions(query: string): TFolder[] {
    const lowerQuery = query.toLowerCase();
    return this.app.vault
      .getAllFolders()
      .filter((folder) => folder.path.toLowerCase().includes(lowerQuery));
```

### Settings Panel

The settings tab shows review progress stats, a reset button, excluded folder management with autocomplete, and a status bar toggle. Stats are derived at render time from the vault and reviewed set. Excluded folder saves are debounced at 500ms to avoid writing on every keystroke.

```bash
sed -n '386,398p' src/main.ts
```

```output
        await this.plugin.resetReview();
        this.display();
      });
    });

    const eligible = this.plugin.getEligibleFiles();
    const reviewedCount = this.plugin.getReviewedCount(eligible);
    const stats = computeStats(reviewedCount, eligible.length);

    containerEl.createDiv("review-stats", (div) => {
      div.createEl("p").setText(`Eligible files: ${stats.eligible}`);
      div
        .createEl("p")
```

## Build System

`build.ts` uses Bun's native bundler. The `--watch` flag toggles between dev (no minification, sourcemaps) and production (minified, no sourcemaps). The `dev` script uses `bun --watch` to re-run the build on file changes.

```bash
cat build.ts
```

```output
const watch = process.argv.includes("--watch");

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: ".",
  format: "cjs",
  external: ["obsidian", "electron"],
  minify: !watch,
  sourcemap: watch ? "linked" : "none",
});

if (!result.success) {
  console.error("Build failed");
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

export {};
```

## Tests

Tests cover the four exported pure functions. Tests run via Bun's built-in test runner with an Obsidian mock preloaded.

```bash
grep -c 'test(' src/main.test.ts
```

```output
16
```

```bash
grep 'describe\|  test(' src/main.test.ts
```

```output
import { describe, expect, test } from "bun:test";
describe("isExcluded", () => {
  test("excludes file in excluded folder", () => {
  test("excludes file in nested subfolder", () => {
  test("does not exclude file outside excluded folders", () => {
  test("does not exclude file with matching prefix but no slash", () => {
  test("handles multiple excluded folders", () => {
  test("returns false for empty excluded list", () => {
  test("does not exclude root-level file", () => {
describe("computeStats", () => {
  test("computes stats for partial review", () => {
  test("handles zero eligible files", () => {
  test("handles fully reviewed", () => {
describe("rewriteReviewedPaths", () => {
  test("rewrites paths under renamed folder", () => {
  test("returns false when no paths match", () => {
  test("does not rewrite path that only shares a prefix", () => {
describe("removeByPrefix", () => {
  test("removes all paths under folder", () => {
  test("returns false when no paths match", () => {
  test("does not remove path that only shares a prefix", () => {
```

## Concerns

1. **No integration tests.** Only pure functions are tested. Plugin behavior (command guards, event handlers, settings persistence) relies on manual testing in Obsidian.

2. **`saveSettings` serializes the full Set on every call.** At scale (~2,400 reviewed paths), each save allocates a new array and writes JSON to disk. Acceptable for user-initiated actions; excluded folder text input is debounced to mitigate.

3. **`getEligibleFiles` scans the vault on every call.** Called when opening a random file. Acceptable at ~2,400 files but won't scale to very large vaults.

