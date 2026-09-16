# A Theory of the Review Plugin

This is the understanding you need to hold in mind to change this plugin without damaging it.
It is not a tour of the files — `WALKTHROUGH.md` is that. Read this when you want to know
_why_ the code resists a change you were about to make.

## What the system is for

Someone with a large vault wants to walk every note once, in no particular order, and see how
far they have got.

That is the whole domain. A note has been visited or it has not. There is no rating, no
schedule, no interval, no second pass, no notion of a note going stale. `README.md` declines
those on the user's behalf, and the refusal is not modesty — it is the reason this is a
1,400-line codebase rather than a spaced-repetition engine. A change that makes "reviewed"
extensible is not a feature addition here; it is a different program.

The vocabulary is small and worth getting exactly right, because two of the words are easy to
conflate:

- **Eligible** — the plugin is allowed to show you this file. Markdown, and not under an
  excluded folder.
- **Reviewed** — you have been through it.

Every surface in the UI branches on the pair, collapsed into one three-valued answer:
`reviewed`, `not_reviewed`, or `undefined` meaning "nothing here to review". The third value
is doing real work. Without it, "no file is open" and "this file is excluded" would have to be
distinguished at every call site, and they never are.

## The organizing idea: the vault is the source of truth

**The plugin stores what has been visited. It does not store what exists.**

No file list is cached. `vault.getMarkdownFiles()` is asked fresh on every statistics render
and every random pick. Completion is computed, never stored — which is why there is no
"rebuild index" command and no way for the count to be wrong in a way a restart would fix.

That decision buys correctness by construction and pays for it in reconciliation. When a file
moves, the stored path is now a path to nothing. When a folder moves, every stored path under
it is wrong at once. So `renamePath` and `removePath` exist, and they are the largest
functions in the domain module — not because path rewriting is hard, but because the
alternative was a cached file list that could drift.

The consequence that is genuinely easy to miss, and that the project learned the hard way:
**excluded folders are paths too.** They need exactly the same reconciliation as reviewed
paths. Excluding `Templates` and then moving it to `Meta/Templates` used to silently
un-exclude everything in it while the settings tab went on listing the old path. That is why
`excludedFolders` lives in the same value as `reviewedPaths` and gets rewritten by the same
two functions. If you are ever tempted to move it somewhere more "settings-like", this is the
thing you would break.

## The second idea: progress you can see must be progress on disk

Nothing in a vault records that a note was visited. Obsidian writes no frontmatter, sets no
flag, touches nothing. The entire record lives in one `data.json` — which means **a lost
`data.json` is unreconstructible work**, in a way that a lost cache or a lost index never is.

Every unusual thing about the save path follows from taking that seriously.

### Commit-after-write, and what it replaced

The plugin used to apply a change to memory, write, and roll back if the write failed. That
design produced four separate filed bugs, and they were not slips — they were what a rollback
transaction costs when the state it guards is mutable and reachable by several writers. Two
overlapping calls took the same snapshot, so one rollback erased the other's change. The
rollback restored one copy of the state and not the other. A refusal arriving mid-flight
returned success.

What replaced it is one function, and the ordering inside it is the entire design:

```
commit(apply):
  enter the queue
  next = apply(state)
  if next === state → return true          (nothing changed; write nothing)
  if blocked        → notify, return false
  await save(serialize(next))              (write first)
  state = next                             (adopt only now)
  onChange()                               (repaint only now)
```

Nothing is applied speculatively, so **there is nothing to roll back.** The snapshot, the
restore, and the drain-before-apply did not get fixed; they stopped being necessary. If you
find yourself reintroducing a rollback, stop — you are rebuilding the design those four bugs
came out of, and a comment in `main.ts` still recommends it (see the index).

Three consequences you must not "simplify" away:

- **The fence is checked inside the queue**, not before entering it. Checking early and then
  awaiting is exactly the hole that let a refusal return success.
- **The transition runs inside the queue too**, so it computes from whatever the previous
  commit actually persisted. This is what makes two rapid marks compose instead of race.
- **The transition also runs _before_ the fence**, because a change of nothing is not a change
  to refuse. Reconciliation commits on every vault rename and delete, and almost none of them
  touch the review; with the fence first, a blocked session notified about each one. This does
  not reopen the hole above — `apply` is pure and synchronous, so nothing can arrive between
  the fence check and the write.

