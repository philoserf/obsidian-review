# Review Walkthrough

*2026-04-27T14:42:03Z by Showboat 0.6.1*
<!-- showboat-id: dce9cb90-59d9-4376-b648-6737f8a20c52 -->

## Overview

## Architecture

```bash
find . -not -path './.git/*' -not -path './node_modules/*' -not -path './main.js' -not -path './bun.lock' -type f | sort | head -25
```

```output
./.env.local
./.github/dependabot.yml
./.github/settings.yml
./.github/workflows/claude.yml
./.github/workflows/main.yml
./.github/workflows/release.yml
./.gitignore
./.issues/debounced-save-can-lose-excluded-folder-edits.md
./.issues/floating-promises-in-sync-event-handlers.md
./.issues/rename-into-excluded-folder-leaves-stale-reviewed-entries.md
./biome.json
./build.ts
./bunfig.toml
./CHANGELOG.md
./CLAUDE.md
./deploy.ts
./LICENSE
./manifest.json
./package.json
./README.md
./src/__mocks__/obsidian.ts
./src/folderSuggest.ts
./src/main.test.ts
./src/main.ts
./styles.css
```

## Core Walkthrough

### Data Model

The plugin's persisted state is a flat `PluginData` object. It stores reviewed paths as an array (converted to a `Set` at load time for O(1) lookups), excluded folders, and a schema version for migration.

```bash
sed -n '17,32p' src/main.ts
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
};
```

### Pure Functions

Four pure functions are exported for testability. They operate on plain data structures (strings, arrays, Sets) with no Obsidian API dependency.

**`isExcluded`** — path-prefix check with a trailing slash guard so `templates` doesn't match `templates-extra/`:

```bash
sed -n '34,39p' src/main.ts
```

```output
export function isExcluded(
  filePath: string,
  excludedFolders: string[],
): boolean {
  return excludedFolders.some((folder) => filePath.startsWith(`${folder}/`));
}
```

**`computeStats`** — derives review progress from two counts, guarding against division by zero:

```bash
sed -n '41,53p' src/main.ts
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
}
```

**`rewriteReviewedPaths`** — bulk-renames reviewed paths when a folder is renamed. Iterates the Set, swaps old prefix for new, and returns whether anything changed:

```bash
sed -n '55,75p' src/main.ts
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
}
```

**`removeByPrefix`** — the delete counterpart; purges all reviewed paths under a deleted folder:

```bash
sed -n '77,90p' src/main.ts
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
}
```

### Plugin Entry Point

`ReviewPlugin.onload` wires everything together: loads persisted data, adds a ribbon icon and five commands, creates the status bar, registers the settings tab, and subscribes to vault rename/delete events.

```bash
sed -n '92,151p' src/main.ts
```

```output
export default class ReviewPlugin extends Plugin {
  data!: PluginData;
  private reviewedPaths!: Set<string>;
  statusBar!: StatusBar;

  onload = async () => {
    await this.loadSettings();

    this.addRibbonIcon("scan-eye", "Open review", () => {
      this.openReviewMenu();
    });

    this.statusBar = new StatusBar(this.addStatusBarItem(), this);

    this.addCommand({
      id: "open-random-unreviewed",
      name: "Open random unreviewed file",
      callback: () => this.openRandomFile(),
    });
    this.addCommand({
      id: "mark-reviewed",
      name: "Mark file as reviewed",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "not_reviewed") return false;
        if (!checking) this.markReviewed();
        return true;
      },
    });
    this.addCommand({
      id: "mark-reviewed-and-open-next",
      name: "Mark file as reviewed and open next",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "not_reviewed") return false;
        if (!checking) this.markReviewed({ openNext: true });
        return true;
      },
    });
    this.addCommand({
      id: "mark-unreviewed",
      name: "Mark file as unreviewed",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "reviewed") return false;
        if (!checking) this.markUnreviewed();
        return true;
      },
    });
    this.addCommand({
      id: "open-review-menu",
      name: "Open review menu",
      callback: () => this.openReviewMenu(),
    });

    this.addSettingTab(new ReviewSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("rename", this.handleFileRename));
    this.registerEvent(this.app.vault.on("delete", this.handleFileDelete));
    this.registerEvent(
      this.app.workspace.on("file-open", this.statusBar.update),
    );
  };
```

### Settings Load & Migration

`loadSettings` merges saved data with defaults, handles a legacy `settings.showStatusBar` shape from pre-1.2, and strips stale fields (`settings`, `snapshot`). The `reviewedPaths` array is immediately promoted to a `Set`.

```bash
sed -n '153,167p' src/main.ts
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
```

### Core Review Flow

The review loop is: **open random → mark reviewed → open next**. `openRandomFile` filters eligible, unreviewed files and picks one at random. `markReviewed` adds the active file's path to the Set and optionally chains into `openRandomFile`.

