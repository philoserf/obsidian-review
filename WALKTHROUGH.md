# Review Plugin Walkthrough

*2026-09-09T22:45:13Z by Showboat 0.6.1*
<!-- showboat-id: eb958de8-b84f-4d16-908b-27009d5086b7 -->

## Overview

**Review** is an Obsidian plugin that walks you through your vault one note at a time and
tracks which notes you have already been through. Every markdown file is in exactly one of
two states — reviewed or not reviewed — and the plugin's entire job is to remember that set,
hand you a random note that is not in it, and tell you how far through the vault you are.

The toolchain is Bun-only. Bun runs the tests (`bun test`), bundles `src/main.ts` into a
committed `main.js` (`build.ts`), and copies the built plugin into a vault (`deploy.ts`).
Type checking is `tsc --noEmit`; linting and formatting are Biome.

There are three entry points into the code, and they are worth naming up front because the
rest of the walkthrough follows them:

1. **Obsidian loading the plugin** — Obsidian reads `manifest.json`, requires `main.js`, and
   calls `onload()` on the default export.
2. **The user triggering a command** — five commands registered in `onload`, plus a ribbon
   icon, a status-bar item, and a settings tab.
3. **The vault changing underneath the plugin** — `rename` and `delete` events that the
   plugin must react to in order to keep its stored paths pointing at real files.

```bash
cat manifest.json
```

```output
{
  "id": "review",
  "name": "Review",
  "version": "2.2.0",
  "minAppVersion": "1.6.0",
  "description": "Randomly review your vault and track progress",
  "author": "Mark Ayers (originally by Alexander)",
  "authorUrl": "https://github.com/philoserf",
  "isDesktopOnly": false
}
```

`main` names the bundle Obsidian requires; `isDesktopOnly: false` is honest here because the
plugin touches no Node APIs at runtime — only Obsidian's vault and workspace.

## Architecture

Ten TypeScript files in `src/`, split along one line that governs everything else: two
modules import nothing at all, and the rest import `obsidian`.

```bash
cd src && wc -l *.ts | sort -k1 -n
```

```output
       2 main.ts
      14 folderSuggest.ts
      51 data.ts
      62 statusBar.ts
      92 data.test.ts
     121 modals.ts
     126 settingsTab.ts
     159 review.ts
     250 review.test.ts
     357 plugin.ts
    1234 total
```

The boundary is visible in the imports. `review.ts` and `data.ts` have none; every other
non-test module imports `obsidian`:

```bash
echo 'imports obsidian:'; grep -l 'from "obsidian"' src/*.ts | sort; echo; echo 'imports nothing:'; grep -L 'from "obsidian"' src/*.ts | sort
```

```output
imports obsidian:
src/folderSuggest.ts
src/modals.ts
src/plugin.ts
src/settingsTab.ts
src/statusBar.ts

imports nothing:
src/data.test.ts
src/data.ts
src/main.ts
src/review.test.ts
src/review.ts
```

That is not incidental tidiness. It is why there is no Obsidian mock in the repository: the
47 unit tests run against the real `Review` and the real `normalizeData`, because those two
modules can be constructed without an Obsidian runtime. `main.ts` is on the second list only
because it is two lines of re-export.

Data flows in one direction most of the time:

    data.json  --loadData-->  normalizeData  -->  plugin.data  -->  Review (in memory)
                                                       ^                  |
                                                       +---saveSettings---+
                                                                |
                                                            saveData --> data.json

The vault is consulted, never mirrored: whenever the plugin needs to know what files exist
it calls `vault.getMarkdownFiles()` fresh.

## The entry point

`src/main.ts` exists only because Obsidian requires the bundle's default export to come
from an entry file of that name.

```bash
cat -n src/main.ts
```

```output
     1	// Obsidian's expected entrypoint — the plugin lives in plugin.ts.
     2	export { default } from "./plugin";
```

## The persisted shape (`src/data.ts`)

Before looking at the plugin class it helps to know exactly what ends up in `data.json`.
It is five fields, and the file is small enough to take in at once.

```bash
cat -n src/data.ts | sed -n '1,23p'
```

```output
     1	export type PluginData = {
     2	  schemaVersion: number;
     3	  reviewedPaths: string[];
     4	  reviewStartedAt?: string;
     5	  excludedFolders: string[];
     6	  showStatusBar: boolean;
     7	};
     8	
     9	export const CURRENT_SCHEMA_VERSION = 2;
    10	
    11	export const DEFAULT_DATA: PluginData = {
    12	  schemaVersion: CURRENT_SCHEMA_VERSION,
    13	  reviewedPaths: [],
    14	  excludedFolders: [],
    15	  showStatusBar: true,
    16	};
    17	
    18	export type SavedData = Partial<PluginData>;
    19	
    20	function stringArray(value: unknown): string[] {
    21	  if (!Array.isArray(value)) return [];
    22	  return value.filter((item): item is string => typeof item === "string");
    23	}
```

`reviewedPaths` is the whole state of a review; `reviewStartedAt` is an ISO timestamp set on
the first mark and cleared on reset; `excludedFolders` is configuration; `showStatusBar` is a
display preference. `schemaVersion` is not a migration hook — as we will see in
`loadSettings`, it is a fence that stops a newer plugin's file from being overwritten by an
older build.

Everything read out of `data.json` goes through `normalizeData` first. The docstring says
why, and it is worth reading rather than skimming: the file is hand-editable and
sync-editable, and a spread would happily overwrite a well-typed default with a wrong-typed
value.

```bash
cat -n src/data.ts | sed -n '25,51p'
```

