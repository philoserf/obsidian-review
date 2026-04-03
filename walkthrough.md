# Obsidian Review Plugin Walkthrough

*2026-04-03T18:39:34Z by Showboat 0.6.1*
<!-- showboat-id: 7c052422-77a0-466e-be5e-d9c1dcd9461b -->

## Overview

**Obsidian Review** is a community plugin for [Obsidian](https://obsidian.md) that lets users randomly review vault notes and track their progress. It presents unreviewed markdown files one at a time, marks them as reviewed, and persists progress across sessions.

**Key technologies:** TypeScript, Bun (runtime & bundler), Biome (lint/format), Obsidian Plugin API.

**Entry point:** `src/main.ts` — exports `ReviewPlugin`, the `Plugin` subclass Obsidian loads.

**Source files:**
- `src/main.ts` — Plugin class, data model, commands, settings UI, status bar, modals
- `src/folderSuggest.ts` — Autocomplete suggest for folder exclusion input
- `src/main.test.ts` — Unit tests for pure logic functions
- `src/__mocks__/obsidian.ts` — Mock of the `obsidian` module for Bun test runner
- `build.ts` — Build script using Bun's native bundler
- `version-bump.ts` — Syncs version from `package.json` to `manifest.json` and `versions.json`

## Architecture

### Directory Layout

```bash
cat <<'HEREDOC'
obsidian-review/
├── src/
│   ├── main.ts            # Plugin class, commands, settings, modals
│   ├── folderSuggest.ts   # Folder autocomplete for settings
│   ├── main.test.ts       # Unit tests (bun:test)
│   └── __mocks__/
│       └── obsidian.ts    # Mock obsidian module for tests
├── build.ts               # Bun bundler script
├── version-bump.ts        # Version sync across manifest files
├── biome.json             # Linter/formatter config
├── tsconfig.json          # TypeScript config
├── manifest.json          # Obsidian plugin manifest
├── versions.json          # Version → minAppVersion mapping
├── styles.css             # Plugin styles
├── main.js                # Built output (CJS)
└── package.json           # Project metadata & scripts
HEREDOC
```

```output
obsidian-review/
├── src/
│   ├── main.ts            # Plugin class, commands, settings, modals
│   ├── folderSuggest.ts   # Folder autocomplete for settings
│   ├── main.test.ts       # Unit tests (bun:test)
│   └── __mocks__/
│       └── obsidian.ts    # Mock obsidian module for tests
├── build.ts               # Bun bundler script
├── version-bump.ts        # Version sync across manifest files
├── biome.json             # Linter/formatter config
├── tsconfig.json          # TypeScript config
├── manifest.json          # Obsidian plugin manifest
├── versions.json          # Version → minAppVersion mapping
├── styles.css             # Plugin styles
├── main.js                # Built output (CJS)
└── package.json           # Project metadata & scripts
```

### Data Flow

1. Obsidian loads the plugin → `onload()` runs
2. Plugin reads persisted `PluginData` from disk → merges with defaults → builds a `Set<string>` of reviewed paths
3. User triggers a command (ribbon icon, command palette, status bar click) → plugin queries eligible files, filters by reviewed status, picks one at random
4. User marks a file reviewed → path added to the Set → data saved to disk
5. File renames/deletes → plugin rewrites or removes affected paths from the Set

All state lives in a single JSON blob managed by the Obsidian `Plugin.loadData()`/`saveData()` API. The in-memory `Set<string>` is the authoritative runtime copy; it serializes back to an array on save.

## Core Walkthrough

### Data Model

The plugin persists a flat `PluginData` object. Schema version 2 removed a legacy nested `settings` and `snapshot` shape.

```bash
head -32 src/main.ts | tail -16
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

### Pure Utility Functions

Four pure functions are exported for testability. They handle path matching, stats computation, and bulk path rewriting.

**`isExcluded`** checks whether a file path falls under any excluded folder using a prefix match with a trailing slash (preventing `templates-extra/` from matching `templates/`).

```bash
head -39 src/main.ts | tail -6
```

```output
export function isExcluded(
  filePath: string,
  excludedFolders: string[],
): boolean {
  return excludedFolders.some((folder) => filePath.startsWith(`${folder}/`));
}
```

**`computeStats`** derives review progress from counts — no side effects, no dependencies.

```bash
head -53 src/main.ts | tail -12
```

```output
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

**`rewriteReviewedPaths`** handles folder renames — rewrites all paths under the old prefix to the new one. Mutates the Set in place, returns whether anything changed.

**`removeByPrefix`** handles folder deletions — removes all paths under a folder prefix.

Both use the same `${folder}/` prefix guard to avoid false matches.

```bash
head -90 src/main.ts | tail -35
```

```output
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
```

### Plugin Lifecycle

`ReviewPlugin` extends `Plugin`. Obsidian calls `onload()` at startup. The plugin:
1. Loads and migrates persisted data
2. Adds a ribbon icon (eye icon) that opens the review menu
3. Creates a clickable status bar element
4. Registers five commands
5. Registers vault event handlers for rename and delete
6. Adds a settings tab

```bash
head -151 src/main.ts | tail -59
```

```output
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

`loadSettings` merges saved data with defaults. It also handles migration from a pre-1.2 schema where `showStatusBar` was nested inside a `settings` object. Legacy `settings` and `snapshot` keys are deleted, and the schema version is bumped to current.

```bash
head -167 src/main.ts | tail -15
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

### Core Actions

**Opening a random file:** Filters eligible files to those not yet reviewed, picks one at random via `Math.random()`, and opens it in the current leaf.

**Marking reviewed:** Adds the active file's path to the Set, records `reviewStartedAt` on first mark, saves, and optionally opens the next random file.

**Reset:** Clears all progress after a confirmation modal.

```bash
head -262 src/main.ts | tail -50
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

  resetReview = async ({
    confirm = true,
  }: {
    confirm?: boolean;
  } = {}): Promise<boolean> => {
    if (confirm && !(await this.confirmReset())) return false;

    this.reviewedPaths.clear();
    this.data.reviewStartedAt = undefined;
    this.statusBar.update();
    await this.saveSettings();
    return true;
  };
```

### Vault Event Handlers

The plugin listens for file renames and deletes to keep the reviewed paths Set consistent. Both handle files and folders differently — folder operations use the bulk `rewriteReviewedPaths` / `removeByPrefix` helpers.

```bash
head -300 src/main.ts | tail -30
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

The `StatusBar` class manages a clickable status bar element that shows "Reviewed" or "Not reviewed" for the active file. Clicking it opens a context menu to toggle status. It hides itself when the active file is ineligible or the setting is disabled.

```bash
head -360 src/main.ts | tail -58
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

`ReviewMenuModal` extends `SuggestModal` to provide a searchable command palette. It dynamically adjusts available actions based on the active file's review status:
- **No eligible file open:** Only "Open random unreviewed file"
- **File already reviewed:** "Open random" + "Mark as unreviewed"
- **File not reviewed:** "Mark reviewed and open next" + "Mark reviewed" + "Open random"

```bash
head -566 src/main.ts | tail -70
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
}
```

### Settings Tab

`ReviewSettingTab` renders the plugin's settings panel with:
- Review status and reset button
- Live stats display (eligible, reviewed, percent, not reviewed)
- Dynamic excluded folders list with folder autocomplete (`FolderSuggest`)
- Status bar toggle

The excluded folder inputs use debounced saves (500ms) to avoid excessive disk writes while typing.

### Folder Suggest

`FolderSuggest` extends `AbstractInputSuggest` to provide autocomplete for vault folders in the settings UI. It queries all folders, filters by the current input, and calls a callback on selection.

```bash
head -31 src/folderSuggest.ts
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

`build.ts` uses Bun's native bundler. It produces a single CJS file (`main.js`) with `obsidian` and `electron` as externals. In watch mode (`--watch`), minification is off and sourcemaps are linked.

```bash
head -18 build.ts
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

### Version Bump Script

`version-bump.ts` reads the version from `package.json` (via `npm_package_version` env var set by `bun run`) and syncs it to `manifest.json` and `versions.json`. This keeps the Obsidian plugin metadata in lockstep with the npm version.

```bash
head -19 version-bump.ts
```

```output
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  throw new Error("No version found in package.json");
}

// Update manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

// Update versions.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Updated to version ${targetVersion}`);
```

### Tests

Tests cover the four exported pure functions using Bun's test runner. The `src/__mocks__/obsidian.ts` preload file stubs the `obsidian` module so that imports in `main.ts` don't fail at test time. Only pure logic is tested — plugin integration (Obsidian API calls) is not unit-tested.

```bash
head -107 src/main.test.ts | tail -4
```

```output
    expect(removeByPrefix(paths, "folder")).toBe(false);
    expect(paths.has("folder-extra/a.md")).toBe(true);
  });
});
```

The test file has 13 test cases across 4 `describe` blocks:
- `isExcluded` (7 tests) — folder matching, edge cases
- `computeStats` (3 tests) — partial, zero, full review
- `rewriteReviewedPaths` (3 tests) — rename, no-match, prefix guard
- `removeByPrefix` (3 tests) — delete, no-match, prefix guard

## Concerns

### Code Quality

1. **God file:** `src/main.ts` (567 lines) contains the plugin class, four utility functions, three modal classes, the status bar, and the settings tab. Extracting the UI classes (`StatusBar`, `ReviewSettingTab`, `ConfirmResetModal`, `ReviewMenuModal`) into separate modules would improve readability and maintainability.

2. **Arrow-function class methods:** Most methods on `ReviewPlugin` and other classes are arrow function properties (`onload = async () => { ... }`). While this avoids `this`-binding issues, it deviates from standard TypeScript class conventions and prevents subclass overriding. Obsidian's `Plugin.onload()` is a conventional method override — using an arrow property works but is unconventional.

3. **No `onunload()`:** The plugin does not implement `onunload()`. Obsidian cleans up `registerEvent` and `addCommand` registrations automatically, and there is no other cleanup needed, so this is fine in practice — but an empty `onunload` would signal intentionality.

### Community Standards

4. **Obsidian plugin guidelines compliance:** The plugin follows the standard structure (`manifest.json`, `main.js`, `styles.css`). The `minAppVersion` is set to `1.0.0`, which is correct for the APIs used.

5. **No `.eslintrc` / Biome is used instead:** This is a valid modern choice. Biome config is minimal and appropriate.

6. **Tests are preload-based:** The `__mocks__/obsidian.ts` uses `bun:test`'s `mock.module()` which is Bun-specific. This is fine since the project is Bun-native, but it's worth noting for portability.

### Risks

7. **Unbounded data growth:** `reviewedPaths` grows linearly with vault size. For a vault with thousands of files, the JSON blob and in-memory Set could become large. No pruning of stale paths (files that no longer exist) is done on load.

8. **No deduplication on save:** `saveSettings` serializes the Set to an array, which is inherently deduplicated. Good.

9. **Race conditions on rapid saves:** Multiple async operations (`markReviewed`, `handleFileRename`, etc.) can trigger concurrent `saveSettings()` calls. Since `saveData` is Obsidian-managed and presumably serialized, this is likely safe — but there is no explicit queue or debounce on saves outside the settings tab.