```bash
sed -n '213,248p' src/main.ts
```

```output
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
    await this.saveSettings();

    if (openNext) this.openRandomFile();
  };

  markUnreviewed = async () => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    this.reviewedPaths.delete(file.path);
    this.statusBar.update();
    await this.saveSettings();
  };
```

### Vault Event Handlers

The plugin reacts to file renames and deletes to keep `reviewedPaths` in sync. Folder operations delegate to the pure `rewriteReviewedPaths` / `removeByPrefix`; single-file operations swap the path directly.

```bash
sed -n '271,300p' src/main.ts
```

```output
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
      this.statusBar.update();
      await this.saveSettings();
    }
  };
```

### Status Bar

`StatusBar` renders "Reviewed" or "Not reviewed" for the active file and provides a click-to-toggle context menu. It hides when the active file is ineligible or the status bar is disabled in settings.

```bash
sed -n '303,360p' src/main.ts
```

```output
class StatusBar {
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
      this.statusSpan.setText("Reviewed");
    } else {
      this.statusSpan.setText("Not reviewed");
    }
  };

  private onClick = (event: MouseEvent) => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) return;

    const isReviewed = status === "reviewed";
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
}
```

### Review Menu Modal

`ReviewMenuModal` (extends `SuggestModal`) presents context-sensitive actions based on whether the active file is reviewed, not reviewed, or ineligible. It's the primary UI entry point via the ribbon icon and the `open-review-menu` command.

```bash
sed -n '498,565p' src/main.ts
```

```output
class ReviewMenuModal extends SuggestModal<ReviewCommand> {
  plugin: ReviewPlugin;

  constructor(app: App, plugin: ReviewPlugin) {
    super(app);
    this.plugin = plugin;

    const status = this.plugin.getActiveFileStatus();
    if (status === "reviewed") {
      this.setPlaceholder("This file is reviewed");
    } else if (status === "not_reviewed") {
      this.setPlaceholder("This file is not reviewed");
    }
  }

  getSuggestions = (query: string): ReviewCommand[] => {
    const file = this.plugin.getActiveMarkdownFile();
    let suggestions: ReviewCommand[];

    if (!file || !this.plugin.isFileEligible(file.path)) {
      suggestions = [
        { id: "open_random", name: "Open random unreviewed file" },
      ];
    } else {
      const isReviewed = this.plugin.isReviewed(file.path);

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
```

### Folder Suggest

`FolderSuggest` extends Obsidian's `AbstractInputSuggest` to provide autocomplete when typing excluded folder names in settings. It queries `app.vault.getAllFolders()` and filters by the input query.

```bash
cat src/folderSuggest.ts
```

```output
import { AbstractInputSuggest, type App, type TFolder } from "obsidian";

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
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    this.onSelectCallback?.(folder.path);
    this.close();
  }
}
```

### Build System

`build.ts` uses Bun's native bundler. It targets CJS (Obsidian's module format), externalizes `obsidian` and `electron`, and supports a watch mode with debounced rebuilds that skips test files.

```bash
sed -n '5,13p' build.ts
```

```output
async function build() {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: ".",
    format: "cjs",
    external: ["obsidian", "electron"],
    minify: !isWatch,
    sourcemap: isWatch ? "linked" : "none",
  });
```

### Testing

Pure functions are exported from `main.ts` and tested directly. An `__mocks__/obsidian.ts` preload stubs just enough of the Obsidian API (`Plugin`, `Modal`, `Setting`, etc.) for the import graph to resolve under `bun test`.

```bash
grep -c 'test(' src/main.test.ts
```

```output
16
```

```bash
grep 'describe\|test(' src/main.test.ts | head -20
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
```

## Concerns

The repository tracks three known issues in `.issues/`:

1. **Debounced save can lose excluded-folder edits** (medium) — If the user edits an excluded-folder text field and closes the settings tab before the 500ms debounce fires, the change is lost.

2. **Floating promises in sync event handlers** (low) — `handleFileRename` and `handleFileDelete` are `async` but registered via `registerEvent`, which does not await the returned promise. Errors would be unhandled rejections.

3. **Rename into excluded folder leaves stale entries** (low) — Renaming a reviewed file *into* an excluded folder keeps the path in `reviewedPaths` since the rename handler doesn't check exclusion.

Additional observations:

- **Single-module concentration** — `src/main.ts` is 566 lines containing the plugin class, three modal classes, the status bar, and the settings tab. The only extracted module is the 31-line `folderSuggest.ts`. This is manageable for the current size but will become unwieldy as features grow.

- **No integration tests** — Only the four exported pure functions are tested (16 tests). The plugin lifecycle, event handlers, and UI classes are untested, though this is typical for Obsidian plugins given the difficulty of mocking the full API.
