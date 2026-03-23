# Obsidian Vault Review Plugin Walkthrough

*2026-03-23T15:00:25Z by Showboat 0.6.1*
<!-- showboat-id: 2bf06234-012d-479b-8bfe-14eeebcf33a8 -->

## Overview

An Obsidian plugin that helps users systematically review every note in their vault. It snapshots all markdown files, then lets you randomly open unreviewed files, mark them reviewed, and track progress via a status bar and settings panel.

**Single-file architecture:** Everything lives in `src/main.ts` (~650 lines). The build produces `main.js` (CJS, minified) via Bun's bundler. `obsidian` and `electron` are external — Obsidian provides them at runtime.

**Key classes:**
- `ReviewPlugin` — Plugin lifecycle, commands, snapshot CRUD, file event handlers
- `StatusBar` — Status bar widget showing current file's review state
- `ReviewSettingTab` — Settings panel with snapshot management and statistics
- `ReviewMenuModal` — Command palette-style modal for review actions
- `ConfirmSnapshotDeleteModal` — Confirmation dialog for snapshot deletion

**Exported pure functions** (tested independently):
- `computeStats()` — Derives review statistics from snapshot data
- `rewritePaths()` — Updates snapshot paths when folders are renamed

## Architecture

Project layout and build configuration:

```bash
cat <<'HEREDOC'
src/main.ts          # All plugin source (~650 lines)
src/main.test.ts     # Tests for pure functions (computeStats, rewritePaths)
build.ts             # Bun bundler config
main.js              # Built output (committed for Obsidian distribution)
styles.css           # Minimal CSS (snapshot info layout)
manifest.json        # Obsidian plugin manifest
versions.json        # Version → minAppVersion mapping
HEREDOC
```

```output
src/main.ts          # All plugin source (~650 lines)
src/main.test.ts     # Tests for pure functions (computeStats, rewritePaths)
build.ts             # Bun bundler config
main.js              # Built output (committed for Obsidian distribution)
styles.css           # Minimal CSS (snapshot info layout)
manifest.json        # Obsidian plugin manifest
versions.json        # Version → minAppVersion mapping
```

The build script is minimal — Bun bundles `src/main.ts` to CJS with `obsidian` and `electron` as externals. Source maps are linked in watch mode only.

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

if (watch) console.log("Watching for changes...");

export {};
```

## Data Model

The plugin persists a flat `PluginData` object via Obsidian's `loadData`/`saveData` (stored as `data.json` in the plugin directory). The `schemaVersion` field enables future migrations.

```bash
sed -n '16,41p' src/main.ts
```

```output
type PluginData = {
  schemaVersion: number;
  snapshot?: Snapshot;
  showStatusBar: boolean;
};

export type SnapshotFile = {
  path: string;
  status: ReviewStatus;
};

type Snapshot = {
  files: SnapshotFile[];
  createdAt: Date;
};

export type ReviewStatus = "to_review" | "reviewed" | "deleted";

type DisplayStatus = ReviewStatus | "new";