```output
    25	/**
    26	 * `data.json` is the least trustworthy thing the plugin reads: a hand-edit, a
    27	 * sync conflict, or a schema written by a future version can put any shape in
    28	 * it, and a spread happily overwrites a well-typed default with a wrong-typed
    29	 * value. Coerce rather than throw — a bad field must degrade to its default so
    30	 * the settings tab still renders and the user can repair it from the UI.
    31	 */
    32	export function normalizeData(raw: unknown): Omit<PluginData, "schemaVersion"> {
    33	  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    34	    string,
    35	    unknown
    36	  >;
    37	  const startedAt = data.reviewStartedAt;
    38	
    39	  return {
    40	    reviewedPaths: stringArray(data.reviewedPaths),
    41	    reviewStartedAt:
    42	      typeof startedAt === "string" && !Number.isNaN(Date.parse(startedAt))
    43	        ? startedAt
    44	        : undefined,
    45	    excludedFolders: stringArray(data.excludedFolders),
    46	    showStatusBar:
    47	      typeof data.showStatusBar === "boolean"
    48	        ? data.showStatusBar
    49	        : DEFAULT_DATA.showStatusBar,
    50	  };
    51	}
```

Two details to carry forward. `Date.parse` is what validates `reviewStartedAt`, so
`"2026-03-23"` survives but `"yesterday"` and a numeric epoch do not. And the return type is
`Omit<PluginData, "schemaVersion">` — `schemaVersion` is deliberately *not* normalized here;
`plugin.ts` reads it straight off the raw object.

## The domain logic (`src/review.ts`)

`Review` owns every persisted review field and imports nothing. Above it sits the one free
function in the module.

```bash
cat -n src/review.ts | sed -n '1,14p'
```

```output
     1	/** Uniform choice, or undefined when there is nothing to choose from. */
     2	export function pickRandom<T>(
     3	  items: readonly T[],
     4	  rng: () => number = Math.random,
     5	): T | undefined {
     6	  if (!items.length) return undefined;
     7	  return items[Math.floor(rng() * items.length)];
     8	}
     9	
    10	export type ReviewStats = {
    11	  reviewed: number;
    12	  eligible: number;
    13	  percentCompleted: number;
    14	};
```

The `rng` parameter defaults to `Math.random` and exists so the tests can pin the choice —
the same trick `markReviewed` uses for the clock. Returning `undefined` rather than throwing
on an empty list pushes the "nothing to pick" decision up to the caller, which turns out to
matter: the caller distinguishes *no eligible files* from *nothing left unreviewed*, and
says different things about each.

Now the class itself.

```bash
cat -n src/review.ts | sed -n '16,41p'
```

```output
    16	/**
    17	 * Every persisted review field under one owner, free of Obsidian APIs so it can
    18	 * be tested directly. The plugin owns one instance, feeds it persisted data via
    19	 * load(), and reads the fields back out when saving.
    20	 *
    21	 * The vault is the source of truth for what exists, so rename()/remove()
    22	 * reconcile the stored paths against it rather than maintaining an
    23	 * authoritative file list. That reconciliation covers excludedFolders too — it
    24	 * lives here for exactly that reason.
    25	 */
    26	export class Review {
    27	  reviewedPaths = new Set<string>();
    28	  reviewStartedAt?: string;
    29	  excludedFolders: string[] = [];
    30	
    31	  load(paths: string[], excludedFolders: string[], startedAt?: string): void {
    32	    this.reviewedPaths = new Set(paths);
    33	    this.excludedFolders = [...excludedFolders];
    34	    this.reviewStartedAt = startedAt;
    35	  }
    36	
    37	  isEligible(path: string): boolean {
    38	    return !this.excludedFolders.some((folder) =>
    39	      path.startsWith(`${folder}/`),
    40	    );
    41	  }
```

`load` replaces state wholesale rather than merging — it is used both for the initial load
and for the rollback path in `plugin.ts`, and both need a clean overwrite.

`isEligible` is the entire eligibility rule. Note the trailing slash in `${folder}/`: it is
what stops an exclusion of `templates` from also excluding `templates-extra/note.md`, and it
means a root-level file can never be excluded because no prefix can match. There is a test
for each of those.

Excluded folders have exactly one writer, and the comment explains why concentrating the
normalization there is load-bearing rather than tidy.

```bash
cat -n src/review.ts | sed -n '43,58p'
```

```output
    43	  /**
    44	   * The only way in. A folder that is not trimmed of whitespace or trailing
    45	   * slashes matches nothing, silently, so normalizing anywhere but here would
    46	   * leave a way to store one.
    47	   */
    48	  setExcludedFolders(list: string[]): void {
    49	    const normalized: string[] = [];
    50	    const seen = new Set<string>();
    51	    for (const entry of list) {
    52	      const folder = entry.trim().replace(/\/+$/, "");
    53	      if (!folder || seen.has(folder)) continue;
    54	      seen.add(folder);
    55	      normalized.push(folder);
    56	    }
    57	    this.excludedFolders = normalized;
    58	  }
```

`entry.trim().replace(/\/+$/, "")` handles the two ways a hand-typed folder goes wrong —
stray whitespace and a trailing slash — and the `seen` set collapses entries that normalize
to the same folder. An entry that survives all that but is empty is dropped, which is why
`"/"` disappears entirely.

The mutators are unremarkable except for one thing: the review clock starts on the *first*
mark and is never restarted by a later one.

```bash
cat -n src/review.ts | sed -n '60,91p'
```

```output
    60	  isReviewed(path: string): boolean {
    61	    return this.reviewedPaths.has(path);
    62	  }
    63	
    64	  markReviewed(
    65	    path: string,
    66	    now: () => string = () => new Date().toISOString(),
    67	  ): void {
    68	    this.reviewedPaths.add(path);
    69	    if (!this.reviewStartedAt) this.reviewStartedAt = now();
    70	  }
    71	
    72	  markUnreviewed(path: string): void {
    73	    this.reviewedPaths.delete(path);
    74	  }
    75	
    76	  reset(): void {
    77	    this.reviewedPaths.clear();
    78	    this.reviewStartedAt = undefined;
    79	  }
    80	
    81	  stats(eligible: string[]): ReviewStats {
    82	    const reviewed = eligible.filter((p) => this.reviewedPaths.has(p)).length;
    83	    const eligibleCount = eligible.length;
    84	    return {
    85	      reviewed,
    86	      eligible: eligibleCount,
    87	      percentCompleted: eligibleCount
    88	        ? Math.round((reviewed / eligibleCount) * 100)
    89	        : 0,
    90	    };
    91	  }
```

