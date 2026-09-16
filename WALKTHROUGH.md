# Review Plugin Walkthrough

A linear read of every module, in the order the code runs.

## Overview

**Review** is an Obsidian plugin that walks you through your vault one note at a time and
remembers which notes you have already seen. Every markdown file is in exactly one of two
states — reviewed or not reviewed — and the plugin's whole job is to remember that set, hand
you a random note that is not in it, and tell you how far through the vault you are.

It answers two questions and declines the rest. `README.md` refuses ratings, schedules and
second passes explicitly, and that refusal is why this is a 1,400-line codebase.

The toolchain is Bun-only. Bun runs the tests (`bun test`), bundles `src/main.ts` into a
committed `main.js` (`bun build`, invoked from `package.json`), and copies the built plugin
into a vault (`deploy.ts`). Type checking is `tsc --noEmit`; TypeScript linting and
formatting are Biome; markdown is prettier.

Three things enter this code from outside, and the walkthrough follows them in turn:

1. **Obsidian loads the plugin.** It reads `manifest.json`, requires `main.js`, constructs
   `ReviewPlugin` and calls `onload`.
2. **The user acts** — a command, the ribbon icon, the status bar, the settings tab.
3. **The vault or the filesystem changes underneath** — a rename, a delete, or another
   device rewriting `data.json` through sync.

### The one organising decision

**The vault is the source of truth for what exists; the plugin stores only what has been
visited.** No file list is cached — `vault.getMarkdownFiles()` is asked fresh every time.

The bill for that is reconciliation: when a file moves or disappears, the stored paths have
to be rewritten to match, and because excluded folders are also paths, they need the same
treatment. That single decision is why `renamePath` and `removePath` exist, and why they are
the largest functions in the domain module.

The second decision follows from the first. Nothing in a vault records that a note was
visited, so a lost `data.json` is unreconstructible work. **Progress the user can see must be
progress that is on disk** — which is what the store exists to guarantee.

## Architecture

```
src/
  review.ts        the persisted document, its validation, and pure transitions over it
  store.ts         owns the state, the write fence and the write queue
  main.ts          the Obsidian adapter: commands, events, actions
  commands.ts      one table of review actions and their availability rule
  statusBar.ts     status-bar item and its click menu
  settingsTab.ts   settings pane, including the excluded-folder editor
  modals.ts        reset confirmation, and the review menu
  folderSuggest.ts folder autocomplete for the excluded-folder rows
```

Dependencies point one way:

```
review.ts  ←  store.ts  ←  main.ts  ←  commands.ts, statusBar.ts, settingsTab.ts, modals.ts
```

`review.ts` and `store.ts` import nothing from Obsidian. That boundary is what the entire
test suite rests on: the tests run against the real modules with no mock. It is enforced
rather than trusted — a Biome `noRestrictedImports` override on those two files fails
`bun run check` if either ever imports `obsidian`.

Everything below `main.ts` depends on it only for its _type_, which is why the UI modules
take a `ReviewPlugin` in their constructors. The one domain concept that has to cross the
boundary is the file-versus-folder distinction, and it crosses as a `boolean`.

### Data flow

```
data.json ──load──► normalizeState ──► PluginState ──► queries ──► UI
                                            │
                        user action ──► transition (pure)
                                            │
                                      Store.commit
                                            │
                              serialize ──► saveData ──► data.json
                                            │
                                    then, and only then,
                                    state is replaced and
                                    the UI repaints
```

## The persisted document

`src/review.ts` holds two shapes for the same information. One is what JSON can carry; the
other is what the code wants to work with.

`src/review.ts` — `PluginData` and `PluginState`

```ts
/** The shape written to `data.json`. Arrays, because JSON has no Set. */
export type PluginData = {
  schemaVersion: number;
  reviewedPaths: string[];
  reviewStartedAt?: string;
  excludedFolders: string[];
  showStatusBar: boolean;
};

export type PluginState = {
  readonly schemaVersion: number;
  readonly reviewedPaths: ReadonlySet<string>;
  readonly reviewStartedAt?: string;
  readonly excludedFolders: readonly string[];
  readonly showStatusBar: boolean;
};
```

Five fields, and the split between them is not arbitrary. `reviewedPaths` is membership-tested
on every eligibility check, so in memory it is a `Set`; on disk it has to be an array. Every
field is `readonly`, because the document is replaced rather than modified — the property the
whole save path depends on.

### Validation, and why it coerces instead of throwing

`data.json` is the least trustworthy thing the plugin reads. A hand-edit, a sync conflict, or
a schema written by a future version can put any shape in it.

`src/review.ts` — `normalizeState`