const CURRENT_SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS: PluginData = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  showStatusBar: true,
};
```

A `Snapshot` is an array of `SnapshotFile` entries plus a creation date. Each file tracks its path and a three-state `ReviewStatus`: `to_review`, `reviewed`, or `deleted`. The `DisplayStatus` union adds `"new"` for files that exist in the vault but aren't in the snapshot — this is computed at display time, never persisted.

## Pure Functions

Two pure functions are exported for testability. `computeStats` derives all review statistics from raw snapshot data:

```bash
sed -n '43,66p' src/main.ts
```

```output
export function computeStats(
  snapshotFiles: SnapshotFile[],
  allVaultFilesCount: number,
) {
  const total = snapshotFiles.length;
  const deleted = snapshotFiles.filter((f) => f.status === "deleted").length;
  const reviewed = snapshotFiles.filter((f) => f.status === "reviewed").length;
  const toReview = total - reviewed - deleted;
  const active = total - deleted;
  const percentCompleted = active ? Math.round((reviewed / active) * 100) : 0;
  const percentDeleted = total ? Math.round((deleted / total) * 100) : 0;
  const notInSnapshot = allVaultFilesCount - total + deleted;

  return {
    total,
    deleted,
    reviewed,
    toReview,
    active,
    percentCompleted,
    percentDeleted,
    notInSnapshot,
  };
}
```

`rewritePaths` handles folder renames — when Obsidian renames a folder, child files don't get individual rename events. This function rewrites all matching path prefixes in-place and returns whether any changes were made:

```bash
sed -n '68,83p' src/main.ts
```

```output
export function rewritePaths(
  files: SnapshotFile[],
  oldPath: string,
  newPath: string,
): boolean {
  const oldPrefix = `${oldPath}/`;
  const newPrefix = `${newPath}/`;
  let changed = false;
  for (const f of files) {
    if (f.path.startsWith(oldPrefix)) {
      f.path = newPrefix + f.path.slice(oldPrefix.length);
      changed = true;
    }
  }
  return changed;
}
```

The trailing `/` in `oldPrefix` prevents false matches — `folder` won't match `folder-extra/a.md`.

## Plugin Lifecycle

`ReviewPlugin` extends Obsidian's `Plugin` class. `onload` wires up everything: settings, ribbon icon, commands, status bar, and event handlers.

```bash
sed -n '90,147p' src/main.ts
```

```output
  onload = async () => {
    await this.loadSettings();

    this.addRibbonIcon("scan-eye", "Open review", () => {
      this.openReviewMenu();
    });

    this.statusBar = new StatusBar(this.addStatusBarItem(), this);

    this.addCommand({
      id: "open-random-unreviewed",
      name: "Open random unreviewed file",
      callback: () => {
        this.openRandomFile();
      },
    });
    this.addCommand({
      id: "mark-reviewed",
      name: "Mark file as reviewed",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "to_review";
        }

        this.markReviewed();
      },
    });
    this.addCommand({
      id: "mark-reviewed-and-open-next",
      name: "Mark file as reviewed and open next",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "to_review";
        }

        this.markReviewed({ openNext: true });
      },
    });
    this.addCommand({
      id: "mark-unreviewed",
      name: "Mark file as unreviewed",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "reviewed";
        }

        this.markUnreviewed();
      },
    });

    this.addSettingTab(new ReviewSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("rename", this.handleFileRename));
    this.registerEvent(this.app.vault.on("delete", this.handleFileDelete));
    this.registerEvent(
      this.app.workspace.on("file-open", this.statusBar.update),
    );
  };
```

The three `checkCallback` commands use Obsidian's pattern: return a boolean when `checking` is true (to show/hide the command in the palette), execute the action when false.

## Settings & Migration

`loadSettings` spreads saved data over defaults, then handles a migration from the pre-1.2 nested `settings.showStatusBar` shape to the flat `showStatusBar` field. It also deserializes `createdAt` from string back to `Date` (JSON round-trip loses the Date type).

```bash
sed -n '149,168p' src/main.ts
```

```output
  loadSettings = async () => {
    const saved = await this.loadData();
    this.data = {
      ...DEFAULT_SETTINGS,
      ...saved,
    };

    // Migrate from pre-1.2 nested settings shape
    if (
      saved?.settings?.showStatusBar !== undefined &&
      saved.showStatusBar === undefined
    ) {
      this.data.showStatusBar = saved.settings.showStatusBar;
    }
    delete (this.data as Record<string, unknown>).settings;

    if (typeof this.data.snapshot?.createdAt === "string") {
      this.data.snapshot.createdAt = new Date(this.data.snapshot.createdAt);
    }
  };