**`commit` is the only door, and the compiler holds it.** Every method that could bypass it —
a bare `save`, a `setState` — was deleted when the last writers were routed through it, but the
document itself stayed a public field, so the rule survived only because nobody had written the
line that broke it. The field is now `private current`, read through a getter. This matters more
than tidiness: the value's own immutability was already enforced three ways over, which made the
type system look like it was guarding this state while the one move that skips the fence, the
queue and the write — replacing the whole field — typechecked in silence. Mutating the value in
place is a bug that cannot lose data; replacing it is one that can.

`commit` returns `false` for both a refusal and an I/O failure, and that is deliberate rather
than lazy: the caller's question is "is this on disk?", and both answers are no. Two callers
act on it, and both want the merged meaning. `markReviewed` will not navigate you away from a
file whose mark was not persisted. The settings tab repaints after a reset only if the reset
happened — where `false` additionally absorbs a third case, the user cancelling the
confirmation dialog, which from the tab's point of view is the same event: nothing changed, so
do not redraw as though something had.

### Reference equality is the "nothing happened" signal

This is the least obvious idea in the codebase and the one most likely to be broken by
accident. A transition that changes nothing returns **the same object**, not an equal one, and
`commit` tests with `===`.

That single convention does three jobs at once. It replaces the booleans `rename` and `remove`
used to return. It lets `commit` skip a write entirely when a keystroke changed nothing
meaningful — note that `setExcludedFolders` compares _after_ normalizing, so typing a trailing
slash onto a folder that is already excluded writes nothing. And it removes the `if (changed)`
guards the vault handlers used to need around the _write_ — they still ask the question for the
settings tab, by comparing the state reference across the commit, because `invalidate()` costs
the user a half-typed row and a write costs nothing.

A transition that returned a fresh object every time would still be correct, and every test
would still pass, and the plugin would quietly write the entire reviewed-path set on every
keystroke in a folder field. Nothing would tell you.

### The write fence has two independent reasons

`blocked` is not one guard, it is two, and they protect different things:

- **A read that failed.** If `loadData` throws, the in-memory state is the empty default —
  and saving that would destroy a review the plugin merely could not read this time.
- **Data from a newer schema.** A future version's fields would be silently dropped on the
  next save.

Four details around it look like fussiness and are not. `loadFailed` is tracked separately from
`raw === null`, because `null` is also what a fresh install looks like. A newer version's
_number_ is preserved rather than stamped down, so a later successful write does not truncate
the file's own claim about itself. And `blocked` is reassigned on **every** path through
`reload`, `null` included — so a transient read failure lifts on the next reload rather than
latching until Obsidian restarts.

The fourth is `schemaVersion` being the one field `normalizeState` does not simply default.
Everything else degrades to a sane value, but the sane value here — the current version —
means "not newer than me", which is the same as switching the fence off. So a version written
as a string is parsed rather than discarded, and only a file with no readable version in it
falls back. That direction matters: defaulting `"3"` to `2` would let this build overwrite a
newer version's data with its own narrower view of it.

### Coercion is a UX requirement, not defensiveness

`normalizeState` coerces rather than throwing, and the reason is specific: a `data.json` that
throws blanks the settings tab, which is the only place the user can repair the value that
broke it. Throwing would make the failure unrecoverable from inside the product.

Coercing is not the same as defaulting, and the distinction is the whole of the
`schemaVersion` case above. Every other field degrades to its default because the default is
harmless; that one is read for what it means, because its default is the thing that turns the
fence off.

Two of the coercions have an incident behind them. `new Set("abc")` yields three
one-character members, so a string `reviewedPaths` would silently mark three paths reviewed. A
non-array `excludedFolders` used to leave the settings tab blank, because `isEligible` calls
`.some()` on it and the statistics sit under that call.

## The boundary, and why it is drawn where it is

`review.ts` and `store.ts` import nothing from Obsidian. Everything else does.

This is the decision the entire test suite rests on. There is no Obsidian mock — one existed
and was deleted, and needing another is treated as evidence the boundary has leaked rather
than as a gap in tooling. The tests run against the real modules.

The boundary moved once, and the move is the most important structural fact about this
codebase. The write fence, the queue and the transaction used to be instance members of a
class extending `obsidian.Plugin`, which meant the densest and most bug-prone code in the
repository was the only code no test could reach. Six of eight findings from one audit pass
lived in that half. The fix was not a mock: `loadData` and `saveData` are two functions, and
injected as functions the whole save path becomes ordinary testable code. **The boundary got
larger, not thinner** — that is the move to imitate if you ever face the same choice.