```ts
export function normalizeState(raw: unknown): PluginState {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const startedAt = data.reviewStartedAt;

  return {
    schemaVersion: toSchemaVersion(data.schemaVersion),
    reviewedPaths: new Set(stringArray(data.reviewedPaths)),
    reviewStartedAt:
      typeof startedAt === "string" && !Number.isNaN(Date.parse(startedAt))
        ? startedAt
        : undefined,
    excludedFolders: normalizeFolders(stringArray(data.excludedFolders)),
    showStatusBar:
      typeof data.showStatusBar === "boolean" ? data.showStatusBar : true,
  };
}
```

**It coerces rather than throws, and that is a UX requirement rather than defensiveness.** A
`data.json` that throws blanks the settings tab — which is the only place the user can repair
the value that broke it. So the tab still renders whatever is in the file — every field but
one degrading to its default, and the exception below is where coercing and defaulting come
apart.

Two of the five coercions have a specific failure behind them, recorded in the tests:

- `new Set("abc")` yields `{"a","b","c"}` — a string `reviewedPaths` would silently mark three
  one-character paths as reviewed. `stringArray` returns `[]` for anything that is not an
  array.
- `isEligible` calls `excludedFolders.some()`, which sits under the settings tab's statistics.
  A non-array there used to leave the tab blank.

`schemaVersion` is the field the whole read-only fence turns on, which makes it the one field
that must _not_ simply degrade to its default. `CURRENT_SCHEMA_VERSION` reads as "not newer
than me", so falling back to it disengages the fence on precisely the file the fence exists to
protect. It gets parsed instead:

`src/review.ts` — `toSchemaVersion`

```ts
function toSchemaVersion(value: unknown): number {
  const version =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(version) ? version : CURRENT_SCHEMA_VERSION;
}
```

A version written as a string — a hand-edit, a sync tool that stringified it — is still a
version, so it is read as the number it means and stored back as one. Only something with no
readable version in it falls back, and that is safe in a way that falling back on `"3"` is
not: an absent version is a fresh install or a pre-v2 file, and `{}`, `true` or `"v9"` is not
a claim to be from the future.

`serialize` is the inverse, and `EMPTY_STATE` is `normalizeState(undefined)` — a fresh install
and the fallback for an unreadable file are the same value.

### The only way to write an excluded folder

`src/review.ts` — `normalizeFolders`

```ts
function normalizeFolders(list: readonly string[]): string[] {
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
```

Trim, strip trailing slashes, drop empties, dedupe. The reason it must be the only door is
that the failure is silent: `isEligible` tests for a `${folder}/` prefix, so a stored
`"Templates/"` produces `"Templates//"` and matches nothing. The user sees the folder listed
as excluded and its notes keep appearing in review.

**Three writers go through it** — `setExcludedFolders` (the UI), `normalizeState` (the disk),
and `renamePath` (vault reconciliation, which maps entries independently and can collide two
onto one). The docstring lives on the function rather than on any one caller, because the
function is what the claim is about.

## Queries

Three, all pure functions of the state.

`src/review.ts` — `isEligible`, `isReviewed`, `stats`

```ts
export function isEligible(state: PluginState, path: string): boolean {
  return !state.excludedFolders.some((folder) => path.startsWith(`${folder}/`));
}

export function isReviewed(state: PluginState, path: string): boolean {
  return state.reviewedPaths.has(path);
}
```

The `${folder}/` in `isEligible` is the whole of the prefix-boundary rule, and it is tested
from both sides: `templates` excludes `templates/sub/note.md` and must _not_ exclude
`templates-extra/note.md`.

## Transitions

Every change to the document is a pure function from one state to the next. The signature is
uniform — state in, state out — and the header comment states the contract that makes the
rest of the system work:

`src/review.ts` — the transitions section

```ts
// --- transitions -----------------------------------------------------------
// Each returns the next state, or `state` itself when nothing changed.
```

### Reference equality is the "nothing happened" signal

This is the least obvious idea in the codebase and everything downstream leans on it. A
transition that changes nothing returns **the same object**, not an equal one. Callers test
with `===`.

`src/review.ts` — `markUnreviewed`

```ts
export function markUnreviewed(state: PluginState, path: string): PluginState {
  if (!state.reviewedPaths.has(path)) return state;

  const reviewedPaths = new Set(state.reviewedPaths);
  reviewedPaths.delete(path);
  return { ...state, reviewedPaths };
}
```

Transcript of a script run against the real module while writing this document — not a live
block, and nothing re-runs it:

```text
markReviewed(s1, "a.md")  already reviewed   SAME ref  (no write)
markReviewed(s1, "b.md")  new path           new ref   (writes)
markUnreviewed(s1, "zz.md")  not reviewed    SAME ref  (no write)
setExcludedFolders(s1, ["Templates/"])       SAME ref  (no write)
setExcludedFolders(s1, [" Templates ", ""])  SAME ref  (no write)
renamePath(s1, "Other", "X", true)  no match SAME ref  (no write)
renamePath(s1, "Templates", "Meta", true)    new ref   (writes)
removePath(s1, "Other", true)  no match      SAME ref  (no write)
reset(EMPTY_STATE)  nothing to clear         SAME ref  (no write)
reset(s1)  has progress                      new ref   (writes)
```

Rows four and five are the interesting ones. `setExcludedFolders(s1, ["Templates/"])` returns
the same reference because the input _normalizes to_ what is already stored — the comparison
happens after normalization, not before. That is what stops a keystroke that changes nothing
meaningful from queueing a write of the entire reviewed-path set.

### The review clock

`src/review.ts` — `markReviewed`

```ts
export function markReviewed(
  state: PluginState,
  path: string,
  now: () => string = () => new Date().toISOString(),
): PluginState {
  if (state.reviewedPaths.has(path) && state.reviewStartedAt) return state;

  return {
    ...state,
    reviewedPaths: new Set(state.reviewedPaths).add(path),
    reviewStartedAt: state.reviewStartedAt ?? now(),
  };
}
```

`reviewStartedAt` is set on the first mark and never again — `??` keeps an existing value. The
clock survives an unmark, which is what the settings tab's "Review started on …" line reports.

`now` is injected so the tests can pass a sentinel. It is the only injection seam left in the
domain module, and it earns its place because the alternative is asserting on a real clock.

Note the guard needs both conditions. A path can already be in the set while `reviewStartedAt`
is still undefined — that is what a `data.json` carrying paths but no timestamp looks like —
and in that case the transition must still run to set the clock.

### Reconciling with the vault

This is where the organising decision comes due. When the vault moves a folder, every stored
path under it is now wrong, and so is any excluded folder under it.

`src/review.ts` — `renamePath`, the folder branch

```ts
  const oldPrefix = `${oldPath}/`;
  const newPrefix = `${newPath}/`;
  let changed = false;

  const reviewedPaths = new Set<string>();
  for (const p of state.reviewedPaths) {
    if (p.startsWith(oldPrefix)) {
      reviewedPaths.add(newPrefix + p.slice(oldPrefix.length));
      changed = true;
    } else {
      reviewedPaths.add(p);
    }
  }

  // The excluded folder itself, and any excluded folder beneath it.
  const excludedFolders = normalizeFolders(
    state.excludedFolders.map((folder) => {
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

  return changed ? { ...state, reviewedPaths, excludedFolders } : state;
```

Three cases, and the middle one is the one that was missed once and had to be fixed: the
renamed folder may _be_ an excluded folder (`folder === oldPath`), or may _contain_ one
(`folder.startsWith(oldPrefix)`). Excluding `Templates` and then moving it to
`Meta/Templates` used to silently un-exclude everything in it while the settings tab went on
listing the old path.

The `normalizeFolders` wrapper around the `.map` is the dedupe: because entries are mapped
independently, renaming `B` onto an existing `A` produces `["A", "A"]` without it.

`removePath` has the same shape and does the opposite — it drops matching reviewed paths and
filters out the excluded folder and its descendants. The two are deliberately _not_ collapsed
into one parameterised function; they share a shape and do opposite things, and merging them
would mean a flag parameter.

## The store

`src/store.ts` owns the document, the write fence and the write queue. It is Obsidian-free,
which is the point.

The document itself is private, and readable through a getter:

```ts
  private current: PluginState = EMPTY_STATE;

  get state(): PluginState {
    return this.current;
  }
```

Two lines that are easy to read past, and they are what makes "every change goes through
`commit`" a rule rather than a habit. `current` is assigned in exactly two places — the load
path below, and the last line of `commit`. Nothing outside the class can reach either. When
the field was public the value's own immutability was still enforced (`ReadonlySet`, `readonly`
fields — all three mutations are compile errors), so the type system looked like it was
guarding this state while the one move that mattered, replacing the field wholesale, compiled
in silence and skipped the fence, the queue and the write.

### Injected dependencies

`src/store.ts` — `StoreDeps`

```ts
export type StoreDeps = {
  load: () => Promise<unknown>;
  save: (data: PluginData) => Promise<void>;
  notify: (message: string) => void;
  log: (message: string, err?: unknown) => void;
  warn: (message: string) => void;
  /** Called whenever `state` is replaced, so the UI can repaint. */
  onChange?: () => void;
};
```

