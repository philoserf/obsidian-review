# Obsidian Review Walkthrough

*2026-09-07T23:08:35Z by Showboat 0.6.1*
<!-- showboat-id: d877396c-d294-4fe0-acf2-b5855e679a21 -->

## Overview

Obsidian Review helps you work through your vault one random note at a time:
open a random unreviewed file, mark it reviewed, repeat until everything is
done. Progress is a set of reviewed file paths plus a list of excluded
folders, persisted via Obsidian's `loadData`/`saveData` into the plugin's
`data.json`.

Key technologies: TypeScript, Bun (bundler + test runner), Biome
(lint/format), and the Obsidian plugin API. The bundle entry point is
`src/main.ts`, which Bun compiles to `./main.js` (CommonJS, `obsidian` and
`electron` left external).

The guiding boundary: everything that touches the Obsidian API lives in
`plugin.ts` and the UI files, while the review logic (`review.ts`) and the
persisted-shape helpers (`data.ts`) are plain TypeScript with no Obsidian
imports, so both can be unit-tested directly.

## Architecture

The module layout:

```bash
cat <<'TREE'
src/
  main.ts            Obsidian entrypoint; re-exports the plugin
  plugin.ts          ReviewPlugin lifecycle: commands, persistence, events
  review.ts          Review state machine + pickRandom (no Obsidian APIs)
  review.test.ts     Direct unit tests for review.ts
  data.ts            Persisted shape, defaults, normalizeData (no Obsidian APIs)
  data.test.ts       Direct unit tests for data.ts
  statusBar.ts       Status-bar indicator + click menu
  settingsTab.ts     Settings UI (reset, excluded folders, status-bar toggle)
  modals.ts          ConfirmResetModal + ReviewMenuModal
  folderSuggest.ts   Folder autocomplete for the settings tab
TREE
```

```output
src/
  main.ts            Obsidian entrypoint; re-exports the plugin
  plugin.ts          ReviewPlugin lifecycle: commands, persistence, events
  review.ts          Review state machine + pickRandom (no Obsidian APIs)
  review.test.ts     Direct unit tests for review.ts
  data.ts            Persisted shape, defaults, normalizeData (no Obsidian APIs)
  data.test.ts       Direct unit tests for data.ts
  statusBar.ts       Status-bar indicator + click menu
  settingsTab.ts     Settings UI (reset, excluded folders, status-bar toggle)
  modals.ts          ConfirmResetModal + ReviewMenuModal
  folderSuggest.ts   Folder autocomplete for the settings tab
```

Module sizes show where the weight is — the plugin shell is the largest file,
followed by the tests:

```bash
wc -l src/*.ts | sort -rn
```

```output
    1234 total
     357 src/plugin.ts
     250 src/review.test.ts
     159 src/review.ts
     126 src/settingsTab.ts
     121 src/modals.ts
      92 src/data.test.ts
      62 src/statusBar.ts
      51 src/data.ts
      14 src/folderSuggest.ts
       2 src/main.ts
```

Data flow in one paragraph: `ReviewPlugin` owns a single `Review` instance. On
load it feeds persisted data into it via `review.load()`; on every mutation it
reads the fields back out and saves. The vault is the source of truth for
which files *exist* — the stored set is reconciled against vault rename/delete
events rather than maintaining an authoritative file list.

## Entry point

`src/main.ts` is just Obsidian's expected entrypoint — two lines:

```bash
cat src/main.ts
```

```output
// Obsidian's expected entrypoint — the plugin lives in plugin.ts.
export { default } from "./plugin";
```

## data.ts: the persisted shape

`src/data.ts` owns everything about what lands in `data.json` — the type, the
defaults, and the schema version. It imports nothing:

```bash
sed -n '1,18p' src/data.ts
```

```output
export type PluginData = {
  schemaVersion: number;
  reviewedPaths: string[];
  reviewStartedAt?: string;
  excludedFolders: string[];
  showStatusBar: boolean;
};

export const CURRENT_SCHEMA_VERSION = 2;

export const DEFAULT_DATA: PluginData = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  reviewedPaths: [],
  excludedFolders: [],
  showStatusBar: true,
};

export type SavedData = Partial<PluginData>;
```

`normalizeData` is the reason `SavedData` can be `Partial<PluginData>` without
the rest of the plugin defending itself. It builds a fresh object from known
fields, coercing each one rather than spreading whatever was on disk over the
defaults — a spread would let a hand-edit or a sync conflict put a number where
a boolean belongs:

