# Review Plugin Walkthrough

A linear read of every module, in the order the code runs.

## Overview

**Review** is an Obsidian plugin that walks you through your vault one note at a time and
remembers which notes you have already seen. Every markdown file is in exactly one of two
states — reviewed or not reviewed — and the plugin's whole job is to remember that set, hand
you a random note that is not in it, and tell you how far through the vault you are.

It answers two questions and declines the rest. `README.md` refuses ratings, schedules and
second passes explicitly, and that refusal is why this is a 1,200-line codebase before its
tests.

The toolchain is Bun-only. Bun runs the tests (`bun test`), bundles `src/main.ts` into a
committed `main.js` (`bun build`, invoked from `package.json`), and copies the built plugin
into a vault (`deploy.ts`). Type checking is `tsc --noEmit`; TypeScript linting and
formatting are Biome; markdown is prettier.

Three things enter this code from outside, and the walkthrough follows them in turn:

1. **Obsidian loads the plugin.** It reads `manifest.json`, requires `main.js`, constructs
   `ReviewPlugin` and calls `onload`. The manifest's `minAppVersion` is 1.13.0, because the
   settings tab is built on that release's declarative settings.
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
  review.ts              the persisted document, its validation, and pure transitions over it
  store.ts               owns the state, the write fence and the write queue
  main.ts                the Obsidian adapter: commands, events, actions
  commands.ts            one table of review actions and their availability rule
  statusBar.ts           status-bar item and its click menu
  settingsDefinitions.ts the settings tab as data, and the excluded-folder row rule
  settingsTab.ts         binds those definitions to the store
  modals.ts              reset confirmation, the review menu, and the folder picker
```

Dependencies point one way:

```
review.ts  ←  store.ts  ←  main.ts  ←  commands.ts, statusBar.ts, settingsTab.ts, modals.ts
review.ts  ←  settingsDefinitions.ts  ←  settingsTab.ts
```

`review.ts` and `store.ts` import nothing from Obsidian. That boundary is what the entire
test suite rests on: the tests run against the real modules with no mock. It is enforced
rather than trusted — a Biome `noRestrictedImports` override on those two files fails
`bun run check` if either ever imports `obsidian`. `settingsDefinitions.ts` sits on the same
side in practice: it imports only _types_ from Obsidian, which erase at compile time, so its
tests need no mock either.

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
  // `| undefined` on purpose: no review in progress is written as
  // `reviewStartedAt: undefined`, which JSON.stringify drops, so absent and
  // undefined are one state on disk and in memory.
  reviewStartedAt?: string | undefined;
  excludedFolders: string[];
  showStatusBar: boolean;
};
...
type ReviewState = {
  readonly reviewedPaths: ReadonlySet<string>;
  // Absent and undefined are one state; see PluginData.
  readonly reviewStartedAt?: string | undefined;
  readonly excludedFolders: readonly string[];
};
...
export type PluginState = ReviewState & {
  readonly schemaVersion: number;
  readonly showStatusBar: boolean;
};
```

The `?: string | undefined` reads as redundant and is not. The project compiles with
`exactOptionalPropertyTypes`, under which `?:` alone means "may be absent" but _not_ "may be
present and undefined" — and `reset`, `normalizeState` and `serialize` all write the key as
`undefined` to mean "no review in progress". The type now says what the code already did.

Five fields, and neither split between them is arbitrary. `reviewedPaths` is membership-tested
on every eligibility check, so in memory it is a `Set`; on disk it has to be an array. Every
field is `readonly`, because the document is replaced rather than modified — the property the
whole save path depends on.

The second split is the intersection. Three of the five fields are the review; one is a UI
preference and one is a file-format detail, and they are here because they share the file, not
because they are the same kind of thing. Keeping `ReviewState` nameable is what tells the next
maintainer which side a sixth field belongs on, and it is what `reset` is written against — it
clears the progress and leaves both the scope and the preference alone. The intersection is
still a flat object, so `data.json` is unchanged by it.

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

`src/review.ts` — `normalizeFolder` and `normalizeFolders`

```ts
export function normalizeFolder(entry: string): string {
  return entry.trim().replace(/\/+$/, "");
}

function normalizeFolders(list: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const folder = normalizeFolder(entry);
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
onto one).

The per-entry rule is split out as `normalizeFolder` and exported for one reader: the settings
tab's row validator, which has to compare a typed value the way the store will. It is the same
function rather than a copy, so the two cannot drift on what counts as the same folder.

The "only way in" docstring that states the three-writers rule was meant to sit on
`normalizeFolders`. Since the split it sits directly above `normalizeFolder`'s own one-line
comment, so both blocks attach to the per-entry helper, and an editor hovering
`normalizeFolders` shows nothing (see Findings).

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
      this.fence =
        "Saved data could not be read. Changes will not be saved until Obsidian reloads it — your saved review will not be overwritten.";
    } else if (isNewer) {
      this.fence =
        "Saved data is from a newer plugin version. Changes will not be saved until the plugin is updated.";
    } else {
      this.fence = null;
    }
```