`loadData` and `saveData` are two functions. Taken as functions rather than inherited from a
`Plugin` subclass, the entire save path becomes ordinary testable code — a test binds `save`
to something that throws and can then assert what happens to a user whose disk is full, which
is precisely the user the fence exists for and the one no test could previously represent.

`onChange` is a state-change notification, not a UI hook. The store never knows what repaints.

### Loading, and the write fence

`src/store.ts` — `readFromDisk`

```ts
    const normalized = normalizeState(raw);
    const savedVersion = normalized.schemaVersion;
    const isNewer = savedVersion > CURRENT_SCHEMA_VERSION;
    ...
    // Keep a newer version's number, so the file is not truncated to v2
    // if something later lifts the write block.
    this.current = {
      ...normalized,
      schemaVersion: isNewer ? savedVersion : CURRENT_SCHEMA_VERSION,
    };

    // Assigned on every path, back to null included, so a reload after a
    // transient read failure lifts the block.
    if (loadFailed) {
      this.blocked = "saved data could not be read";
    } else if (isNewer) {
      this.blocked = "saved data is from a newer plugin version";
    } else {
      this.blocked = null;
    }
```

Two independent reasons to refuse writes, and they protect different things.

**A read that failed** must not be overwritten by the defaults it fell back to. If `loadData`
throws, the state is `EMPTY_STATE` — and saving that would destroy a review the plugin simply
could not read this time.

**Data from a newer schema** must not be truncated to what this version understands. A future
version writing `schemaVersion: 3` with fields this build does not know about would lose them
on the next save.

Three details are easy to break and each has a reason:

- `loadFailed` is a separate flag from `raw === null`, because `null` is also what a fresh
  install looks like.
- The newer version's _number_ is preserved rather than stamped down to 2.
- `blocked` is assigned on **every** path, `null` included, so reloading after a transient
  read failure lifts the fence rather than latching it forever.

### One queue for everything

`src/store.ts` — `enqueue` and `reload`

```ts
  private enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = this.pending.then(fn);
    this.pending = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  reload = (): Promise<void> => this.enqueue(this.readFromDisk);
```

Six lines, and three properties fall out of them.

**Order.** Work runs in call order, because each new task chains onto the tail.

**A failure cannot stop a successor.** The tail is `run.then(noop, noop)`, so `pending` never
rejects — which is also why one arm suffices where a two-armed `.then(f, f)` might look
necessary.

**Reloads are ordered against writes.** `reload` joins the same queue as `commit`. Without
that, a save requested before a sync-triggered reload could land _after_ it and overwrite the
state just adopted from disk.

### Commit, which is the whole design in one function

`src/store.ts` — `commit`

```ts
  commit = (apply: (state: PluginState) => PluginState): Promise<boolean> =>
    this.enqueue(async () => {
      const next = apply(this.current);
      if (next === this.current) return true;

      if (this.blocked) {
        this.deps.notify(
          `Review: ${this.blocked}. Changes will not be saved until you reload.`,
        );
        return false;
      }

      const payload = serialize(next);
      try {
        await this.deps.save(payload);
      } catch (err) {
        this.deps.log(
          `saveData failed (${payload.reviewedPaths.length} reviewed paths, ${payload.excludedFolders.length} excluded folders)`,
          err,
        );
        this.deps.notify(
          "Review: could not save your review — see console for details.",
        );
        return false;
      }

      this.current = next;
      this.deps.onChange?.();
      return true;
    });
```

Read it in order, because each line is load-bearing:

1. **The transition runs inside the queue.** So it computes from whatever the previous commit
   actually persisted. Two overlapping commits compose instead of racing.
2. **`next === this.current` short-circuits, before the fence is consulted.** The
   reference-equality signal, cashed in: a transition that changed nothing writes nothing and
   still reports success — fenced or not. The ordering matters because reconciliation commits
   on _every_ vault rename and delete, and almost none of them touch the review. Checking
   `blocked` first made a fenced session pop a Notice for each attachment Obsidian Sync
   happened to move.
3. **The fence is checked inside the critical section.** Not before entering it — a refusal
   arriving while the call was waiting its turn would otherwise slip past a check that had
   already passed. Running `apply` ahead of it does not reopen that hole: `apply` is pure and
   synchronous, so no `await` sits between the check and the write.
4. **The write happens before the state moves.**
5. **State is replaced only after the write resolves** — so a failure needs no undo. There is
   no rollback here because nothing was applied speculatively.
6. **`onChange` fires last**, so the UI repaints against what is on disk.

