# Obsidian Review Walkthrough

*2026-06-12T16:25:24Z by Showboat 0.6.1*
<!-- showboat-id: a84cd69e-6f91-4013-9dba-50fdf434c22a -->

## Overview

Obsidian Review is a plugin that helps you work through your vault one random
note at a time: open a random unreviewed file, mark it reviewed, repeat until
everything is done. Progress is a simple set of reviewed file paths persisted
via Obsidian's `loadData`/`saveData` into the plugin's `data.json`.

Key technologies: TypeScript, Bun (bundler + test runner), Biome
(lint/format), and the Obsidian plugin API. The bundle entry point is
`src/main.ts`, which Bun compiles to `./main.js` (CommonJS, `obsidian` and
`electron` left external).

The codebase was recently split from a single 566-line `src/main.ts` into
focused modules. The guiding boundary: everything that touches the Obsidian
API lives in `plugin.ts` and the UI files, while the review-tracking logic
itself (`reviewState.ts`) is plain TypeScript with no Obsidian imports, so it
can be unit-tested directly.

## Architecture

The module layout after the refactor:

```bash
cat <<'TREE'
src/
  main.ts            Obsidian entrypoint; re-exports the plugin
  plugin.ts          ReviewPlugin lifecycle: commands, persistence, migration, events
  reviewState.ts     ReviewState state machine + isExcluded (no Obsidian APIs)
  reviewState.test.ts  Direct unit tests for reviewState.ts
  statusBar.ts       Status-bar indicator + click menu
  settingsTab.ts     Settings UI (reset, excluded folders, status-bar toggle)
  modals.ts          ConfirmResetModal + ReviewMenuModal
  folderSuggest.ts   Folder autocomplete for the settings tab
  __mocks__/         Obsidian API stubs for bun test
TREE
```

```output
src/
  main.ts            Obsidian entrypoint; re-exports the plugin
  plugin.ts          ReviewPlugin lifecycle: commands, persistence, migration, events
  reviewState.ts     ReviewState state machine + isExcluded (no Obsidian APIs)
  reviewState.test.ts  Direct unit tests for reviewState.ts
  statusBar.ts       Status-bar indicator + click menu
  settingsTab.ts     Settings UI (reset, excluded folders, status-bar toggle)
  modals.ts          ConfirmResetModal + ReviewMenuModal
  folderSuggest.ts   Folder autocomplete for the settings tab
  __mocks__/         Obsidian API stubs for bun test
```

Module sizes show where the weight is — the plugin shell is the largest file,
followed by the tests:

```bash
wc -l src/*.ts | sort -rn
```

```output
     943 total
     302 src/plugin.ts
     202 src/reviewState.test.ts
     115 src/modals.ts
     113 src/settingsTab.ts
     113 src/reviewState.ts
      65 src/statusBar.ts
      31 src/folderSuggest.ts
       2 src/main.ts
```

Data flow in one paragraph: `ReviewPlugin` owns a single `ReviewState`
instance. On load it feeds persisted data into the state via `state.load()`;
on every mutation it reads `state.reviewedPaths` / `state.reviewStartedAt`
back out and saves. The vault is the source of truth for which files *exist*
— the stored set is reconciled against vault rename/delete events rather than
maintaining an authoritative file list.

## Entry point

`src/main.ts` is now just Obsidian's expected entrypoint — two lines:

```bash
cat src/main.ts
```

```output
// Obsidian's expected entrypoint — the plugin lives in plugin.ts.
export { default } from "./plugin";
```

## ReviewState: the core

`src/reviewState.ts` is the heart of the plugin and deliberately imports
nothing. It holds two pieces of state — the set of reviewed paths and the
timestamp the current review started:

```bash
sed -n '15,28p' src/reviewState.ts
```

```output
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
```

The mutation methods are tiny, but note the injectable clock and rng — this is
what makes the class deterministic under test. `markReviewed` starts the
review clock only on the first mark; `pickRandomUnreviewed` filters the
eligible list down to unreviewed paths before picking:

```bash
sed -n '34,58p' src/reviewState.ts
```

```output
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
```

`stats` computes progress against whatever eligible list the caller passes in
— the state never decides eligibility itself. Eligibility is the job of
`isExcluded`, a free function at the top of the same file. The trailing slash
in the prefix check is load-bearing: `templates` must not exclude
`templates-extra/note.md`:

```bash
sed -n '1,6p' src/reviewState.ts && echo '...' && sed -n '60,71p' src/reviewState.ts
```

```output
export function isExcluded(
  filePath: string,
  excludedFolders: string[],
): boolean {
  return excludedFolders.some((folder) => filePath.startsWith(`${folder}/`));
}
...
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
```

The last four methods reconcile the stored set against vault changes. Each
returns a boolean — "did anything change" — so the plugin can skip a disk
write when a rename or delete didn't touch any reviewed path. `renameFolder`
shows the pattern: collect the rewrites first, then apply, since mutating a
`Set` mid-iteration of additions would be fragile:

```bash
sed -n '80,96p' src/reviewState.ts
```

```output
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
```

## ReviewPlugin: lifecycle and persistence

`src/plugin.ts` is the Obsidian-facing shell. It starts with the persisted
shape and the schema version that gates migration:

```bash
sed -n '13,28p' src/plugin.ts
```

```output
export type PluginData = {
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

Schema v1 nested `showStatusBar` inside a `settings` object and carried state
for a since-removed snapshot feature. The v1-to-v2 migration flattens the one
and drops the other:

```bash
sed -n '34,47p' src/plugin.ts
```

```output
// v1: showStatusBar lived in a nested settings object, and a since-removed
// snapshot feature stored its state alongside it.
function migrateV1toV2(saved: SavedData): SavedData {
  const migrated: Record<string, unknown> = { ...saved };
  if (
    saved.settings?.showStatusBar !== undefined &&
    saved.showStatusBar === undefined
  ) {
    migrated.showStatusBar = saved.settings.showStatusBar;
  }
  delete migrated.settings;
  delete migrated.snapshot;
  return migrated as SavedData;
}
```

`loadSettings` handles three cases: a failed read (fall back to defaults with
a Notice), data from a *newer* plugin version (load read-only, preserve the
newer `schemaVersion`), and normal-or-older data (migrate if needed, stamp the
current version). The forward-compatibility branch pairs with a guard in
`saveSettings` that refuses to overwrite newer data:

```bash
sed -n '147,182p' src/plugin.ts
```

```output
    const savedVersion = saved
      ? (saved.schemaVersion ?? 1)
      : CURRENT_SCHEMA_VERSION;

    if (savedVersion > CURRENT_SCHEMA_VERSION) {
      // Data from a newer plugin version: load what we understand, but keep
      // the newer schemaVersion so saveSettings refuses to overwrite it.
      console.warn(
        `[review] data has schema v${savedVersion}, newer than v${CURRENT_SCHEMA_VERSION}; loading read-only`,
      );
      new Notice(
        "Review: saved data is from a newer plugin version. Changes will not be saved until the plugin is updated.",
      );
      this.data = { ...DEFAULT_DATA, ...saved, schemaVersion: savedVersion };
    } else {
      const migrated =
        saved && savedVersion < 2 ? migrateV1toV2(saved) : (saved ?? {});
      this.data = {
        ...DEFAULT_DATA,
        ...migrated,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
    }

    this.state.load(this.data.reviewedPaths, this.data.reviewStartedAt);
  };

  saveSettings = async () => {
    if (this.data.schemaVersion > CURRENT_SCHEMA_VERSION) {
      console.warn(
        `[review] not saving: data has schema v${this.data.schemaVersion}, newer than v${CURRENT_SCHEMA_VERSION}`,
      );
      return;
    }
    this.data.reviewedPaths = [...this.state.reviewedPaths];
    this.data.reviewStartedAt = this.state.reviewStartedAt;
```

Note the last two lines: saving serializes the `ReviewState` back into the
plain `data` object. The state class is the runtime authority; `data` is just
its persisted projection plus the settings.

### runAsync: the error-surfacing bridge

Obsidian UI callbacks (command palette, menus, buttons) can't `await`. Every
fire-and-forget call in the codebase goes through `runAsync`, which logs and
raises a Notice instead of letting rejections vanish:

```bash
sed -n '54,63p' src/plugin.ts
```

```output
  /**
   * Fire-and-forget bridge for UI callbacks that cannot await: surfaces
   * rejections via Notice instead of letting them vanish.
   */
  runAsync = (promise: Promise<unknown>, label: string) => {
    promise.catch((err) => {
      console.error(`[review] ${label} failed`, err);
      new Notice(`Review: ${label} failed — see console for details.`);
    });
  };
```

### onload: commands and event wiring

`onload` registers a ribbon icon, the status bar, four commands, the settings
tab, and the vault event handlers. The mark commands use `checkCallback` so
they only appear in the palette when the active file is in the right state —
here is the representative one:

```bash
sed -n '79,87p' src/plugin.ts
```

```output
    this.addCommand({
      id: "mark-reviewed",
      name: "Mark file as reviewed",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "not_reviewed") return false;
        if (!checking) this.runAsync(this.markReviewed(), "mark reviewed");
        return true;
      },
    });