The one domain concept that has to cross it is the file-versus-folder distinction, and it
crosses as a `boolean`. `instanceof TFolder` stays in `main.ts`, one line, so the domain
module needs no Obsidian import for it.

The boundary is now enforced by a Biome `noRestrictedImports` rule rather than trusted,
because the erosion mode was silent: the bundler marks `obsidian` external and carries on, and
`bun test` resolves it from `node_modules`, so a type-only import breaks nothing at runtime.
The boundary could have eroded one `import type` at a time with every gate green.

## The seams

**Obsidian, at four points.** `loadData`/`saveData` (injected into the store), the vault's
rename and delete events, the command and settings-tab registrations, and `Notice`. Everything
else in the Obsidian surface is presentation.

**`runAsync`.** Obsidian's callbacks are synchronous and cannot await. Without this bridge a
rejected promise from a command handler vanishes with no console line and no user-visible
sign. It looks like ceremony around every call site; it is the only thing making failures
observable.

**`ReviewSettingTab.drafts`, which is the seam most likely to be "cleaned up" into a bug.**
The excluded-folder rows are held as typed, unnormalized, separate from the stored state. That
is _not_ a duplicate copy of state and merging it back is not a simplification. Normalization
drops empties and dedupes, so if the visible rows were the stored list, clearing a row to
retype it would delete the row, and typing the second character of a duplicate would collapse
two rows into one mid-word.

The buffer is right; its _lifetime_ was the hard part, and the current answer took three
mechanisms. The debouncer is cancelled on close, or a keystroke inside the last 500 ms fires
after the buffer is nulled and persists an empty list. The close only commits when the rows
diverge from what the tab was seeded with, or an untouched tab left open across a vault rename
writes the pre-rename list back over the reconciled one. And `invalidate()` drops the buffer
when something outside the tab changes the folders — only when it genuinely did, because the
call is what throws a half-typed row away, and most vault events have nothing to do with the
review.

The re-seed trigger is deliberately **"state changed and the tab did not cause it"**, never
"`display()` ran". The tab calls `display()` itself after adding a row and after the trash
button; re-seeding there would make a just-added empty row vanish and a just-deleted one
reappear before its commit lands.

### The one place two principles genuinely conflict

"The vault is the source of truth" and "nothing changes in memory unless it reached disk" are
both load-bearing, and they contradict each other in exactly one situation: a vault rename
arriving while writes are fenced.

The vault has already moved the file. Reconciling memory would keep the plugin's picture true
and make it un-persistable. Refusing keeps memory and disk consistent and leaves the picture
stale until a reload.

**The code chooses to refuse** — the rename and delete handlers go through `commit` like every
other writer. The reasoning, and you may disagree with it: a blocked session showing exclusions
that the next reload will contradict is worse than one showing a stale path, and a reload
re-derives the correct answer from disk anyway. A rename is also not progress a user would
mourn, which is the asymmetry that breaks the tie.

Refusing has to be _quiet_, though, and that is a separate decision the first version got
wrong. These handlers fire for every file in the vault, not only the ones under review, so a
refusal that announces itself turns a fenced session into a stream of notices about
attachments the user never touched. Hence the no-op check ahead of the fence: the plugin
refuses the renames that would have changed something, and says nothing about the rest.

This was a decision, not an oversight, and it is the one I would most expect a future
maintainer to reverse without realising it had been decided.

## What the system is shaped to accommodate

**A new command.** Add an entry to the table in `commands.ts` — `availableWhen` is the rule,
`run` is the action — and the palette, the review menu and the status-bar menu all pick it up.
That was three files before the table existed.

**A new query over review state.** A pure function in `review.ts`, tested directly.

**A new persisted field.** Add it to `PluginData` and to one side of `PluginState`, coerce it in
`normalizeState`, and `serialize` carries it. Note the trap the current design removed: a
field used to be silently unpersisted unless someone remembered to add a line to the save
path, and nothing failed if they did not.