`reset()` clears the paths and the clock but leaves `excludedFolders` alone — starting a new
sweep does not discard your configuration.

`stats()` takes the eligible list as an argument rather than computing it, because computing
it requires the vault and `Review` cannot see the vault. That signature also has a quiet
consequence: it *intersects*. A path that was marked reviewed and later fell into an
excluded folder stays in `reviewedPaths` but is not counted, so stale entries are invisible
rather than wrong.

## Reconciling with the vault

This is the part that pays for "the vault is the source of truth". When a file or folder
moves or disappears, the stored paths have to follow. `rename` and `remove` dispatch on a
plain boolean — the `TFolder` check happens on the Obsidian side of the boundary.

```bash
cat -n src/review.ts | sed -n '93,105p'
```

```output
    93	  rename(oldPath: string, newPath: string, isFolder: boolean): boolean {
    94	    if (!isFolder) {
    95	      if (!this.reviewedPaths.has(oldPath)) return false;
    96	      this.reviewedPaths.delete(oldPath);
    97	      this.reviewedPaths.add(newPath);
    98	      return true;
    99	    }
   100	    return this.renameFolder(oldPath, newPath);
   101	  }
   102	
   103	  remove(path: string, isFolder: boolean): boolean {
   104	    return isFolder ? this.removeFolder(path) : this.reviewedPaths.delete(path);
   105	  }
```

The file case returns `false` when there is nothing to do, and every caller uses that return
value to decide whether a save is even needed. The folder cases are where the real work is.

```bash
cat -n src/review.ts | sed -n '107,136p'
```

```output
   107	  private renameFolder(oldPath: string, newPath: string): boolean {
   108	    const oldPrefix = `${oldPath}/`;
   109	    const newPrefix = `${newPath}/`;
   110	    let changed = false;
   111	
   112	    const moved: string[] = [];
   113	    for (const p of this.reviewedPaths) {
   114	      if (p.startsWith(oldPrefix)) {
   115	        this.reviewedPaths.delete(p);
   116	        moved.push(newPrefix + p.slice(oldPrefix.length));
   117	        changed = true;
   118	      }
   119	    }
   120	    for (const p of moved) this.reviewedPaths.add(p);
   121	
   122	    // The excluded folder itself, and any excluded folder beneath it.
   123	    this.excludedFolders = this.excludedFolders.map((folder) => {
   124	      if (folder === oldPath) {
   125	        changed = true;
   126	        return newPath;
   127	      }
   128	      if (folder.startsWith(oldPrefix)) {
   129	        changed = true;
   130	        return newPrefix + folder.slice(oldPrefix.length);
   131	      }
   132	      return folder;
   133	    });
   134	
   135	    return changed;
   136	  }
```

Two things here reward a second look.

The rewritten paths are collected into `moved` and added *after* the loop finishes. Deleting
from a `Set` while iterating it is safe in JavaScript, but adding is not — a newly added
entry can be visited by the same iteration. Since a rename can produce a path that also
starts with `oldPrefix` (renaming `a` to `a/b`, say), buffering is the difference between
correct and an infinite loop.

The `excludedFolders` rewrite is the fix for a real bug, and the test that guards it names
the issue.

```bash
cat -n src/review.test.ts | sed -n '182,189p'
```

```output
   182	  // #80: excluding Templates then moving it silently un-excluded everything
   183	  // in it, while the settings tab went on listing the old path.
   184	  test("rewrites the excluded folder itself", () => {
   185	    const review = reviewWith([], ["Templates"]);
   186	    expect(review.rename("Templates", "Meta/Templates", true)).toBe(true);
   187	    expect(review.excludedFolders).toEqual(["Meta/Templates"]);
   188	    expect(review.isEligible("Meta/Templates/note.md")).toBe(false);
   189	  });
```

Deletion is the same shape, minus the rewriting.

```bash
cat -n src/review.ts | sed -n '138,158p'
```

```output
   138	  private removeFolder(folderPath: string): boolean {
   139	    const prefix = `${folderPath}/`;
   140	    let changed = false;
   141	
   142	    for (const p of this.reviewedPaths) {
   143	      if (p.startsWith(prefix)) {
   144	        this.reviewedPaths.delete(p);
   145	        changed = true;
   146	      }
   147	    }
   148	
   149	    const kept = this.excludedFolders.filter(
   150	      (folder) => folder !== folderPath && !folder.startsWith(prefix),
   151	    );
   152	    if (kept.length !== this.excludedFolders.length) {
   153	      this.excludedFolders = kept;
   154	      changed = true;
   155	    }
   156	
   157	    return changed;
   158	  }
```

## The plugin class (`src/plugin.ts`)

Everything Obsidian-facing lives here. The class fields are worth reading before any method,
because two of them are the persistence machinery the rest of the file is built around.

```bash
cat -n src/plugin.ts | sed -n '19,44p'
```