`commit` returns `false` for both a refusal and an I/O failure rather than rejecting. The
caller's question is "is this on disk?", and both answers are no. A transition that _throws_
is a programming error and propagates — `apply` sits outside the `try`, deliberately.

The visible consequence: the status bar repaints _after_ `saveData` resolves rather than
optimistically, so on a slow or synced disk there is a click-to-repaint delay of one write.
That is the honest reading of "the UI must not show progress that is not on disk".

## The plugin

`src/main.ts` is the Obsidian adapter. It is named for the bundle Obsidian loads, so there is
no re-export shim.

### Binding the store to Obsidian

`src/main.ts` — `ReviewPlugin.store` and `state`

```ts
  readonly store = new Store({
    load: () => this.loadData(),
    save: (data) => this.saveData(data),
    notify: (message) => new Notice(message),
    log: (message, err) => console.error(`[review] ${message}`, err),
    warn: (message) => console.warn(`[review] ${message}`),
    onChange: () => this.statusBar?.update(),
  });

  /** The persisted document. Read-only here; the store owns replacement. */
  get state(): PluginState {
    return this.store.state;
  }
```

Six one-line adapters. The `?.` on `statusBar` matters: `onChange` can fire during `onload`,
before the status bar has been constructed.

`state` is a getter with no setter, so no UI module can assign to it even by accident.

### The async bridge

`src/main.ts` — `runAsync`

```ts
  runAsync = (promise: Promise<unknown>, label: string) => {
    promise.catch((err) => {
      console.error(`[review] ${label} failed`, err);
      new Notice(`Review: ${label} failed — see console for details.`);
    });
  };
```

Obsidian's callbacks are synchronous and cannot await. Without this, a rejected promise from a
command handler vanishes with no console line and no user-visible sign. Every fire-and-forget
call site goes through it and passes a label that names the action in plain words.

### Registration

`src/main.ts` — `onload`

```ts
  onload = async () => {
    await this.loadSettings();

    this.addRibbonIcon("scan-eye", "Open review", () => {
      this.openReviewMenu();
    });

    this.statusBar = new StatusBar(this.addStatusBarItem(), this);

    for (const command of COMMANDS) {
      this.addCommand({
        id: command.id,
        name: command.name,
        ...(command.availableWhen
          ? {
              checkCallback: (checking: boolean) => {
                if (this.getActiveFileStatus() !== command.availableWhen)
                  return false;
                if (!checking) this.runAsync(command.run(this), command.label);
                return true;
              },
            }
          : {
              callback: () => this.runAsync(command.run(this), command.label),
            }),
      });
    }
```

The load comes first, so nothing renders against `EMPTY_STATE`.

The registration loop is the interesting part. Obsidian has two different command shapes —
`callback` for always-available, `checkCallback` for conditional — and the spread picks one
based on whether the table entry carries an `availableWhen`. `checkCallback` is called twice
per invocation: once with `checking: true` to ask whether to show the command at all, then
again with `false` to run it.

`open-review-menu` is registered separately, outside the loop. It is the one command that
opens UI rather than changing review state, so it has no `run(plugin)` and no availability
rule.

### Reading the current state

`src/main.ts` — `getActiveFileStatus`

```ts
  getActiveFileStatus = (): "reviewed" | "not_reviewed" | undefined => {
    const file = this.getActiveMarkdownFile();
    if (!file || !isEligible(this.state, file.path)) return undefined;
    return isReviewed(this.state, file.path) ? "reviewed" : "not_reviewed";
  };
```

Three states, not two, and `undefined` is doing real work: it means "there is nothing here to
review" — no active file, not markdown, or excluded. Every surface branches on this same
value, which is why the status bar, the command palette and the review menu agree without
coordinating.

### Actions

`src/main.ts` — `markReviewed`

```ts
  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    const saved = await this.commit((s) => markReviewed(s, file.path));
    if (saved && openNext) await this.openRandomFile();
  };
```

This is the one place the boolean from `commit` is consumed, and it is the reason the boolean
exists: **do not navigate away from a file whose mark was not persisted.** Because `commit`
returns `false` for both a refusal and a failed write, `saved` has exactly one meaning here.

`src/main.ts` — `openRandomFile`

```ts
    const eligible = this.getEligibleFiles();
    if (!eligible.length) {
      new Notice(
        "No files are eligible for review — check your excluded folders.",
      );
      return;
    }

    const unreviewed = eligible.filter((f) => !isReviewed(this.state, f.path));
    if (!unreviewed.length) {
      new Notice("All files are reviewed");
      return;
    }

    const active = this.getActiveMarkdownFile();
    const others = unreviewed.filter((f) => f.path !== active?.path);
    const candidates = others.length ? others : unreviewed;

    // Both early returns above have already established a non-empty list.
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    await this.app.workspace.getLeaf(false).openFile(next);
```