Which side is the decision worth making deliberately. `PluginState` is `ReviewState`
intersected with `schemaVersion` and `showStatusBar`, and those are three different kinds of
thing sharing one file: the review, a UI preference, and a file-format detail. A field about
what has been reviewed or what is in scope belongs in `ReviewState`, where vault reconciliation
and `reset` will find it; a second preference goes beside `showStatusBar`. The intersection is
still a flat object, so `data.json` does not care either way — this is a distinction drawn for
the reader and for `reset`, which must keep clearing the progress without clearing what the
user configured.

**A different storage backend.** The store takes `load` and `save` as functions. Nothing about
it knows they are Obsidian's.

### What would require rethinking something fundamental

**Anything that makes "reviewed" richer than a boolean** — a score, a due date, a review
count. The whole persisted shape assumes a set of paths. This is refused at the product level,
so the real answer is usually "don't", but if it ever arrives, the shape is the thing to
redesign first and the transitions second.

**Caching the file list.** It would be a large performance win on a huge vault and it would
undo the organizing idea. Every reconciliation path exists because the list is not cached.

**Multi-device merge.** Conflicts are last-writer-wins on the whole file, implicitly. Ordering
against a sync-triggered reload is handled — the reload joins the write queue — but genuine
concurrent edits on two devices are not merged and cannot be with this shape.

## Where a maintainer would do damage

Ranked by how likely the mistake is and how quiet the damage:

1. **Reintroducing a rollback**, or moving the fence check outside the queue. Both look like
   tidying and both restore bugs that were closed by removing the mechanism rather than fixing
   it. Moving the fence check back _in front of_ the transition is the same class of mistake
   with a quieter cost: correct writes, and a notice storm nobody will trace back to here.
2. **Making a transition return a fresh object unconditionally.** Every test still passes. The
   plugin starts writing the whole reviewed-path set on every keystroke, and nothing says so.
3. **Merging `drafts` into the stored state.** It reads as removing a redundant copy. It
   restores the mid-word row-deletion bug.
4. **Moving `excludedFolders` out of the shared value**, into something that feels more like
   settings. It stops being reconciled, and excluded folders silently stop excluding after a
   rename.
5. **Normalizing folders somewhere other than `normalizeFolders`.** The failure is silent: an
   unnormalized entry matches nothing, so the user sees the folder listed as excluded while
   its notes keep appearing.
6. **Repainting the status bar optimistically again**, to remove the one-write delay. That
   delay is the invariant being honest. If it needs addressing, the answer is a pending
   indicator, not an earlier repaint.

## Uncertainties

Where I am inferring from code, and where I think the code is in tension with itself.

**The rename-under-fence decision is recorded in an issue, not in the code.** I am confident
it was deliberate, because the alternative was written down and rejected. But a reader of
`main.ts` alone sees only that the handlers call `commit`, with a comment explaining what that
does and not that the other option was considered. That is the claim in this document I would
most want a second opinion on.

**Nothing enforces that transitions are pure.** The value they operate on is thoroughly
protected — `ReadonlySet`, `readonly` arrays and fields, all three checked and all three
compile errors. But a transition that mutated its argument and returned it would defeat the
`===` check silently, and the type system would not object because the mutation would be of a
local it built. I found no such transition; I am saying the guarantee is narrower than it
looks.

**I do not know how often `onExternalSettingsChange` actually fires** on a single-device
install. The ordering hole it opened was real and is closed, but whether the hook fires at all
outside a sync setup I cannot determine from the code, and it changes how much the surrounding
machinery is worth.

**Everything about `main.ts` and the UI modules rests on reading the call graph**, not on
execution. They import Obsidian and there is no mock, by choice. Claims in this document about
what the settings tab does when a rename arrives mid-edit are traced, not observed.

## Index

No open findings from this pass. Both were closed by the work that followed it:
[#166](https://github.com/philoserf/obsidian-review/issues/166) made the document private
behind a getter, and [#167](https://github.com/philoserf/obsidian-review/issues/167) split the
review fields from the preference that shares their file.

**Total: 0 issues**

Three further findings on this code were filed by the walkthrough pass that ran alongside this
one: a `commit` docstring that still describes the removed rollback ([#163](https://github.com/philoserf/obsidian-review/issues/163)), a
comment citing a `Review` class that no longer exists ([#164](https://github.com/philoserf/obsidian-review/issues/164)), and `Store.isBlocked`
having no production caller ([#165](https://github.com/philoserf/obsidian-review/issues/165)). They
are not counted here, but the first is the one this document refers to above when it warns
against reintroducing a rollback — the comment currently argues for it.