```output
    19	export default class ReviewPlugin extends Plugin {
    20	  data!: PluginData;
    21	  readonly review = new Review();
    22	  statusBar!: StatusBar;
    23	
    24	  /**
    25	   * Why writing is refused, or null when it is allowed. Set on every path
    26	   * through loadSettings: data we failed to read must not be overwritten by
    27	   * the defaults we fell back to, and data from a newer plugin version must
    28	   * not be truncated to what this version understands.
    29	   */
    30	  private saveBlocked: string | null = null;
    31	
    32	  /** Tail of the serialized write queue. Never rejects. */
    33	  private savePending: Promise<void> = Promise.resolve();
    34	
    35	  /**
    36	   * Fire-and-forget bridge for UI callbacks that cannot await: surfaces
    37	   * rejections via Notice instead of letting them vanish.
    38	   */
    39	  runAsync = (promise: Promise<unknown>, label: string) => {
    40	    promise.catch((err) => {
    41	      console.error(`[review] ${label} failed`, err);
    42	      new Notice(`Review: ${label} failed — see console for details.`);
    43	    });
    44	  };
```

`saveBlocked` is a write fence: non-null means "refuse to write", and the string it holds is
the reason, shown to the user verbatim. `savePending` is the tail of a promise chain that
serializes writes. `runAsync` exists because Obsidian's callbacks are synchronous and cannot
await — without it a rejected save would vanish into an unhandled rejection and the user
would never learn their progress was not recorded.

`onload` is the registration surface. It loads settings first, because everything else needs
`this.data`.

```bash
cat -n src/plugin.ts | sed -n '46,68p'
```

```output
    46	  onload = async () => {
    47	    await this.loadSettings();
    48	
    49	    this.addRibbonIcon("scan-eye", "Open review", () => {
    50	      this.openReviewMenu();
    51	    });
    52	
    53	    this.statusBar = new StatusBar(this.addStatusBarItem(), this);
    54	
    55	    this.addCommand({
    56	      id: "open-random-unreviewed",
    57	      name: "Open random unreviewed file",
    58	      callback: () => this.runAsync(this.openRandomFile(), "open random file"),
    59	    });
    60	    this.addCommand({
    61	      id: "mark-reviewed",
    62	      name: "Mark file as reviewed",
    63	      checkCallback: (checking) => {
    64	        if (this.getActiveFileStatus() !== "not_reviewed") return false;
    65	        if (!checking) this.runAsync(this.markReviewed(), "mark reviewed");
    66	        return true;
    67	      },
    68	    });
```

The `checkCallback` pattern is Obsidian's way of conditionally hiding a command from the
palette: returning `false` when `checking` is true removes it from the list. All three
mutating commands gate on `getActiveFileStatus()`, so "Mark file as reviewed" simply is not
offered for a file that is already reviewed, is not markdown, or sits in an excluded folder.

The rest of `onload` wires the settings tab and the two vault events that keep stored paths
honest.

```bash
cat -n src/plugin.ts | sed -n '94,115p'
```

```output
    94	    this.addSettingTab(new ReviewSettingTab(this.app, this));
    95	
    96	    this.registerEvent(
    97	      this.app.vault.on("rename", (file, oldPath) =>
    98	        this.runAsync(
    99	          this.handleFileRename(file, oldPath),
   100	          "update review state after rename",
   101	        ),
   102	      ),
   103	    );
   104	    this.registerEvent(
   105	      this.app.vault.on("delete", (file) =>
   106	        this.runAsync(
   107	          this.handleFileDelete(file),
   108	          "update review state after delete",
   109	        ),
   110	      ),
   111	    );
   112	    this.registerEvent(
   113	      this.app.workspace.on("file-open", this.statusBar.update),
   114	    );
   115	  };
```

`registerEvent` hands the subscription to Obsidian's lifecycle so it is torn down on unload.
Both handlers are wrapped in `runAsync` because `vault.on` callbacks are synchronous.

### Loading, and the write fence

`loadSettings` is longer than it looks like it should be, and every branch is load-bearing.

```bash
cat -n src/plugin.ts | sed -n '117,148p'
```

```output
   117	  loadSettings = async () => {
   118	    let saved: SavedData | null = null;
   119	    let loadFailed = false;
   120	    try {
   121	      saved = await this.loadData();
   122	    } catch (err) {
   123	      // Distinct from `saved === null`, which is also a fresh install.
   124	      loadFailed = true;
   125	      console.error("[review] loadData failed; running read-only", err);
   126	      new Notice(
   127	        "Review: could not read saved data. The plugin is read-only until Obsidian reloads it — your saved review will not be overwritten. See console for details.",
   128	      );
   129	    }
   130	
   131	    const savedVersion = saved?.schemaVersion ?? CURRENT_SCHEMA_VERSION;
   132	    const isNewer = savedVersion > CURRENT_SCHEMA_VERSION;
   133	
   134	    if (isNewer) {
   135	      console.warn(
   136	        `[review] data has schema v${savedVersion}, newer than v${CURRENT_SCHEMA_VERSION}; loading read-only`,
   137	      );
   138	      new Notice(
   139	        "Review: saved data is from a newer plugin version. Changes will not be saved until the plugin is updated.",
   140	      );
   141	    }
   142	
   143	    this.data = {
   144	      ...normalizeData(saved),
   145	      // Keep a newer version's number, so the file is not truncated to v2
   146	      // if something later lifts the write block.
   147	      schemaVersion: isNewer ? savedVersion : CURRENT_SCHEMA_VERSION,
   148	    };
```

Two failure modes, deliberately kept apart. `loadData` *throwing* means there is a file we
could not read; `loadData` returning `null` means a fresh install. Both leave `saved` falsy,
which is why the separate `loadFailed` flag exists — the comment on line 123 is there
because collapsing them would be an easy and destructive "simplification".

The schema check compares against `CURRENT_SCHEMA_VERSION`, which is `2`. This is the fence
mentioned earlier: newer data is loaded read-only rather than migrated or refused, and line
147 keeps the newer version number so that if the block is ever lifted the file is not
stamped back down to 2.

The tail sets the fence and hands the loaded values to `Review`.

```bash
cat -n src/plugin.ts | sed -n '150,165p'
```