```bash
sed -n '20,51p' src/data.ts
```

```output
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * `data.json` is the least trustworthy thing the plugin reads: a hand-edit, a
 * sync conflict, or a schema written by a future version can put any shape in
 * it, and a spread happily overwrites a well-typed default with a wrong-typed
 * value. Coerce rather than throw — a bad field must degrade to its default so
 * the settings tab still renders and the user can repair it from the UI.
 */
export function normalizeData(raw: unknown): Omit<PluginData, "schemaVersion"> {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const startedAt = data.reviewStartedAt;

  return {
    reviewedPaths: stringArray(data.reviewedPaths),
    reviewStartedAt:
      typeof startedAt === "string" && !Number.isNaN(Date.parse(startedAt))
        ? startedAt
        : undefined,
    excludedFolders: stringArray(data.excludedFolders),
    showStatusBar:
      typeof data.showStatusBar === "boolean"
        ? data.showStatusBar
        : DEFAULT_DATA.showStatusBar,
  };
}
```

Two consequences worth noting. Building fresh means unknown keys are dropped
on their own, which is why there is no explicit migration step: schema v1's
nested `settings` object simply does not survive the trip. And coercing rather
than throwing means a corrupt field degrades to its default, so the settings
tab still renders and the user can repair it from the UI.

## review.ts: the core

`src/review.ts` is the heart of the plugin and deliberately imports nothing.
`Review` owns *every* persisted review field — the reviewed set, the start
timestamp, and the excluded folders:

```bash
sed -n '16,41p' src/review.ts
```

```output
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
export class Review {
  reviewedPaths = new Set<string>();
  reviewStartedAt?: string;
  excludedFolders: string[] = [];

  load(paths: string[], excludedFolders: string[], startedAt?: string): void {
    this.reviewedPaths = new Set(paths);
    this.excludedFolders = [...excludedFolders];
    this.reviewStartedAt = startedAt;
  }

  isEligible(path: string): boolean {
    return !this.excludedFolders.some((folder) =>
      path.startsWith(`${folder}/`),
    );
  }
```

The trailing slash in `isEligible`'s prefix check is load-bearing: `templates`
must not exclude `templates-extra/note.md`. That check only works if the stored
folder is already trimmed and slash-free, which is why writing
`excludedFolders` goes through exactly one door:

```bash
sed -n '43,58p' src/review.ts
```

```output
  /**
   * The only way in. A folder that is not trimmed of whitespace or trailing
   * slashes matches nothing, silently, so normalizing anywhere but here would
   * leave a way to store one.
   */
  setExcludedFolders(list: string[]): void {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const folder = entry.trim().replace(/\/+$/, "");
      if (!folder || seen.has(folder)) continue;
      seen.add(folder);
      normalized.push(folder);
    }
    this.excludedFolders = normalized;
  }
```

The mutation methods are tiny, but note the injectable clock — that is what
makes the class deterministic under test. `markReviewed` starts the review
clock only on the first mark:

```bash
sed -n '64,79p' src/review.ts
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
```

`stats` computes progress against whatever eligible list the caller passes in
— `Review` never decides which files exist, only which of the given ones are
reviewed. Randomness is a free function at the top of the file, and it is
deliberately dumb: it picks uniformly from whatever it is handed, leaving the
"which files are even candidates" question to the caller:

```bash
sed -n '1,8p' src/review.ts && echo '...' && sed -n '81,91p' src/review.ts
```

```output
/** Uniform choice, or undefined when there is nothing to choose from. */
export function pickRandom<T>(
  items: readonly T[],
  rng: () => number = Math.random,
): T | undefined {
  if (!items.length) return undefined;
  return items[Math.floor(rng() * items.length)];
}
...
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
```

The last two public methods reconcile the stored state against vault changes.
Each returns a boolean — "did anything change" — so the plugin can skip a disk
write when a rename or delete touched nothing. Both take an `isFolder` flag
rather than an Obsidian object; that boolean is the whole file-vs-folder
distinction crossing the boundary:

```bash
sed -n '93,105p' src/review.ts
```

```output
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
```

`renameFolder` is where owning both sets pays off. Renaming a folder has to
rewrite reviewed paths *and* any excluded-folder entry that named it or lived
beneath it — miss the second half and a rename silently un-excludes a folder.
Note the collect-then-apply for the reviewed set: adding to a `Set` while
iterating it would be fragile:

```bash
sed -n '107,136p' src/review.ts
```

```output
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
    this.excludedFolders = this.excludedFolders.map((folder) => {
      if (folder === oldPath) {
        changed = true;
        return newPath;
      }
      if (folder.startsWith(oldPrefix)) {
        changed = true;
        return newPrefix + folder.slice(oldPrefix.length);
      }
      return folder;
    });

    return changed;
  }
```

`removeFolder` is the same idea in the deleting direction — drop reviewed paths
under the prefix, and drop the excluded entries that no longer name anything:

```bash
sed -n '138,158p' src/review.ts
```

```output
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
```

## ReviewPlugin: lifecycle and persistence

`src/plugin.ts` is the Obsidian-facing shell. Its two private fields carry the
whole persistence story — why writing might be refused, and how concurrent
writes are ordered:

```bash
sed -n '19,44p' src/plugin.ts
```

```output
export default class ReviewPlugin extends Plugin {
  data!: PluginData;
  readonly review = new Review();
  statusBar!: StatusBar;

  /**
   * Why writing is refused, or null when it is allowed. Set on every path
   * through loadSettings: data we failed to read must not be overwritten by
   * the defaults we fell back to, and data from a newer plugin version must
   * not be truncated to what this version understands.
   */
  private saveBlocked: string | null = null;

  /** Tail of the serialized write queue. Never rejects. */
  private savePending: Promise<void> = Promise.resolve();

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

`runAsync` is the error-surfacing bridge. Obsidian UI callbacks (command
palette, menus, buttons) cannot `await`, so every fire-and-forget call in the
codebase goes through it rather than letting rejections vanish.

`loadSettings` distinguishes three states, and the distinctions matter more
than the loading does. A read that *threw* is not the same as `saved === null`
(a fresh install), and data written by a *newer* plugin version is readable but
must not be written back:

```bash
sed -n '117,165p' src/plugin.ts
```

```output
  loadSettings = async () => {
    let saved: SavedData | null = null;
    let loadFailed = false;
    try {
      saved = await this.loadData();
    } catch (err) {
      // Distinct from `saved === null`, which is also a fresh install.
      loadFailed = true;
      console.error("[review] loadData failed; running read-only", err);
      new Notice(
        "Review: could not read saved data. The plugin is read-only until Obsidian reloads it — your saved review will not be overwritten. See console for details.",
      );
    }

    const savedVersion = saved?.schemaVersion ?? CURRENT_SCHEMA_VERSION;
    const isNewer = savedVersion > CURRENT_SCHEMA_VERSION;

    if (isNewer) {
      console.warn(
        `[review] data has schema v${savedVersion}, newer than v${CURRENT_SCHEMA_VERSION}; loading read-only`,
      );
      new Notice(
        "Review: saved data is from a newer plugin version. Changes will not be saved until the plugin is updated.",
      );
    }

    this.data = {
      ...normalizeData(saved),
      // Keep a newer version's number, so the file is not truncated to v2
      // if something later lifts the write block.
      schemaVersion: isNewer ? savedVersion : CURRENT_SCHEMA_VERSION,
    };

    // Assigned on every path, back to null included, so a reload after a
    // transient read failure lifts the block.
    if (loadFailed) {
      this.saveBlocked = "saved data could not be read";
    } else if (isNewer) {
      this.saveBlocked = "saved data is from a newer plugin version";
    } else {
      this.saveBlocked = null;
    }

    this.review.load(
      this.data.reviewedPaths,
      this.data.excludedFolders,
      this.data.reviewStartedAt,
    );
  };
```

`saveSettings` honours that block, then does two things easy to get wrong. It
snapshots the payload at *call* time, because a queued write must carry the
state that was current when it was requested rather than whatever `this.data`
holds when its turn comes. And it chains onto `savePending` with the *same*
handler in both arms, so a failed predecessor cannot cancel its successor:

```bash
sed -n '167,197p' src/plugin.ts
```

```output
  saveSettings = (): Promise<void> => {
    if (this.saveBlocked) {
      console.warn(`[review] not saving: ${this.saveBlocked}`);
      new Notice(
        `Review: ${this.saveBlocked}. Changes will not be saved until you reload.`,
      );
      return Promise.resolve();
    }

    this.data.reviewedPaths = [...this.review.reviewedPaths];
    this.data.excludedFolders = [...this.review.excludedFolders];
    this.data.reviewStartedAt = this.review.reviewStartedAt;

    // Snapshot at call time, not write time: a queued write must carry the
    // state that was current when it was requested, not whatever `this.data`
    // holds by the time its turn comes.
    const payload: PluginData = {
      ...this.data,
      reviewedPaths: [...this.data.reviewedPaths],
      excludedFolders: [...this.data.excludedFolders],
    };

    // Serialize, so overlapping saves land in call order. Both arms run the
    // write: a failed predecessor must not stop its successor.
    const next = this.savePending.then(
      () => this.writeSettings(payload),
      () => this.writeSettings(payload),
    );
    this.savePending = next.catch(() => {});
    return next;
  };