Two failure modes are distinguished rather than collapsed, and the source says why:
congratulating someone on a review they never started points them away from the settings tab,
which is where the actual fault is.

The active-file filter with its fallback is the subtle part. Opening the file already in the
leaf is a no-op the user reads as a broken command — with three notes left it happens a third
of the time. But filtering unconditionally would make the _last_ unreviewed file unopenable,
which is worse. Hence `others.length ? others : unreviewed`.

### Vault reconciliation

`src/main.ts` — `reconcile`, `handleFileRename` and `handleFileDelete`

```ts
  private reconcile = async (apply: (state: PluginState) => PluginState) => {
    const before = this.state;
    await this.commit(apply);
    if (this.state !== before) this.settingsTab?.invalidate();
  };

  private handleFileRename = (file: TAbstractFile, oldPath: string) =>
    this.reconcile((s) =>
      renamePath(s, oldPath, file.path, file instanceof TFolder),
    );

  private handleFileDelete = (file: TAbstractFile) =>
    this.reconcile((s) => removePath(s, file.path, file instanceof TFolder));
```

`instanceof TFolder` is the only Obsidian type test in the reconciliation path, and it stays
here so the domain module needs no Obsidian import. It crosses as the `isFolder` boolean.

These go through `commit` like every other writer rather than getting an exemption. A
reconciliation that cannot be persisted must not be applied in memory either, or a blocked
session shows exclusions the next reload will contradict. There is no `if (changed)` guard on
the commit itself, because `commit` already writes nothing when the transition returns the
same reference.

Telling the settings tab is the one thing that _does_ need a guard, and `commit` cannot supply
it: it reports `true` for both "written" and "nothing to write". The state can, because it is
replaced only when something changed — hence the reference comparison across the call. Without
it, `invalidate()` fired on every vault event, and since it cancels the pending debounce and
drops `drafts`, any attachment Obsidian Sync moved would wipe a half-typed excluded-folder row
out from under the user. The comparison also skips the repaint after a refusal or a failed
write, which is the same answer for the same reason.

## The command table

`src/commands.ts` is one array read by three surfaces.

`src/commands.ts` — `ReviewCommand` and `COMMANDS`

```ts
export type ReviewCommand = {
  id: string;
  name: string;
  /** Undefined means "always available". */
  availableWhen?: "reviewed" | "not_reviewed";
  label: string;
  run: (plugin: ReviewPlugin) => Promise<unknown>;
};
```

`availableWhen` is the rule, `run` is the action, `label` is the `runAsync` tag. Before this
table those three lived in three files, each with its own copy of the same strings.

`src/commands.ts` — `availableCommands`

```ts
export function availableCommands(
  status: "reviewed" | "not_reviewed" | undefined,
): ReviewCommand[] {
  return COMMANDS.filter(
    (command) => !command.availableWhen || command.availableWhen === status,
  );
}
```

The array's **order** is the review menu's one piece of judgement, and it is why this returns
a list rather than a set: when a file is unreviewed, "mark and open next" comes first, because
that is the loop the plugin exists to accelerate.

## The UI

### Status bar

`src/statusBar.ts` — `update`

```ts
  update = () => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) {
      this.setIsVisible(false);
      return;
    }

    this.setIsVisible(this.plugin.state.showStatusBar);

    this.element.setText(status === "reviewed" ? "Reviewed" : "Not reviewed");
  };
```

Two independent reasons to hide: nothing reviewable is open, or the user turned the item off.
The first wins regardless of the preference.

`src/statusBar.ts` — `setIsVisible`

```ts
  // Obsidian's own `is-hidden` rules are scoped to ribbon and stacked-tab
  // elements, so the class styles nothing on a status-bar item. `toggle` sets
  // inline display, which needs no stylesheet to agree with it.
  private setIsVisible = (isVisible: boolean) => {
    this.element.toggle(isVisible);
  };
```

This looks like a deviation from Obsidian convention and is in fact a fix for one. The
comment is the only thing standing between this line and a well-meaning "simplification" back
to `is-hidden`, which does nothing here.

The click menu reads two entries out of the command table by id. It cannot simply render
everything carrying an `availableWhen` — three commands do, and "mark and open next"
_navigates_, which is not what a checkbox in a status-bar menu means.

### Modals

`src/modals.ts` — `ConfirmResetModal`

```ts
  // The one settlement site. close() always runs onClose, whether it came from
  // a button, Escape, or a click outside, so every dismissal lands here.
  onClose(): void {
    super.onClose();
    this.resolve(this.confirmed);
  }
```