```output
   150	    // Assigned on every path, back to null included, so a reload after a
   151	    // transient read failure lifts the block.
   152	    if (loadFailed) {
   153	      this.saveBlocked = "saved data could not be read";
   154	    } else if (isNewer) {
   155	      this.saveBlocked = "saved data is from a newer plugin version";
   156	    } else {
   157	      this.saveBlocked = null;
   158	    }
   159	
   160	    this.review.load(
   161	      this.data.reviewedPaths,
   162	      this.data.excludedFolders,
   163	      this.data.reviewStartedAt,
   164	    );
   165	  };
```

Note the assignment on *every* path, including back to `null`. A transient read failure is
lifted by the next successful load rather than sticking for the session.

### Saving

`saveSettings` is the only path to disk, and it does three distinct jobs.

```bash
cat -n src/plugin.ts | sed -n '167,197p'
```

```output
   167	  saveSettings = (): Promise<void> => {
   168	    if (this.saveBlocked) {
   169	      console.warn(`[review] not saving: ${this.saveBlocked}`);
   170	      new Notice(
   171	        `Review: ${this.saveBlocked}. Changes will not be saved until you reload.`,
   172	      );
   173	      return Promise.resolve();
   174	    }
   175	
   176	    this.data.reviewedPaths = [...this.review.reviewedPaths];
   177	    this.data.excludedFolders = [...this.review.excludedFolders];
   178	    this.data.reviewStartedAt = this.review.reviewStartedAt;
   179	
   180	    // Snapshot at call time, not write time: a queued write must carry the
   181	    // state that was current when it was requested, not whatever `this.data`
   182	    // holds by the time its turn comes.
   183	    const payload: PluginData = {
   184	      ...this.data,
   185	      reviewedPaths: [...this.data.reviewedPaths],
   186	      excludedFolders: [...this.data.excludedFolders],
   187	    };
   188	
   189	    // Serialize, so overlapping saves land in call order. Both arms run the
   190	    // write: a failed predecessor must not stop its successor.
   191	    const next = this.savePending.then(
   192	      () => this.writeSettings(payload),
   193	      () => this.writeSettings(payload),
   194	    );
   195	    this.savePending = next.catch(() => {});
   196	    return next;
   197	  };
```

Reading it in order: check the fence and bail; copy `Review`'s state into `this.data`; deep-
copy that into an immutable `payload`; append the write to the chain.

The two identical arms on line 191-193 look like a mistake and are not — `then(onFulfilled,
onRejected)` with the same function in both positions means "run regardless of whether the
predecessor succeeded". The line below re-tails the chain with `.catch(() => {})` so
`savePending` itself never rejects, while `next` — the promise the caller gets — still does.

`writeSettings` is the only place `saveData` is called, and it exists so the failure log can
say how much data was at stake.

```bash
cat -n src/plugin.ts | sed -n '199,214p'
```

```output
   199	  private writeSettings = async (data: PluginData) => {
   200	    try {
   201	      await this.saveData(data);
   202	    } catch (err) {
   203	      console.error(
   204	        `[review] saveData failed (${data.reviewedPaths.length} reviewed paths, ${data.excludedFolders.length} excluded folders)`,
   205	        err,
   206	      );
   207	      throw err;
   208	    }
   209	  };
   210	
   211	  onExternalSettingsChange = async () => {
   212	    await this.loadSettings();
   213	    this.statusBar.update();
   214	  };
```

`onExternalSettingsChange` is Obsidian's hook for "another process rewrote `data.json`" —
the sync case. It re-reads and repaints, which also re-evaluates the fence.

### Reading the current state

A short block of queries sits between the persistence machinery and the actions. Every one
of them consults the vault rather than any stored file list.

```bash
cat -n src/plugin.ts | sed -n '216,244p'
```

```output
   216	  getActiveMarkdownFile = (): TFile | null => {
   217	    const activeFile = this.app.workspace.getActiveFile();
   218	    if (activeFile?.extension !== "md") return null;
   219	    return activeFile;
   220	  };
   221	
   222	  isFileEligible = (path: string): boolean => {
   223	    return this.review.isEligible(path);
   224	  };
   225	
   226	  getEligibleFiles = (): TFile[] => {
   227	    return this.app.vault
   228	      .getMarkdownFiles()
   229	      .filter((f) => this.isFileEligible(f.path));
   230	  };
   231	
   232	  getActiveFileStatus = (): "reviewed" | "not_reviewed" | undefined => {
   233	    const file = this.getActiveMarkdownFile();
   234	    if (!file || !this.isFileEligible(file.path)) return undefined;
   235	    return this.isReviewed(file.path) ? "reviewed" : "not_reviewed";
   236	  };
   237	
   238	  isReviewed = (path: string): boolean => {
   239	    return this.review.isReviewed(path);
   240	  };
   241	
   242	  getStats = (): ReviewStats => {
   243	    return this.review.stats(this.getEligibleFiles().map((f) => f.path));
   244	  };
```

`getActiveFileStatus` is the one to remember. It has three results, not two, and `undefined`
means "this file is outside the review" — non-markdown, or in an excluded folder. The status
bar hides itself on `undefined`, the commands hide themselves, and the menu modal offers a
shorter list. Every consumer of "is this file reviewed?" goes through this function rather
than asking `Review` directly, so the eligibility check can never be skipped by accident.

### Actions

Opening a random file is where `pickRandom`'s `undefined` return pays off.

```bash
cat -n src/plugin.ts | sed -n '250,270p'
```

```output
   250	  openRandomFile = async () => {
   251	    // An empty eligible list and a fully reviewed one are different problems,
   252	    // and congratulating someone on a review they never started points them
   253	    // away from the settings tab, which is where the actual fault is.
   254	    const eligible = this.getEligibleFiles();
   255	    if (!eligible.length) {
   256	      new Notice(
   257	        "No files are eligible for review — check your excluded folders.",
   258	      );
   259	      return;
   260	    }
   261	
   262	    const unreviewed = eligible.filter((f) => !this.review.isReviewed(f.path));
   263	    if (!unreviewed.length) {
   264	      new Notice("All files are reviewed");
   265	      return;
   266	    }
   267	
   268	    const next = pickRandom(unreviewed);
   269	    if (next) await this.app.workspace.getLeaf(false).openFile(next);
   270	  };
```