```

The vault event handlers are where the reconciliation strategy from the data
model shows up. Rename and delete events dispatch on `TFolder` vs file, call
the matching `ReviewState` method, and only persist when the state reports a
change:

```bash
sed -n '284,301p' src/plugin.ts
```

```output
  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
    const changed =
      file instanceof TFolder
        ? this.state.renameFolder(oldPath, file.path)
        : this.state.renameFile(oldPath, file.path);
    if (changed) await this.saveSettings();
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    const changed =
      file instanceof TFolder
        ? this.state.deleteFolder(file.path)
        : this.state.deleteFile(file.path);
    if (changed) {
      this.statusBar.update();
      await this.saveSettings();
    }
  };
```

The core user action, `openRandomFile`, shows the division of labor cleanly:
the plugin gathers eligible files from the vault (Obsidian API), the state
picks one (pure logic), and the plugin opens it (Obsidian API again):

```bash
sed -n '233,242p' src/plugin.ts
```

```output
  openRandomFile = async () => {
    const eligible = this.getEligibleFiles();
    const path = this.state.pickRandomUnreviewed(eligible.map((f) => f.path));
    const randomFile = eligible.find((f) => f.path === path);
    if (!randomFile) {
      new Notice("All files are reviewed");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(randomFile);
  };
```

## Status bar

`src/statusBar.ts` renders "Reviewed" / "Not reviewed" for the active file and
hides itself entirely when there is no eligible markdown file open (or the
user disabled it). It is refreshed from three places: `onload`'s `file-open`
event, every mark/unmark/reset in the plugin, and the settings tab. Clicking
it opens a small checked menu to toggle the state:

```bash
sed -n '21,35p' src/statusBar.ts
```

```output
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
```

## Settings tab

`src/settingsTab.ts` renders four things: a reset button with the
review-start date, live stats, the excluded-folders list, and the status-bar
toggle. Excluded-folder rows are interesting — each text input gets a
`FolderSuggest` autocomplete, typing saves through a 500ms debounce, and
trailing slashes are normalized away:

```bash
sed -n '53,70p' src/settingsTab.ts
```

```output
    for (let i = 0; i < this.plugin.data.excludedFolders.length; i++) {
      const applyFolder = (value: string) => {
        this.plugin.data.excludedFolders[i] = value.replace(/\/+$/, "");
        this.plugin.statusBar.update();
      };
      new Setting(containerEl)
        .setClass("review-excluded-folder")
        .addText((text) => {
          text.setValue(this.plugin.data.excludedFolders[i]);
          text.onChange((value) => {
            applyFolder(value);
            this.debouncedSave();
          });
          new FolderSuggest(this.app, text.inputEl, (value) => {
            applyFolder(value);
            this.plugin.runAsync(this.plugin.saveSettings(), "save settings");
          });
        })
```

"Add excluded folder" pushes an empty string and re-renders without saving;
the cleanup happens in `hide()`, which prunes rows the user left empty when
the tab closes:

```bash
sed -n '105,112p' src/settingsTab.ts
```

```output
  hide(): void {
    const folders = this.plugin.data.excludedFolders;
    const pruned = folders.filter((folder) => folder !== "");
    if (pruned.length !== folders.length) {
      this.plugin.data.excludedFolders = pruned;
      this.plugin.runAsync(this.plugin.saveSettings(), "save settings");
    }
  }
```

## Modals

`src/modals.ts` holds two modals. `ConfirmResetModal` adapts Obsidian's
callback-style modal into a promise the plugin can `await` — the `settled`
flag ensures the promise resolves `false` exactly once even if the user
dismisses the modal with Escape instead of a button:

```bash
sed -n '4,12p' src/modals.ts && echo '  ...' && sed -n '33,39p' src/modals.ts
```

```output
export class ConfirmResetModal extends Modal {
  constructor(app: App, resolve: (confirmed: boolean) => void) {
    super(app);

    this.setTitle("Reset review?");

    let settled = false;

    new Setting(this.contentEl)
  ...
    this.onClose = () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };
  }
```

`ReviewMenuModal` (reached via the ribbon icon or "Open review menu" command)
is a `SuggestModal` whose suggestions adapt to the active file: an unreviewed
file offers "mark and open next" first, a reviewed file offers unreview, and
no eligible file leaves just "open random":

```bash
sed -n '59,85p' src/modals.ts
```

```output
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
```

## Testing approach

Because `reviewState.ts` has no Obsidian imports, `src/reviewState.test.ts`
tests it directly with `bun test` — no mocking of the state itself, and the
injectable clock/rng make timing and randomness deterministic. Plugin
integration (the Obsidian API surface) is deliberately not unit-tested; the
`src/__mocks__/` stubs exist only to satisfy imports.

```bash
grep -c 'test(' src/reviewState.test.ts && grep 'describe(' src/reviewState.test.ts
```

```output
29
describe("isExcluded", () => {
describe("load", () => {
describe("markReviewed", () => {
describe("markUnreviewed", () => {
describe("reset", () => {
describe("pickRandomUnreviewed", () => {
describe("stats", () => {
describe("renameFile", () => {
describe("renameFolder", () => {
describe("deleteFile", () => {
describe("deleteFolder", () => {
```

29 tests across 11 suites — one suite per `ReviewState` method plus
`isExcluded`. The deterministic-injection style is visible in the
`pickRandomUnreviewed` suite, which pins the rng to the ends of its range:

```bash
sed -n '92,97p' src/reviewState.test.ts
```

```output
  test("picks only from unreviewed files", () => {
    const state = stateWith(["a.md"]);
    const eligible = ["a.md", "b.md", "c.md"];
    expect(state.pickRandomUnreviewed(eligible, () => 0)).toBe("b.md");
    expect(state.pickRandomUnreviewed(eligible, () => 0.99)).toBe("c.md");
  });
```

## Where to go next

- `THEORY.md` — the rationale behind random-order review
- `build.ts` / `deploy.ts` — Bun bundling and copy-to-vault deployment
- `CLAUDE.md` — full command reference (`bun run dev`, `bun test`, release tagging)

The takeaway from the refactor: anything you want to test goes in
`reviewState.ts` with injectable dependencies; anything that touches Obsidian
stays in the thin shells around it.