Two independent reasons to refuse writes, and they protect different things.

**A read that failed** must not be overwritten by the defaults it fell back to. If `load`
throws, the state is `EMPTY_STATE` — and saving that would destroy a review the plugin simply
could not read this time. Which `load` the plugin passes in is therefore load-bearing; see
"Binding the store to Obsidian" below, where it does not use `loadData`.

**Data from a newer schema** must not be truncated to what this version understands. A future
version writing `schemaVersion: 3` with fields this build does not know about would lose them
on the next save.

Three details are easy to break and each has a reason:

- `loadFailed` is a separate flag from `raw === null`, because `null` is also what a fresh
  install looks like.
- The newer version's _number_ is preserved rather than stamped down to 2.
- `fence` is assigned on **every** path, `null` included, so reloading after a transient
  read failure lifts the fence rather than latching it forever.
- The two strings carry their **remedies**, not just their causes, because the remedies differ:
  reloading fixes an unreadable file and does nothing for a newer schema. Both the refusal
  Notice and the settings tab render the same sentence, so a wrong remedy would be wrong twice.

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
...
  reload = (): Promise<void> => this.enqueue(this.readFromDisk);
```

Eight lines, and three properties fall out of them.

**Order.** Work runs in call order, because each new task chains onto the tail.

**A failure cannot stop a successor.** The tail is `run.then(noop, noop)`, so `pending` never
rejects — which is also why `this.pending.then(fn)` needs only one arm. (The docstring above
`enqueue` credits "the `.catch` below" for this; there is no `.catch`, and the two-armed
`.then` is what does it — see Findings.)

**Reloads are ordered against writes.** `reload` joins the same queue as `commit`. Without
that, a save requested before a sync-triggered reload could land _after_ it and overwrite the
state just adopted from disk.

### Commit, which is the whole design in one function

`src/store.ts` — `commit`

```ts
  commit = (apply: (state: PluginState) => PluginState): Promise<boolean> =>
    this.enqueue(async () => {
      ...
      const next = apply(this.current);
      if (next === this.current) return true;

      if (this.fence) {
        ...
        this.deps.notify(`Review: ${this.fence}`);
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
   the fence first made a fenced session pop a Notice for each attachment Obsidian Sync
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
    load: () => this.readData(),
    save: (data) => this.saveData(data),
    notify: (message) => new Notice(message),
    log: (message, err) => console.error(`[review] ${message}`, err),
    warn: (message) => console.warn(`[review] ${message}`),
    onChange: () => this.statusBar?.update(),
  });
...
  private readData = async (): Promise<unknown> => {
    const path = `${this.manifest.dir}/data.json`;
    if (!(await this.app.vault.adapter.exists(path))) return null;
    return JSON.parse(await this.app.vault.adapter.read(path));
  };

  /** The persisted document. Read-only here; the store owns replacement. */
  get state(): PluginState {
    return this.store.state;
  }
```

Five one-line adapters and one that is not. The `?.` on `statusBar` matters: `onChange` can
fire during `onload`, before the status bar has been constructed.

**`load` is deliberately not `loadData`**, and this is the single most load-bearing line in the
file. The store's read-failure fence refuses to write when `load` _throws_; Obsidian's
`loadData` never throws. Given a file it cannot parse it returns `undefined`, and given no file
it returns `null` — both of which reach the store as "nothing saved yet". So a truncated
`data.json` was read as a fresh install, and the first write replaced it with defaults: exactly
the loss the fence exists to prevent, in the mechanism built to prevent it.

Reading the file here puts the failure back in the plugin's own hands. `JSON.parse` throwing on
bad input is a language guarantee; `loadData` returning `undefined` for that case is an
undocumented internal, and the fence must not rest on one. `exists` is what keeps a fresh
install — which must _not_ fence — apart from a damaged one, the distinction `loadData`
collapses.

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
  override onload = async () => {
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
...
    const active = this.getActiveMarkdownFile();
    const others = unreviewed.filter((f) => f.path !== active?.path);
    const candidates = others.length ? others : unreviewed;

    // Both early returns above have already established a non-empty list, so
    // this guard never fires; it is what lets the compiler see that.
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    if (!next) return;
    await this.app.workspace.getLeaf(false).openFile(next);
```

Two failure modes are distinguished rather than collapsed, and the source says why:
congratulating someone on a review they never started points them away from the settings tab,
which is where the actual fault is.

The active-file filter with its fallback is the subtle part. Opening the file already in the
leaf is a no-op the user reads as a broken command — with three notes left it happens a third
of the time. But filtering unconditionally would make the _last_ unreviewed file unopenable,
which is worse. Hence `others.length ? others : unreviewed`.

`if (!next) return;` is dead by construction, and the comment says so. Under
`noUncheckedIndexedAccess` an array index is typed `T | undefined`, and the compiler cannot
follow the two early returns to the conclusion that this one is in range. The guard is how
it gets told, in place of a `!` that would assert the same thing without checking it.

### Vault reconciliation

`src/main.ts` — `reconcile`, `handleFileRename` and `handleFileDelete`

```ts
  private reconcile = async (apply: (state: PluginState) => PluginState) => {
    const before = this.state;
    await this.commit(apply);
    if (this.state !== before) this.settingsTab?.invalidate();
  };
...
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
replaced only when something changed — hence the reference comparison across the call. Almost
every vault event has nothing to do with the review — an attachment Sync moved, a note another
plugin wrote — and the comparison keeps the tab from re-rendering for each one. It also skips
the repaint after a refusal or a failed write, which is the same answer for the same reason.

The guard predates the declarative tab, and it mattered more then: `invalidate()` used to
throw away an edit buffer, so an unrelated vault event could wipe a half-typed row. Now
`invalidate()` is a bare `update()`, so an unneeded call costs a re-render and nothing else.

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
  override onClose(): void {
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
...
  onChooseSuggestion = (command: ReviewCommand) => {
    this.plugin.runAsync(command.run(this.plugin), command.label);
  };
```

There is no `switch` and no per-command dispatch. The modal filters and renders; the table
supplies the behaviour.

The third modal is the folder picker the settings tab opens to add an exclusion:

`src/modals.ts` — `FolderPickerModal`

```ts
/** Picks a folder to exclude from review. The vault root is not offered:
 * excluding it would exclude everything. */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
...
  getItems(): TFolder[] {
    return this.app.vault.getAllFolders(false);
  }
```

`getAllFolders(false)` is the whole rule: the argument leaves out the root, the one folder
whose exclusion would make every note ineligible. Picking hands back `folder.path`, which is
already normalized, so a folder added this way can never be the `"Templates/"` that matches
nothing.

### Settings tab

The tab is built on Obsidian 1.13's declarative settings, and split in two along the same
line as the rest of the plugin. `settingsDefinitions.ts` describes the tab as data — a pure
function from what the tab shows to an array of setting definitions. `settingsTab.ts` binds
the definitions' keys to the store. Obsidian renders the array, and re-renders it on
`update()`.

`src/settingsDefinitions.ts` — `TabModel` and `TabActions`

```ts
/** What the tab shows, read fresh on every `update()`. */
export interface TabModel {
  state: PluginState;
  /** The store's read-only reason, or null when writes are allowed. */
  blocked: string | null;
  stats: ReviewStats;
}

/** What the tab's action rows do; the wiring supplies them. */
export interface TabActions {
  reset(): void;
  addFolder(): void;
  deleteFolder(index: number): void;
}
```

Those two interfaces are the seam. Everything the definitions need from the plugin arrives as
plain values and plain callbacks, so the tests construct a `TabModel` from `normalizeState`
and record which action fired — no DOM, and no Obsidian.

`src/settingsDefinitions.ts` — `reviewSettingDefinitions`, the fence and the folder list

```ts
    {
      type: "group",
      heading: "Changes are not being saved",
      visible: () => blocked !== null,
      items: [{ name: "Read-only", desc: blocked ?? "" }],
    },
...
    {
      type: "list",
      heading: "Excluded folders",
      emptyState:
        "No folders excluded. Files in excluded folders do not appear in review.",
      addItem: { name: "Exclude a folder", action: () => actions.addFolder() },
      onDelete: (index) => actions.deleteFolder(index),
      items: folders.map((folder, index) => ({
        name: folder,
        control: {
          type: "folder" as const,
          key: folderKey(index),
          validate: (value: string) => validateFolderRow(folders, index, value),
        },
      })),
    },
```

The fence group comes first, on purpose. The fence protects a review that cannot be
reconstructed, and until the tab showed it the only signal was a `Notice` _after_ the user
changed something — which is after the point where knowing would have changed what they did.
It renders the store's sentence rather than a boolean, because the tab must not have to know
which fence is up to say what to do about it.

Between the two sit the "Review" group — "Reset review" as an action row that opens the
confirm dialog, then the eligible and reviewed counts — and after the list, a "Status bar"
group holding a single toggle.

Each excluded folder is a row with a folder control, and the control's key is its position:

`src/settingsDefinitions.ts` — `folderKey` and `parseFolderKey`

```ts
const FOLDER_KEY = "excludedFolders.";

/** A list row's control key names its position: `excludedFolders.2`. */
export function folderKey(index: number): string {
  return `${FOLDER_KEY}${index}`;
}

export function parseFolderKey(key: string): number | null {
  if (!key.startsWith(FOLDER_KEY)) return null;
  const index = Number(key.slice(FOLDER_KEY.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}
```

Declarative settings address every control by a string key, and the store holds the folders
as an array, so the key carries the index across. `parseFolderKey` refuses anything that is
not a non-negative integer suffix, which keeps `excludedFolders.x` from writing slot `NaN`.

The row rule is the part of the port that replaced the most code:

`src/settingsDefinitions.ts` — `validateFolderRow`

```ts
/**
 * A row may not be emptied or made a duplicate of another, so the
 * normalization `setExcludedFolders` applies — drop empties, dedupe — never has
 * anything to remove: a half-typed value is stored as typed, and a value that
 * would collapse rows is rejected before it is stored.
 */
export function validateFolderRow(
  folders: readonly string[],
  index: number,
  value: string,
): string | undefined {
  const folder = normalizeFolder(value);
  if (!folder) return "Choose a folder, or delete this row.";
  const duplicate = folders.some(
    (other, i) => i !== index && normalizeFolder(other) === folder,
  );
  return duplicate ? "That folder is already excluded." : undefined;
}
```

The problem it solves is that the visible rows _are_ the stored list, and storing goes
through `normalizeFolders`. Without a rule, clearing a row to retype it would delete the row,
and typing the second character of a duplicate would collapse two rows into one. The earlier
imperative tab solved that with an edit buffer between the rows and the store, which needed a
debounce, a cancel on close, a divergence check and a re-seed rule to keep it from writing
back stale snapshots.

Validation removes the problem rather than buffering around it. A value `validate` rejects is
shown inline and never stored, and every value it accepts is one normalization will keep, so
storing it cannot delete or merge a row. A half-typed value like `Te` on the way to
`Templates` is stored as typed and briefly excludes a folder that does not exist — harmless,
because `isEligible` matches on `${folder}/`.

`normalizeFolder` is the comparison on both sides, which is why it is exported from
`review.ts` rather than reimplemented here: `Templates/` must count as a duplicate of
`Templates` exactly when the store would merge them.

`src/settingsTab.ts` — `getControlValue` and `setControlValue`

```ts
  override getControlValue(key: string): unknown {
    const index = parseFolderKey(key);
    if (index !== null) return this.plugin.state.excludedFolders[index] ?? "";
    if (key === "showStatusBar") return this.plugin.state.showStatusBar;
    return undefined;
  }

  override setControlValue(key: string, value: unknown): void {
    const index = parseFolderKey(key);
    if (index !== null && typeof value === "string") {
      const folders = [...this.plugin.state.excludedFolders];
      folders[index] = value;
      this.saveFolders(folders);
    } else if (key === "showStatusBar" && typeof value === "boolean") {
      this.save(this.plugin.setShowStatusBar(value), "save settings");
    }
  }
```

Reads come straight from `plugin.state`; there is no copy of the settings anywhere in the
tab. Writes go through the plugin's actions, which go through `commit`.

`src/settingsTab.ts` — `invalidate` and `save`

```ts
  invalidate(): void {
    this.update();
  }
...
  private save(write: Promise<unknown>, label: string): void {
    this.plugin.runAsync(
      write.then(() => this.update()),
      label,
    );
  }
```

**Every write is followed by `update()`, whatever it returned.** That one line is how the tab
keeps the plugin's rule that the UI shows only what is on disk. Obsidian moves a toggle on
click, before anyone knows whether the write will land, so the switch is a claim about disk
made before disk was consulted. Re-rendering from `plugin.state` after the commit settles
withdraws the claim when it was false: a fenced session or a failed save redraws the stored
value, not the attempted one, and the tab never contradicts the banner at the top of itself.

The imperative tab needed a re-entrancy flag to do the same thing for the status-bar toggle,
because `setValue` re-entered `onChange`. Re-rendering does not call back into
`setControlValue`, so the flag went with the buffer.

`invalidate()` is how the plugin reports a change the tab did not cause — a vault rename or
delete from `reconcile`, or an external reload from `onExternalSettingsChange`. With nothing
buffered there is nothing to throw away, so it is just a re-render.

## Tests

Three files, 86 tests, no Obsidian mock.

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

`src/settingsDefinitions.test.ts` tests the settings tab as the data it now is:

`src/settingsDefinitions.test.ts` — `model`

```ts
// The tab is data (#193), so it is tested as data: no DOM and no Obsidian.
function model(over: Partial<TabModel> = {}): TabModel {
  return {
    state: normalizeState({ excludedFolders: ["Templates", "Archive"] }),
    blocked: null,
    stats: { eligible: 10, reviewed: 4, percentCompleted: 40 },
    ...over,
  };
}
```

It asserts the shape — the fence group is visible only while `blocked` is set, the folders are
a list of folder controls keyed by position, add and delete reach the actions — and pins
`validateFolderRow` from both sides: a half-typed value is accepted, while emptying a row or
duplicating another is rejected, each test named for the normalization it would otherwise
trip.

Nothing tests `main.ts`, `settingsTab.ts` or the other UI modules — they import Obsidian, and
the project keeps no mock by choice. Those paths are verified by deploying into a vault.

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
That workflow asserts the tag equals the version in `package.json` and `manifest.json`, and
that `versions.json` has a row for it, before installing anything — Obsidian keys installs off
the manifest, so a mismatch would install as the manifest's version and no longer match the
release it came from. It then builds, and fails if the fresh `main.js` differs from the
committed one: the release asset must be the bundle the repository ships, not a rebuild that
happens to differ from it. `styles.css` is uploaded only if present, and since #197 the plugin
has none.

## Where the linear order broke down

Two places, both worth naming.

**`onChange` and the status bar form a loop that the reading order cannot follow.** The store
is introduced as Obsidian-free and self-contained, and it is — but `main.ts` hands it a
callback that repaints the status bar, and the status bar reads `plugin.state`, which is the
store's field. Explaining the store fully requires deferring `onChange` to the plugin section;
explaining the plugin requires having already read the store. The cycle is small and the
`onChange?: () => void` type keeps it honest, but there is no order that avoids the
forward reference.

**A settings control's key is defined in one file and given meaning in another.**
`settingsDefinitions.ts` names each control by a string (`excludedFolders.2`, `showStatusBar`),
and only `settingsTab.ts`'s `getControlValue`/`setControlValue` say what those strings read
and write. Reading the definitions, you have to take the keys on trust until the wiring;
reading the wiring, you have to go back to see which keys exist. `folderKey` and
`parseFolderKey` keep the folder half honest by living beside each other; `showStatusBar` is
a bare literal on both sides.

The previous pass named the imperative tab's edit buffer here, whose justification lived in
the gaps between three files. #197 deleted the buffer, and with it that break in the order.

## Findings

This pass, for 2.5.0, extended the document in place rather than replacing it. Fifteen of its
thirty-three quoted snippets no longer matched their source. Five had been broken by this
release — the declarative settings port (#197) and the stricter compiler flags (#196) — and
are rewritten, along with the settings-tab section, which described an edit buffer, a debounce
and a `folderSuggest.ts` that no longer exist. The other ten had never been verbatim: they
skipped code without marking it, so they were stale at 2.4.0 already. Each now carries an
explicit `...`, and every labelled snippet was checked as a verbatim substring of its file
after formatting. All of that was corrected in place.

Two findings in the source were filed:

- The "only way in" docstring written for `normalizeFolders` now attaches to `normalizeFolder`,
  since #197 inserted the new helper between them — [#198](https://github.com/philoserf/obsidian-review/issues/198).
- `enqueue`'s docstring credits "the `.catch` below" for keeping the queue's tail from
  rejecting; there is no `.catch`, and the two-armed `.then` does it — [#199](https://github.com/philoserf/obsidian-review/issues/199).

The previous pass's three findings (#163, #164, #165) are all closed.

## Index

| #   | Severity | Issue                                                                                                                        | Primary location |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | low      | `normalizeFolders` docstring attaches to `normalizeFolder` — [#198](https://github.com/philoserf/obsidian-review/issues/198) | `src/review.ts`  |
| 2   | low      | `enqueue` docstring cites a `.catch` that does not exist — [#199](https://github.com/philoserf/obsidian-review/issues/199)   | `src/store.ts`   |

**Total: 2 issues (0 critical, 0 high, 0 medium, 2 low)**