The comment states the reasoning: an empty vault-after-exclusions and a fully reviewed vault
are different problems, and telling someone "All files are reviewed" when they have
accidentally excluded everything sends them looking in the wrong place. That distinction was
issue #102.

Every state-changing action funnels through one method.

```bash
cat -n src/plugin.ts | sed -n '272,304p'
```

```output
   272	  /**
   273	   * Apply a review-state change and report whether it was persisted. The UI
   274	   * must not show progress that is not on disk: a refused write is declined
   275	   * before anything changes, and a failed one is rolled back.
   276	   */
   277	  private mutate = async (apply: () => void): Promise<boolean> => {
   278	    if (this.saveBlocked) {
   279	      new Notice(
   280	        `Review: ${this.saveBlocked}. Changes will not be saved until you reload.`,
   281	      );
   282	      return false;
   283	    }
   284	
   285	    // Settle any in-flight write first, so a rollback cannot be overtaken by
   286	    // a save that was already queued from the state we are about to undo.
   287	    await this.savePending;
   288	
   289	    const paths = [...this.review.reviewedPaths];
   290	    const excludedFolders = [...this.review.excludedFolders];
   291	    const startedAt = this.review.reviewStartedAt;
   292	
   293	    apply();
   294	    this.statusBar.update();
   295	
   296	    try {
   297	      await this.saveSettings();
   298	      return true;
   299	    } catch (err) {
   300	      this.review.load(paths, excludedFolders, startedAt);
   301	      this.statusBar.update();
   302	      throw err;
   303	    }
   304	  };
```

Read it as four steps: refuse if fenced, drain the queue, snapshot-apply-save, roll back on
failure. The boolean return is not decoration — `markReviewed({ openNext: true })` uses it to
decide whether to advance, so a failed save leaves you on the file you were looking at rather
than moving on as if it had worked.

The three callers are thin.

```bash
cat -n src/plugin.ts | sed -n '306,333p'
```

```output
   306	  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
   307	    const file = this.getActiveMarkdownFile();
   308	    if (!file) return;
   309	
   310	    const saved = await this.mutate(() => this.review.markReviewed(file.path));
   311	    if (saved && openNext) await this.openRandomFile();
   312	  };
   313	
   314	  markUnreviewed = async () => {
   315	    const file = this.getActiveMarkdownFile();
   316	    if (!file) return;
   317	
   318	    await this.mutate(() => this.review.markUnreviewed(file.path));
   319	  };
   320	
   321	  setExcludedFolders = async (list: string[]): Promise<boolean> => {
   322	    return this.mutate(() => this.review.setExcludedFolders(list));
   323	  };
   324	
   325	  resetReview = async ({
   326	    confirm = true,
   327	  }: {
   328	    confirm?: boolean;
   329	  } = {}): Promise<boolean> => {
   330	    if (confirm && !(await this.confirmReset())) return false;
   331	
   332	    return this.mutate(() => this.review.reset());
   333	  };
```

`resetReview` takes `confirm` so the modal can be skipped by a caller that has already asked,
and `confirmReset` wraps `ConfirmResetModal` in a promise so the async flow reads linearly.

The vault handlers are the exception to the `mutate` rule, and they say so by their shape:
they call `saveSettings` directly, because the vault has already moved the file and there is
nothing to roll back to.

```bash
cat -n src/plugin.ts | sed -n '342,357p'
```

```output
   342	  // The `instanceof` stays on this side of the boundary so `Review` needs no
   343	  // Obsidian import and stays directly testable.
   344	  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
   345	    if (this.review.rename(oldPath, file.path, file instanceof TFolder)) {
   346	      this.statusBar.update();
   347	      await this.saveSettings();
   348	    }
   349	  };
   350	
   351	  private handleFileDelete = async (file: TAbstractFile) => {
   352	    if (this.review.remove(file.path, file instanceof TFolder)) {
   353	      this.statusBar.update();
   354	      await this.saveSettings();
   355	    }
   356	  };
   357	}
```

That is the whole plugin class. Note the `instanceof TFolder` on line 345: this is the only
place in the codebase where Obsidian's type hierarchy is consulted, and the comment above it
is the boundary being defended out loud.

## The UI

### Status bar (`src/statusBar.ts`)

The status bar renders `getActiveFileStatus()` and doubles as an input surface.

```bash
cat -n src/statusBar.ts | sed -n '19,29p'
```

```output
    19	  update = () => {
    20	    const status = this.plugin.getActiveFileStatus();
    21	    if (!status) {
    22	      this.setIsVisible(false);
    23	      return;
    24	    }
    25	
    26	    this.setIsVisible(this.plugin.data.showStatusBar);
    27	
    28	    this.element.setText(status === "reviewed" ? "Reviewed" : "Not reviewed");
    29	  };
```

Three states again: `undefined` hides the item entirely, and only an eligible markdown file
respects the user's `showStatusBar` preference. Clicking opens a two-item checkable menu
that routes back into `markReviewed` / `markUnreviewed`.

Hiding is done in an unusual way, and the comment is the reason to leave it alone.

```bash
cat -n src/statusBar.ts | sed -n '56,61p'
```

```output
    56	  // Obsidian's own `is-hidden` rules are scoped to ribbon and stacked-tab
    57	  // elements, so the class styles nothing on a status-bar item. `toggle` sets
    58	  // inline display, which needs no stylesheet to agree with it.
    59	  private setIsVisible = (isVisible: boolean) => {
    60	    this.element.toggle(isVisible);
    61	  };
```