Cancel just calls `close()`; Reset sets `confirmed = true` and then calls `close()`. Because
`close()` always runs `onClose`, every dismissal — including Escape and clicking outside —
resolves the promise exactly once, with no bookkeeping flag. The `super.onClose()` call is
an override rather than an instance-property assignment, which matters: assigning to
`modal.onClose` shadows the base implementation instead of extending it.

`ReviewMenuModal` is a `SuggestModal` driven entirely by the table:

`src/modals.ts` — `getSuggestions` and `onChooseSuggestion`

```ts
  getSuggestions = (query: string): ReviewCommand[] => {
    return availableCommands(this.plugin.getActiveFileStatus()).filter((c) =>
      c.name.toLowerCase().includes(query.toLowerCase()),
    );
  };

  onChooseSuggestion = (command: ReviewCommand) => {
    this.plugin.runAsync(command.run(this.plugin), command.label);
  };
```

There is no `switch` and no per-command dispatch. The modal filters and renders; the table
supplies the behaviour.

### Settings tab

The settings tab holds the one piece of mutable UI state in the plugin, and it needs to.

`src/settingsTab.ts` — `drafts` and `seeded`

```ts
  /**
   * Excluded-folder rows as typed, before normalization — null while the tab
   * is closed. Rows live here rather than in the plugin so a half-typed or
   * momentarily-empty one survives on screen: setExcludedFolders drops empties
   * and dedupes, which would otherwise delete a row out from under the user
   * mid-word.
   */
  private drafts: string[] | null = null;

  /**
   * What `drafts` was seeded from. `hide()` compares against it so an untouched
   * tab commits nothing — otherwise closing the tab writes back a snapshot that
   * may be older than what the vault has since reconciled.
   */
  private seeded: string[] = [];
```

`drafts` is **not** a duplicate of the stored state — it is unnormalized text mid-edit. If the
visible rows _were_ the stored list, clearing a row to retype it would delete the row, and
typing the second character of a duplicate would collapse two rows into one.

`seeded` exists because the buffer has a lifetime problem. Three things change the excluded
folders from outside the tab — a vault rename, a vault delete, an external reload — and the
tab was holding a pre-change snapshot it would write back on close.

`src/settingsTab.ts` — `invalidate` and `hide`

```ts
  invalidate(): void {
    this.debouncedCommit.cancel();
    this.drafts = null;
    if (this.containerEl.isShown()) this.display();
  }

  hide(): void {
    this.debouncedCommit.cancel();

    if (this.drafts && this.drafts.join("\n") !== this.seeded.join("\n")) {
      this.commit();
    }
    this.drafts = null;
  }
```

Three mechanisms, each closing a different hole:

- **`cancel()` in `hide()`.** The 500 ms debouncer would otherwise fire after `drafts = null`.
- **The divergence check.** An untouched tab commits nothing, so it cannot revert a
  reconciliation that happened while it was open.
- **`invalidate()`.** Called from `onExternalSettingsChange`, and from `reconcile` when a
  vault rename or delete actually moved the stored state — the places that change the folders
  from outside. The "actually" is load-bearing: an unconditional call here throws away a
  half-typed row for a vault event that had nothing to do with the review.

The re-seed trigger is deliberately _"state changed and the tab did not cause it"_, never
_"`display()` ran"_. The tab calls `display()` itself after adding a row and after the trash
button; re-seeding there would make a just-added empty row vanish and a just-deleted one
reappear before its commit lands.

`src/settingsTab.ts` — the row's `onChange`

```ts
          // Only the draft changes per keystroke; normalization runs once the
          // debounce fires, so typing a second "Templates" cannot collapse two
          // visible rows into one entry mid-word.
          text.onChange((value) => {
            drafts[i] = value;
            this.debouncedCommit();
          });
```

### Folder autocomplete

`src/folderSuggest.ts` is fourteen lines and subclasses Obsidian's `AbstractInputSuggest`,
which supplies the dropdown, the keyboard handling and the `onSelect` callback. Only the
search and the rendering are the plugin's.

## Tests

Two files, 70 tests, no Obsidian mock.

`src/review.test.ts` covers the domain module directly. Its helper is worth reading, because
it explains a real trap:

`src/review.test.ts` — `stateWith`

```ts
function stateWith(
  paths: string[],
  excludedFolders: string[] = [],
  startedAt?: string,
): PluginState {
  // Built directly rather than through normalizeState, so the tests can use
  // sentinel clock values ("loaded", "first") that are not parseable dates.
  return {
    ...normalizeState({ excludedFolders }),
    reviewedPaths: new Set(paths),
    reviewStartedAt: startedAt,
  };
}
```