```

## Core Review Flow

The review loop: `openRandomFile` picks a random unreviewed file → `focusFile` opens it → the user reads it → `markReviewed` updates the status. If a file can't be found (deleted externally, sync conflict), `focusFile` marks it `"deleted"` rather than removing it from the snapshot, preserving statistics.

```bash
sed -n '216,250p' src/main.ts
```

```output
  openRandomFile = () => {
    if (!this.data.snapshot) {
      new Notice("Vault review snapshot is not created");
      return;
    }

    const files = this.getToReviewFiles();
    if (!files.length) {
      new Notice("All files are reviewed");
      return;
    }

    const randomFile = files[Math.floor(Math.random() * files.length)];
    this.focusFile(randomFile, false);
  };

  private focusFile = async (
    file: SnapshotFile,
    newLeaf: boolean | PaneType,
  ) => {
    const targetFile = this.app.vault.getFileByPath(file.path);

    if (targetFile) {
      const leaf = this.app.workspace.getLeaf(newLeaf);
      leaf.openFile(targetFile);
    } else {
      new Notice(`Cannot find file: ${file.path}`);
      const snapshotFile = this.getSnapshotFile(file.path);
      if (snapshotFile) {
        snapshotFile.status = "deleted";
        this.statusBar.update();
        await this.saveSettings();
      }
    }
  };
```

## File Event Handlers

The plugin listens for vault `rename` and `delete` events to keep the snapshot in sync. File renames update the path; folder renames delegate to `rewritePaths`. Deletions mark files as `"deleted"` (soft delete).

```bash
sed -n '328,356p' src/main.ts
```

```output
  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
    if (!this.data.snapshot) return;

    if (file instanceof TFolder) {
      if (rewritePaths(this.data.snapshot.files, oldPath, file.path)) {
        await this.saveSettings();
      }
      return;
    }

    const snapshotFile = this.getSnapshotFile(oldPath);
    if (snapshotFile) {
      snapshotFile.path = file.path;
      await this.saveSettings();
    }
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    if (file instanceof TFolder || !this.data.snapshot) {
      return;
    }

    const snapshotFile = this.getSnapshotFile(file.path);
    if (snapshotFile) {
      snapshotFile.status = "deleted";
      this.statusBar.update();
      await this.saveSettings();
    }
  };
```

## Status Bar

The `StatusBar` class renders a clickable status bar item. It re-evaluates on every `file-open` event. The click handler opens a context menu to toggle review status. Visibility uses Obsidian's built-in `is-hidden` class.

```bash
sed -n '359,421p' src/main.ts
```

```output
class StatusBar {
  element: HTMLElement;
  plugin: ReviewPlugin;
  private statusSpan: Element;

  constructor(element: HTMLElement, plugin: ReviewPlugin) {
    this.element = element;
    this.plugin = plugin;
    this.statusSpan = element.createSpan("status");

    this.statusSpan.setText("Not reviewed");
    element.addClass("mod-clickable");
    element.addEventListener("click", this.onClick);

    this.update();
  }

  update = () => {
    if (!this.plugin.data.snapshot) {
      this.setIsVisible(false);
      return;
    }

    const activeFileStatus = this.plugin.getActiveFileStatus();
    if (!activeFileStatus || activeFileStatus === "deleted") {
      this.setIsVisible(false);
      return;
    }

    this.setIsVisible(this.plugin.data.showStatusBar);

    if (activeFileStatus === "new") {
      this.statusSpan.setText("New file");
    } else if (activeFileStatus === "to_review") {
      this.statusSpan.setText("Not reviewed");
    } else if (activeFileStatus === "reviewed") {
      this.statusSpan.setText("Reviewed");
    } else {
      this.statusSpan.setText("Unknown status");
    }
  };

  private onClick = (event: MouseEvent) => {
    const isReviewed = this.plugin.getActiveFileStatus() === "reviewed";
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle("Reviewed");
      item.setChecked(isReviewed);
      item.onClick(() => this.plugin.markReviewed());
    });
    menu.addItem((item) => {
      item.setTitle("Not reviewed");
      item.setChecked(!isReviewed);
      item.onClick(() => this.plugin.markUnreviewed());
    });

    menu.showAtMouseEvent(event);
  };

  private setIsVisible = (isVisible: boolean) => {
    this.element.toggleClass("is-hidden", !isVisible);
  };
```

## Review Menu Modal

The `ReviewMenuModal` extends Obsidian's `SuggestModal` to provide a command palette for review actions. It adapts suggestions based on the current file's status — reviewed files get "unreview", unreviewed files get "mark reviewed and open next".

```bash
sed -n '574,649p' src/main.ts
```

```output
type ReviewCommand = { id: string; name: string };