### Modals (`src/modals.ts`)

`ConfirmResetModal` has to resolve its promise exactly once, whichever way the modal is
dismissed — button, Escape key, or click-outside. It solves that with a latch.

```bash
cat -n src/modals.ts | sed -n '35,46p'
```

```output
    35	  /** Resolves exactly once, whichever way the modal is dismissed. */
    36	  private settle = (confirmed: boolean) => {
    37	    if (this.settled) return;
    38	    this.settled = true;
    39	    this.resolve(confirmed);
    40	  };
    41	
    42	  onClose(): void {
    43	    super.onClose();
    44	    this.settle(false);
    45	  }
    46	}
```

Both buttons call `settle(...)` *before* `close()`, because `close()` runs `onClose`, which
settles `false`. The latch makes the first call win. `onClose` calls `super.onClose()` first
so Obsidian's own cleanup still runs — issue #103 was this method shadowing the base
implementation instead of overriding it.

`ReviewMenuModal` builds its list from the active file's status, and the *ordering* carries
intent.

```bash
cat -n src/modals.ts | sed -n '65,96p'
```

```output
    65	  getSuggestions = (query: string): ReviewCommand[] => {
    66	    const file = this.plugin.getActiveMarkdownFile();
    67	    let suggestions: ReviewCommand[];
    68	
    69	    if (!file || !this.plugin.isFileEligible(file.path)) {
    70	      suggestions = [
    71	        { id: "open_random", name: "Open random unreviewed file" },
    72	      ];
    73	    } else {
    74	      const isReviewed = this.plugin.isReviewed(file.path);
    75	
    76	      if (isReviewed) {
    77	        suggestions = [
    78	          { id: "open_random", name: "Open random unreviewed file" },
    79	          { id: "unreview", name: "Mark file as unreviewed" },
    80	        ];
    81	      } else {
    82	        suggestions = [
    83	          {
    84	            id: "review_and_next",
    85	            name: "Mark file as reviewed and open next",
    86	          },
    87	          { id: "review", name: "Mark file as reviewed" },
    88	          { id: "open_random", name: "Open random unreviewed file" },
    89	        ];
    90	      }
    91	    }
    92	
    93	    return suggestions.filter((s) =>
    94	      s.name.toLowerCase().includes(query.toLowerCase()),
    95	    );
    96	  };
```

When the current file is unreviewed, "Mark file as reviewed and open next" is first — that is
the loop the plugin exists to accelerate, one keystroke per note. When the file is already
reviewed, "open random" leads instead. The final `filter` is the SuggestModal contract:
Obsidian passes the typed query and expects the list already filtered.

### Settings tab (`src/settingsTab.ts`)

The settings tab keeps a third copy of the excluded-folder list, and the docstring explains
why that is not redundancy.

```bash
cat -n src/settingsTab.ts | sed -n '8,29p'
```

```output
     8	  /**
     9	   * Excluded-folder rows as typed, before normalization — null while the tab
    10	   * is closed. Rows live here rather than in the plugin so a half-typed or
    11	   * momentarily-empty one survives on screen: setExcludedFolders drops empties
    12	   * and dedupes, which would otherwise delete a row out from under the user
    13	   * mid-word.
    14	   */
    15	  private drafts: string[] | null = null;
    16	
    17	  private debouncedCommit = debounce(() => this.commit(), 500, true);
    18	
    19	  constructor(app: App, plugin: ReviewPlugin) {
    20	    super(app, plugin);
    21	    this.plugin = plugin;
    22	  }
    23	
    24	  private commit(): void {
    25	    this.plugin.runAsync(
    26	      this.plugin.setExcludedFolders(this.drafts ?? []),
    27	      "save excluded folders",
    28	    );
    29	  }
```

`setExcludedFolders` drops empties and dedupes. If the on-screen rows *were* the stored list,
clearing a row to retype it would delete the row, and typing the second `T` of a duplicate
`Templates` would collapse two rows into one mid-word. So the rows live in `drafts` and
normalization happens only when the debounce fires.

```bash
cat -n src/settingsTab.ts | sed -n '71,97p'
```

```output
    71	    for (let i = 0; i < drafts.length; i++) {
    72	      new Setting(containerEl)
    73	        .setClass("review-excluded-folder")
    74	        .addText((text) => {
    75	          text.setValue(drafts[i]);
    76	          // Only the draft changes per keystroke; normalization runs once the
    77	          // debounce fires, so typing a second "Templates" cannot collapse two
    78	          // visible rows into one entry mid-word.
    79	          text.onChange((value) => {
    80	            drafts[i] = value;
    81	            this.debouncedCommit();
    82	          });
    83	          new FolderSuggest(this.app, text.inputEl).onSelect((folder) => {
    84	            text.setValue(folder.path);
    85	            drafts[i] = folder.path;
    86	            this.commit();
    87	          });
    88	        })
    89	        .addButton((btn) => {
    90	          btn.setIcon("trash");
    91	          btn.onClick(() => {
    92	            drafts.splice(i, 1);
    93	            this.commit();
    94	            this.display();
    95	          });
    96	        });
    97	    }
```

`for (let i = ...)` is required, not stylistic: each iteration needs its own binding of `i`
for the two closures to address the right row. Picking from the autocomplete commits
immediately rather than waiting out the debounce, because a click is unambiguous in a way
that a keystroke is not.

Closing the tab commits rather than prunes.

```bash
cat -n src/settingsTab.ts | sed -n '120,126p'
```

```output
   120	  hide(): void {
   121	    // Commit rather than prune: an edit made inside the debounce window would
   122	    // otherwise be lost when the tab closes.
   123	    this.commit();
   124	    this.drafts = null;
   125	  }
   126	}
```

Setting `drafts` to `null` means the next `display()` re-seeds from
`plugin.review.excludedFolders` — the normalized list — so reopening the tab shows what is
actually stored.