```

`mutate` is the counterpart on the read side of the UI: it makes "the screen
shows progress" and "the progress is on disk" the same fact. A refused write is
declined before anything changes; a failed one is rolled back and rethrown:

```bash
sed -n '272,304p' src/plugin.ts
```

```output
  /**
   * Apply a review-state change and report whether it was persisted. The UI
   * must not show progress that is not on disk: a refused write is declined
   * before anything changes, and a failed one is rolled back.
   */
  private mutate = async (apply: () => void): Promise<boolean> => {
    if (this.saveBlocked) {
      new Notice(
        `Review: ${this.saveBlocked}. Changes will not be saved until you reload.`,
      );
      return false;
    }

    // Settle any in-flight write first, so a rollback cannot be overtaken by
    // a save that was already queued from the state we are about to undo.
    await this.savePending;

    const paths = [...this.review.reviewedPaths];
    const excludedFolders = [...this.review.excludedFolders];
    const startedAt = this.review.reviewStartedAt;

    apply();
    this.statusBar.update();

    try {
      await this.saveSettings();
      return true;
    } catch (err) {
      this.review.load(paths, excludedFolders, startedAt);
      this.statusBar.update();
      throw err;
    }
  };
```

Every state-changing action funnels through `mutate`, which is what makes
"mark and open next" honest — it only advances if the mark actually landed:

```bash
sed -n '306,333p' src/plugin.ts
```

```output
  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    const saved = await this.mutate(() => this.review.markReviewed(file.path));
    if (saved && openNext) await this.openRandomFile();
  };

  markUnreviewed = async () => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    await this.mutate(() => this.review.markUnreviewed(file.path));
  };

  setExcludedFolders = async (list: string[]): Promise<boolean> => {
    return this.mutate(() => this.review.setExcludedFolders(list));
  };

  resetReview = async ({
    confirm = true,
  }: {
    confirm?: boolean;
  } = {}): Promise<boolean> => {
    if (confirm && !(await this.confirmReset())) return false;

    return this.mutate(() => this.review.reset());
  };
```

### onload: commands and event wiring

`onload` registers a ribbon icon, the status bar, five commands, the settings
tab, and the vault event handlers. The mark commands use `checkCallback` so
they only appear in the palette when the active file is in the right state —
here is the representative one:

```bash
sed -n '60,68p' src/plugin.ts
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

The vault event handlers are where the reconciliation strategy shows up. Both
collapse to one line, because `Review` already dispatches on the folder flag —
and the `instanceof` deliberately stays on this side of the boundary:

```bash
sed -n '342,356p' src/plugin.ts
```

```output
  // The `instanceof` stays on this side of the boundary so `Review` needs no
  // Obsidian import and stays directly testable.
  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
    if (this.review.rename(oldPath, file.path, file instanceof TFolder)) {
      this.statusBar.update();
      await this.saveSettings();
    }
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    if (this.review.remove(file.path, file instanceof TFolder)) {
      this.statusBar.update();
      await this.saveSettings();
    }
  };
```

`openRandomFile` is the core user action, and it separates two failures that
look alike from the outside. An empty eligible list means the excluded folders
swallowed the vault; a fully reviewed one means the user is done. Congratulating
someone on a review they never started points them away from the settings tab,
which is where the actual fault is:

```bash
sed -n '250,270p' src/plugin.ts
```

```output
  openRandomFile = async () => {
    // An empty eligible list and a fully reviewed one are different problems,
    // and congratulating someone on a review they never started points them
    // away from the settings tab, which is where the actual fault is.
    const eligible = this.getEligibleFiles();
    if (!eligible.length) {
      new Notice(
        "No files are eligible for review — check your excluded folders.",
      );
      return;
    }

    const unreviewed = eligible.filter((f) => !this.review.isReviewed(f.path));
    if (!unreviewed.length) {
      new Notice("All files are reviewed");
      return;
    }

    const next = pickRandom(unreviewed);
    if (next) await this.app.workspace.getLeaf(false).openFile(next);
  };
```