`normalizeState` validates `reviewStartedAt` as a parseable date, so routing fixtures through
it would silently drop the sentinels the clock tests depend on.

`src/store.test.ts` is the half that could not exist before the store was extracted. Its
harness binds `load` and `save` to functions the test controls, including ones that throw and
ones that block until released:

`src/store.test.ts` — the manual-write harness

```ts
    settle: async (ok) => {
      // The queue dispatches on a microtask, so the write may not have reached
      // `save` yet when the test asks to settle it.
      while (!releases.length) await Promise.resolve();
      releases.shift()?.(ok);
    },
```

The tests that matter are the ones about the user whose disk is full: a `save` that throws
leaves the state unchanged and reports `false`; a `load` that throws sets the fence and
refuses the next commit; a second reload lifts a transient fence; overlapping commits compose;
a failed write does not stop its successor; and a reload queued behind a write lands after it.

Nothing tests `main.ts` or the UI modules — they import Obsidian, and the project keeps no
mock by choice. Those paths are verified by deploying into a vault.

## Build and release

`package.json` — scripts

```jsonc
"dev": "bun build src/main.ts --outdir . --format cjs --external obsidian --external electron --sourcemap=linked --watch",
"build": "bun run check && bun build src/main.ts --outdir . --format cjs --external obsidian --external electron --minify",
"check": "bun run typecheck && biome check . && prettier --check \"**/*.md\"",
```

`obsidian` and `electron` are external because Obsidian provides them at runtime. `check` is
non-mutating on purpose — `build` runs it and so does the release workflow; `lint:fix` is the
writing counterpart.

**`main.js` is committed**, and CI enforces that it matches a fresh build. The repository is
cloned directly into a vault, which is the workflow the committed bundle serves. Any source
change, dependency bump, or Bun release that shifts bundler output must be followed by a
rebuild and a commit of `main.js`.

`version-bump.ts` syncs `manifest.json` and `versions.json` from `package.json`, and refuses
to run without a `minAppVersion` — because `JSON.stringify` drops `undefined`, the
`versions.json` entry would otherwise vanish while the script reported success.

Releases are cut by pushing a bare `x.y.z` tag, which runs `.github/workflows/release.yml`.
That workflow asserts the tag equals `manifest.json`'s version before building — Obsidian
keys installs off the manifest, so a mismatch would install as the manifest's version and no
longer match the release it came from.

## Where the linear order broke down

Two places, both worth naming.

**`onChange` and the status bar form a loop that the reading order cannot follow.** The store
is introduced as Obsidian-free and self-contained, and it is — but `main.ts` hands it a
callback that repaints the status bar, and the status bar reads `plugin.state`, which is the
store's field. Explaining the store fully requires deferring `onChange` to the plugin section;
explaining the plugin requires having already read the store. The cycle is small and the
`onChange?: () => void` type keeps it honest, but there is no order that avoids the
forward reference.

**The settings tab's `drafts` cannot be explained where it is declared.** The field makes no
sense until you know three separate things: that `setExcludedFolders` normalizes, that a
debouncer sits between a keystroke and a commit, and that the vault can change the folders
while the tab is open. Those are declared in three different files, and the buffer's whole
justification lives in the gaps between them.

## Findings

Three, filed this pass — tracked as [#163](https://github.com/philoserf/obsidian-review/issues/163), [#164](https://github.com/philoserf/obsidian-review/issues/164) and [#165](https://github.com/philoserf/obsidian-review/issues/165).

The prose of the previous `WALKTHROUGH.md` was stale in most of its sections — it documented
`src/data.ts`, `src/plugin.ts`, `build.ts`, the `Review` class and `mutate`, none of which
exist. That is not filed as a finding because this pass replaced the document, which is the
fix.

## Index

| #                                                              | Severity | Issue                                                         | Primary location                   |
| -------------------------------------------------------------- | -------- | ------------------------------------------------------------- | ---------------------------------- |
| [163](https://github.com/philoserf/obsidian-review/issues/163) | low      | `commit` docstring describes a rollback that no longer exists | `src/main.ts` — `commit`           |
| [164](https://github.com/philoserf/obsidian-review/issues/164) | low      | Comment cites a `Review` class that no longer exists          | `src/main.ts` — `handleFileRename` |
| [165](https://github.com/philoserf/obsidian-review/issues/165) | low      | `Store.isBlocked` has no production caller                    | `src/store.ts` — `isBlocked`       |

**Total: 3 issues (0 critical, 0 high, 0 medium, 3 low)**