### Folder autocomplete (`src/folderSuggest.ts`)

The smallest module in the project, and it is small because `AbstractInputSuggest` supplies
everything except the query.

```bash
cat -n src/folderSuggest.ts
```

```output
     1	import { AbstractInputSuggest, type TFolder } from "obsidian";
     2	
     3	export class FolderSuggest extends AbstractInputSuggest<TFolder> {
     4	  getSuggestions(query: string): TFolder[] {
     5	    const lowerQuery = query.toLowerCase();
     6	    return this.app.vault
     7	      .getAllFolders()
     8	      .filter((folder) => folder.path.toLowerCase().includes(lowerQuery));
     9	  }
    10	
    11	  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    12	    el.setText(folder.path);
    13	  }
    14	}
```

## Tests

Only the two Obsidian-free modules are unit tested, and that is the point — there is no mock,
so the tests exercise the real classes. The `describe` blocks map one-to-one onto the public
surface of `Review` and `normalizeData`.

```bash
cat src/review.test.ts src/data.test.ts | grep '^describe' | sed 's/describe("/  /; s/", () => {//'
```

```output
  isEligible
  setExcludedFolders
  load
  markReviewed
  markUnreviewed
  reset
  pickRandom
  stats
  rename a file
  rename a folder
  remove a file
  remove a folder
  normalizeData
```

Determinism comes from injection rather than mocking: `markReviewed(path, now)` takes a clock
and `pickRandom(items, rng)` takes a generator, both defaulted, so a test can pin either
without a framework.

```bash
bun test 2>&1 | grep -oE '[0-9]+ (pass|fail)'
```

```output
47 pass
0 fail
```

Plugin integration — everything that touches the Obsidian API — is not unit tested. It is
verified by `bun run deploy` into a real vault.

## Build and release

`build.ts` is a direct `Bun.build` call. Two options in it are not defaults and both matter.

```bash
cat -n build.ts | sed -n '5,23p'
```

```output
     5	async function build() {
     6	  const result = await Bun.build({
     7	    entrypoints: ["src/main.ts"],
     8	    outdir: ".",
     9	    format: "cjs",
    10	    external: ["obsidian", "electron"],
    11	    minify: !isWatch,
    12	    sourcemap: isWatch ? "linked" : "none",
    13	    // Default is `throw: true`, which rejects with an AggregateError and leaves
    14	    // the failure handling below unreachable — and kills the watcher.
    15	    throw: false,
    16	  });
    17	
    18	  if (!result.success) {
    19	    console.error("Build failed");
    20	    for (const message of result.logs) console.error(message);
    21	    if (!isWatch) process.exit(1);
    22	    return;
    23	  }
```

`format: "cjs"` is what Obsidian requires, and `external: ["obsidian", "electron"]` keeps the
host's own modules out of the bundle. `throw: false` is there because Bun's default rejects
with an `AggregateError`, which would make the error handling below it unreachable and — in
watch mode — kill the watcher on the first typo (issue #93).

The built `main.js` is committed to the repository, and CI enforces that it matches a fresh
build.

```bash
sed -n '17,25p' .github/workflows/main.yml
```

```output
      - run: bun install
      - run: bun audit --audit-level=critical
      # `build` is check + bundle. The diff then fails the PR when the committed
      # main.js does not match a fresh build — Obsidian ships the committed
      # bundle, so a dependency bump that skips the rebuild must not merge.
      # bun is deliberately unpinned, so a bun release that shifts bundler
      # output trips this too. The fix is the same either way: rebuild and
      # commit main.js.
      - run: bun run build
```

`git diff --exit-code main.js` is the enforcement. Because Bun is unpinned (`bun-version:
latest`), a Bun release that shifts bundler output fails the same check; the fix is always
the same — rebuild and commit `main.js`.

Releases are tag-driven: pushing an `x.y.z` tag runs `.github/workflows/release.yml`, which
builds and attaches `main.js`, `styles.css`, and `manifest.json` with
`fail_on_unmatched_files: true`. `version-bump.ts` keeps `manifest.json` and `versions.json`
in step with `package.json` and throws rather than silently succeeding if `minAppVersion` is
missing — `JSON.stringify` drops `undefined`, so the `versions.json` entry would otherwise
vanish without a word.

## Where the linear order broke down

Two places, recorded here so the next reader knows it was the code and not the narrative.

**Two owners of the same state.** `Review` owns `reviewedPaths`, `excludedFolders`, and
`reviewStartedAt`; `plugin.data` holds a copy of those *plus* `showStatusBar`, which lives
nowhere else. Explaining `saveSettings` required introducing the copy before the reader had
seen anything that reads it, and explaining the settings tab required going back to it. See
the findings below.

**`schemaVersion` skips its own validator.** `normalizeData` is introduced as the guard on
everything read from `data.json`, and its signature then excludes the one field that gates
whether the plugin will write at all. That had to be flagged twice — once in `data.ts`, again
in `loadSettings` — because neither location explains it alone.

## Findings

Two things this pass turned up are filed in `.issues/`. Both are structural rather than
behavioural, and both are reported here because a reader of this document should not have to
rediscover them.

| #   | Severity | Issue                                                       | Primary location                              |
| --- | -------- | ----------------------------------------------------------- | --------------------------------------------- |
| 1   | medium   | `two-owners-of-the-same-review-state-break-the-linear-read` | `src/plugin.ts:176-187`, `src/settingsTab.ts:43` |
| 2   | low      | `reset-review-confirm-option-is-unreachable`                | `src/plugin.ts:325-333`, `src/settingsTab.ts:52` |

**Total: 2 issues (0 critical, 0 high, 1 medium, 1 low)**

`THEORY.md` carries its own index of five further findings from the same `.issues/`
directory, covering the persistence rails rather than the reading order.