## Status bar

`src/statusBar.ts` renders "Reviewed" / "Not reviewed" for the active file and
hides itself entirely when there is no eligible markdown file open (or the user
disabled it). It is refreshed from three places: `onload`'s `file-open` event,
every mutation in the plugin, and the settings tab:

```bash
sed -n '19,29p' src/statusBar.ts
```

```output
  update = () => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) {
      this.setIsVisible(false);
      return;
    }

    this.setIsVisible(this.plugin.data.showStatusBar);

    this.element.setText(status === "reviewed" ? "Reviewed" : "Not reviewed");
  };
```

Clicking it opens a small checked menu to toggle the state. The click listener
is registered through `plugin.registerDomEvent`, so Obsidian tears it down with
the plugin rather than leaking it across reloads:

```bash
sed -n '12,17p' src/statusBar.ts
```

```output
    element.setText("Not reviewed");
    element.addClass("mod-clickable");
    plugin.registerDomEvent(element, "click", this.onClick);

    this.update();
  }
```

## Settings tab

`src/settingsTab.ts` renders four things: a reset button with the review-start
date, live stats, the excluded-folders list, and the status-bar toggle. The
excluded-folder rows are the interesting part, and the reason is a tension
between two correct behaviours: `setExcludedFolders` drops empties and dedupes,
but doing that per keystroke would delete a row out from under the user
mid-word. So the tab keeps its own unnormalized draft:

```bash
sed -n '8,29p' src/settingsTab.ts
```

```output
  /**
   * Excluded-folder rows as typed, before normalization — null while the tab
   * is closed. Rows live here rather than in the plugin so a half-typed or
   * momentarily-empty one survives on screen: setExcludedFolders drops empties
   * and dedupes, which would otherwise delete a row out from under the user
   * mid-word.
   */
  private drafts: string[] | null = null;

  private debouncedCommit = debounce(() => this.commit(), 500, true);

  constructor(app: App, plugin: ReviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private commit(): void {
    this.plugin.runAsync(
      this.plugin.setExcludedFolders(this.drafts ?? []),
      "save excluded folders",
    );
  }
```

Typing updates only the draft and commits through a 500ms debounce; picking
from the autocomplete commits immediately. `FolderSuggest` supplies its own
`onSelect`, so the tab does not have to thread a callback through the
constructor:

```bash
sed -n '71,97p' src/settingsTab.ts
```

```output
    for (let i = 0; i < drafts.length; i++) {
      new Setting(containerEl)
        .setClass("review-excluded-folder")
        .addText((text) => {
          text.setValue(drafts[i]);
          // Only the draft changes per keystroke; normalization runs once the
          // debounce fires, so typing a second "Templates" cannot collapse two
          // visible rows into one entry mid-word.
          text.onChange((value) => {
            drafts[i] = value;
            this.debouncedCommit();
          });
          new FolderSuggest(this.app, text.inputEl).onSelect((folder) => {
            text.setValue(folder.path);
            drafts[i] = folder.path;
            this.commit();
          });
        })
        .addButton((btn) => {
          btn.setIcon("trash");
          btn.onClick(() => {
            drafts.splice(i, 1);
            this.commit();
            this.display();
          });
        });
    }
```

Closing the tab commits rather than prunes — an edit made inside the debounce
window would otherwise be lost — and then drops the drafts so the next open
re-reads from the plugin:

```bash
sed -n '120,125p' src/settingsTab.ts
```

```output
  hide(): void {
    // Commit rather than prune: an edit made inside the debounce window would
    // otherwise be lost when the tab closes.
    this.commit();
    this.drafts = null;
  }
```

`src/folderSuggest.ts` is what that autocomplete is, in full — Obsidian's
`AbstractInputSuggest` does everything else:

```bash
cat src/folderSuggest.ts
```

```output
import { AbstractInputSuggest, type TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  getSuggestions(query: string): TFolder[] {
    const lowerQuery = query.toLowerCase();
    return this.app.vault
      .getAllFolders()
      .filter((folder) => folder.path.toLowerCase().includes(lowerQuery));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }
}
```

## Modals