const STATUS_DESCRIPTIONS: Partial<Record<DisplayStatus, string>> = {
  new: "This file is not in snapshot",
  to_review: "This file is not reviewed",
  reviewed: "This file is reviewed",
};

class ReviewMenuModal extends SuggestModal<ReviewCommand> {
  plugin: ReviewPlugin;

  constructor(app: App, plugin: ReviewPlugin) {
    super(app);
    this.plugin = plugin;

    const fileStatus = this.plugin.getActiveFileStatus();
    this.setPlaceholder(
      fileStatus ? (STATUS_DESCRIPTIONS[fileStatus] ?? "") : "",
    );
  }

  getSuggestions = (query: string): ReviewCommand[] => {
    const activeFile = this.plugin.getActiveMarkdownFile();
    let suggestions: ReviewCommand[];

    if (!activeFile) {
      suggestions = [
        { id: "open_random", name: "Open random unreviewed file" },
      ];
    } else {
      const isReviewed =
        this.plugin.getSnapshotFile(activeFile.path)?.status === "reviewed";

      if (isReviewed) {
        suggestions = [
          { id: "open_random", name: "Open random unreviewed file" },
          { id: "unreview", name: "Mark file as unreviewed" },
        ];
      } else {
        suggestions = [
          {
            id: "review_and_next",
            name: "Mark file as reviewed and open next",
          },
          { id: "review", name: "Mark file as reviewed" },
          { id: "open_random", name: "Open random unreviewed file" },
        ];
      }
    }

    return suggestions.filter((s) =>
      s.name.toLowerCase().includes(query.toLowerCase()),
    );
  };

  renderSuggestion = (suggestion: ReviewCommand, el: HTMLElement) => {
    el.createEl("div", { text: suggestion.name });
  };

  onChooseSuggestion = (suggestion: ReviewCommand) => {
    switch (suggestion.id) {
      case "open_random":
        this.plugin.openRandomFile();
        break;
      case "review":
        this.plugin.markReviewed();
        break;
      case "review_and_next":
        this.plugin.markReviewed({ openNext: true });
        break;
      case "unreview":
        this.plugin.markUnreviewed();
        break;
    }
  };
}
```

## Tests

Tests cover the two exported pure functions. The test file imports directly from production code — no re-declared types or duplicated logic.

```bash
grep -c 'test(' src/main.test.ts
```

```output
7
```

```bash
grep 'test\|describe' src/main.test.ts
```

```output
import { describe, expect, test } from "bun:test";
describe("computeStats", () => {
  test("mixed snapshot", () => {
  test("empty snapshot", () => {
  test("fully reviewed", () => {
  test("all deleted", () => {
describe("rewritePaths", () => {
  test("rewrites child paths under renamed folder", () => {
  test("returns false when no paths match", () => {
  test("does not rewrite path that only shares a prefix", () => {
```

## Concerns

**Test coverage is limited to pure functions.** The plugin's core behavior — `focusFile`, `markReviewed`, `handleFileRename`, `handleFileDelete`, snapshot creation — has no test coverage. These methods depend on Obsidian's runtime API (`vault.getFileByPath`, `workspace.getLeaf`, etc.), making them hard to unit test without a mock framework. Consider extracting more pure logic (e.g., the snapshot mutation in `markReviewed`) to improve testability.

**Linear search for file lookups.** `getSnapshotFile` does a linear scan (`Array.find`) every time. For vaults with thousands of files this is O(n) per lookup. A `Map<string, SnapshotFile>` index would make lookups O(1), but would need to stay in sync with mutations. Not a problem at current scale, but worth noting.

**No `onunload` cleanup.** The `StatusBar` constructor adds a `click` event listener via `addEventListener`, but never removes it. Obsidian's `Plugin.registerDomEvent` would handle cleanup automatically. The `registerEvent` calls for vault events are correct.

**`createdAt: new Date` vs `new Date()`.** In `ReviewSettingTab.display` line 490, the snapshot creation uses `new Date` (the constructor function reference) instead of `new Date()` (calling it). In this context JavaScript still creates a new Date object, but it's misleading — `new Date()` is the conventional form.