`src/modals.ts` holds two. `ConfirmResetModal` adapts Obsidian's
callback-style modal into a promise the plugin can `await`. The `settled` flag
makes the promise resolve exactly once however the modal is dismissed —
button, Escape, or clicking away — and `onClose` is *overridden*, calling
`super.onClose()` so Obsidian's own cleanup still runs:

```bash
sed -n '17,45p' src/modals.ts
```

```output
      .addButton((btn) => {
        btn.setButtonText("Cancel");
        btn.onClick(() => {
          // settle before close: close() runs onClose, which settles false.
          this.settle(false);
          this.close();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Reset");
        btn.setWarning();
        btn.onClick(() => {
          this.settle(true);
          this.close();
        });
      });
  }

  /** Resolves exactly once, whichever way the modal is dismissed. */
  private settle = (confirmed: boolean) => {
    if (this.settled) return;
    this.settled = true;
    this.resolve(confirmed);
  };

  onClose(): void {
    super.onClose();
    this.settle(false);
  }
```

`ReviewMenuModal` (reached via the ribbon icon or "Open review menu") is a
`SuggestModal` whose suggestions adapt to the active file: an unreviewed file
offers "mark and open next" first, a reviewed file offers unreview, and no
eligible file leaves just "open random":

```bash
sed -n '65,91p' src/modals.ts
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

Because `review.ts` and `data.ts` have no Obsidian imports, `bun test` exercises
them directly — no mocking, and the injectable clock and rng make timing and
randomness deterministic. There is no Obsidian mock in the repo at all: adding
one would mean the boundary had leaked. Plugin integration (the Obsidian API
surface) is deliberately not unit-tested.

```bash
grep -c 'test(' src/review.test.ts && grep 'describe(' src/review.test.ts
```

```output
34
describe("isEligible", () => {
describe("setExcludedFolders", () => {
describe("load", () => {
describe("markReviewed", () => {
describe("markUnreviewed", () => {
describe("reset", () => {
describe("pickRandom", () => {
describe("stats", () => {
describe("rename a file", () => {
describe("rename a folder", () => {
describe("remove a file", () => {
describe("remove a folder", () => {
```

One suite per `Review` method, with rename and remove split by file vs folder
because those are the two paths that behave differently. The
deterministic-injection style is visible in the `pickRandom` suite, which pins
the rng to the ends of its range:

```bash
grep -A6 'describe("pickRandom"' src/review.test.ts
```

```output
describe("pickRandom", () => {
  test("picks by the injected rng", () => {
    const items = ["a", "b", "c"];
    expect(pickRandom(items, () => 0)).toBe("a");
    expect(pickRandom(items, () => 0.5)).toBe("b");
    expect(pickRandom(items, () => 0.99)).toBe("c");
  });
```

`data.test.ts` covers `normalizeData` alone, and it is entirely about hostile
input — the point of the function is that no shape on disk can crash the plugin:

```bash
grep -c 'test(' src/data.test.ts && grep -o 'test("[^"]*"' src/data.test.ts
```

```output
8
test("passes a fully valid object through"
test("supplies defaults for an empty object"
test("replaces a non-array excludedFolders with an empty list"
test("replaces a string reviewedPaths with an empty list"
test("drops non-string members of the path lists"
test("drops a reviewStartedAt that is not a parseable date"
test("keeps a date-only reviewStartedAt"
test("falls back to true for a non-boolean showStatusBar"
```

## Build

`build.ts` wraps `Bun.build`. The one subtlety is `throw: false` — Bun's
default rejects with an `AggregateError`, which would make the failure handling
below it unreachable and kill the `--watch` loop on the first typo:

```bash
sed -n '5,28p' build.ts
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
    // Default is `throw: true`, which rejects with an AggregateError and leaves
    // the failure handling below unreachable — and kills the watcher.
    throw: false,
  });

  if (!result.success) {
    console.error("Build failed");
    for (const message of result.logs) console.error(message);
    if (!isWatch) process.exit(1);
    return;
  }

  console.log(
    `Built main.js (${(result.outputs[0].size / 1024).toFixed(1)} KB)`,
  );
}
```

## Where to go next

- `THEORY.md` — the rationale behind random-order review
- `deploy.ts` — copy-to-vault deployment (`OBSIDIAN_DEPLOY_DEST`)
- `CLAUDE.md` — command reference and the release process

The takeaway: anything you want to test goes in `review.ts` or `data.ts` with
injectable dependencies and no Obsidian imports; anything that touches Obsidian
stays in the thin shells around them.
