# A Theory of the Review Plugin

This is the understanding you need to hold in mind to change this plugin without damaging
it. It is not a tour of the files — `WALKTHROUGH.md` is that. Read this when you want to
know _why_ the code resists a change you were about to make.

## What the system is for

Someone keeps a large Obsidian vault and wants to walk the whole thing, note by note, in no
particular order, pruning and confirming as they go. The problem is not finding a note. It
is **coverage**: after a few hundred notes you cannot remember which you have already
looked at, and without a record the sweep never demonstrably finishes. This plugin makes
the sweep legible. It answers two questions and no others: _what fraction of my vault have
I been through_, and _give me one I haven't been through yet_.

Three things exist in the domain. A **note** is a markdown file in the vault. The **review**
is a single ongoing sweep with a start date and a set of visited paths — there is exactly
one, always in progress, and "starting a new one" means resetting the old one. A **folder
exclusion** declares a subtree out of scope: templates, daily journals, an archive. That is
the whole vocabulary. There is no rating, no priority, no due date, no second pass, and
`README.md` says outright that feature requests wanting those will be closed.

The binary-ness is the design, not a stage on the way to something richer. Every surface
assumes it: the status bar has two labels, the menu has two mutating actions, `Review`
stores a `Set<string>` with no value type, and `stats()` computes one percentage. A
requirement like "show me notes I reviewed over a year ago" is not an increment here — it
is a different plugin.

## The organizing idea: the vault is the source of truth

Version 2.0 threw away a "snapshot" model that kept its own copy of the vault's file list.
Everything about the current shape follows from that decision. The plugin stores only which
paths have been _reviewed_; to know what _exists_, it asks Obsidian
(`vault.getMarkdownFiles()`, `plugin.ts:227`) every single time. There is no cache and no
file-list state to go stale.

The bill for that comes due in two places, and both are load-bearing:

**Reconciliation instead of enumeration.** Because the plugin never lists files itself, it
has to be told when paths move. `vault.on("rename")` and `vault.on("delete")`
(`plugin.ts:96-111`) are the only mechanism keeping `reviewedPaths` from filling with
addresses of files that no longer exist. `Review.rename` and `Review.remove` do the path
surgery, and — this is the part that is easy to miss — they reconcile `excludedFolders`
too, not just reviewed paths. Issue #80, memorialized in a comment at `review.test.ts:182`,
is what taught the project that: excluding `Templates` and then dragging it into `Meta/`
silently un-excluded everything inside while the settings tab kept listing the old path.
The class docstring at `review.ts:16-25` says excluded folders live in `Review` _for exactly
that reason_ — they are there because they need the same reconciliation, not because they
are conceptually review state.

**Stale entries are tolerated, not prevented.** `reviewedPaths` is not a subset of eligible
paths and was never meant to be. Mark a note reviewed, then exclude its folder: the entry
stays. `stats()` (`review.ts:81`) takes the eligible list as an argument and intersects,
so the stale entry is invisible rather than wrong. If you write code that iterates
`reviewedPaths` directly to build a list of anything user-facing, you will be wrong unless
you re-filter through `isEligible` first. That re-filtering is the invariant; set purity is
not.

## The boundary, and why it is drawn where it is

`src/review.ts` and `src/data.ts` import nothing. Everything else imports `obsidian`. This
is not layering for its own sake — it is the reason there is no Obsidian mock in the repo,
and the reason the 47 tests run against the real classes rather than a fiction of them. The
project deleted a hand-rolled mock in #98 and treats needing one again as evidence the
boundary has leaked.

The file-vs-folder distinction is where you can watch the boundary being held. Obsidian
hands the rename event a `TAbstractFile`; deciding whether it is a folder needs
`instanceof TFolder`, which needs the import. So `plugin.ts:345` does the `instanceof` and
passes a `boolean` across, and `Review.rename(oldPath, newPath, isFolder)` takes it. The
comment at `plugin.ts:342` states the trade explicitly. If you ever find yourself wanting
to pass a `TFile` into `Review`, that is the moment the theory is being abandoned — and
nothing in the toolchain will stop you, which is filed as its own finding below.

`src/main.ts` is two lines because Obsidian requires an entrypoint by that name. It carries
no meaning.

## Persistence: four rails around one `saveData` call

This is where the code is densest and where "simplifying" does the most damage. All of it
guards a single premise: **review progress the user can see must be progress that is on
disk.** Someone who has swept 1,800 of 2,400 notes and loses the record has lost work that
cannot be reconstructed, because nothing in the vault itself records that a note was
visited. Every rail below exists to make that unrecoverable loss impossible rather than
unlikely.

**`saveBlocked` (`plugin.ts:30`)** is a write fence with two triggers: `loadData` threw, or
the file declares a `schemaVersion` newer than this build understands. Both mean the same
thing — _there is data here I cannot faithfully round-trip_ — and the response is the same:
refuse to write rather than overwrite it with what we managed to parse. The comment at
`plugin.ts:150` flags the subtle half: it is assigned on _every_ path through
`loadSettings`, back to `null` included, so a transient read failure is lifted by a reload
rather than sticking for the session. And `plugin.ts:147` keeps a newer file's version
number rather than stamping it down to 2, so if the fence is ever lifted the file is not
silently truncated to what this build knows.

**`normalizeData` (`data.ts:32`)** coerces instead of throwing, and the reason is a UX one
rather than a robustness one: a `data.json` that throws leaves the settings tab blank, and
the settings tab is the only place the user can repair the value that broke it. The test at
`data.test.ts:42` records the actual incident — a non-array `excludedFolders` reached
`.some()` and blanked the tab. The one at `:54` records the other: `new Set("abc")` yields
three one-character paths, so a string where an array belonged silently marked notes
reviewed.

**`saveSettings` (`plugin.ts:167`)** snapshots the payload at call time and chains it onto
`savePending`. Two properties, and both matter. Writes land in the order they were
requested, not the order their promises happen to resolve. And a failed write does not
stop its successor — hence the identical `then(onFulfilled, onRejected)` arms at
`plugin.ts:191-194`, which look like a mistake and are not.

**`mutate` (`plugin.ts:277`)** is the entry point for anything that changes review state
from a user action. It refuses up front if writes are fenced, drains the queue so a rollback
cannot be overtaken by a save that was already in flight, applies, and restores `Review` if
the write throws. #97 is the commit that introduced it, and its message — "only commit
mutations that were persisted" — is the invariant in six words.

Above all of it sits `runAsync` (`plugin.ts:39`), which exists because Obsidian's callbacks
are synchronous and cannot await. Without it a rejected save vanishes into an unhandled
rejection and the user never learns their progress was not recorded.

The rails are not airtight, and the gaps are worth knowing before you trust them. `mutate`
rolls back `Review` but not the parallel copy in `this.data` that the settings tab reads;
`onExternalSettingsChange` adopts disk state without draining the queue that is about to
overwrite it; and three paths change state without going through `mutate` at all. All three
are filed below.

## The seams

**To Obsidian.** Five touchpoints, and the plugin never reads or writes note _content_ —
only paths. `loadData`/`saveData` (Obsidian owns the JSON file), `getMarkdownFiles`,
`vault.on("rename"|"delete")`, `workspace.getActiveFile`, `workspace.getLeaf().openFile`.
`getActiveMarkdownFile` (`plugin.ts:216`) filters on `extension !== "md"` because Obsidian's
active file can be a PDF or an image, and the plugin has nothing to say about those.

**Settings tab to plugin state, via a deliberate third copy.** `ReviewSettingTab.drafts`
(`settingsTab.ts:15`) holds excluded-folder rows _as typed_, before normalization, and this
looks like redundant state until you see what it prevents. `setExcludedFolders` drops empty
entries and dedupes; if the visible rows were the stored list, typing the second character
of a duplicate would delete the row out from under the cursor, and clearing a row to retype
it would delete the row. So the rows live in the tab, normalization happens on a 500ms
debounce, and `hide()` commits rather than prunes so an edit inside the debounce window is
not lost when the tab closes. Three separate bugs (#56 among them) are encoded in those
twenty lines.

**Status bar to active file.** Three states, not two: hidden (non-markdown, or excluded),
"Reviewed", "Not reviewed". `getActiveFileStatus` returns `undefined` for the first, and
every caller — the status bar, the menu modal, and the `checkCallback` on all three
mutating commands — branches on it. Hiding is done with `element.toggle()` rather than
Obsidian's `is-hidden` class, and the comment at `statusBar.ts:56` explains why: those CSS
rules are scoped to ribbon and stacked-tab elements, so the class styled nothing here. That
was #108, shipped four commits ago, and it is the kind of thing that will look like a
gratuitous deviation from convention if you don't read the comment.

**Build to distribution.** `main.js` is committed, minified, and CI enforces that it matches
a fresh build (`bun run build` then `git diff --exit-code main.js`). Bun is deliberately
unpinned in the workflow, so a Bun release that shifts bundler output trips the same check.
This means every source change is a two-file change, and the second file is unreviewable.
I rebuilt during this pass: the committed `main.js` is byte-identical to a fresh build at
`fa116ba`.

## What it is shaped to accommodate

**New commands and menu entries** slot in without structural change — register in `onload`,
add a case in `ReviewMenuModal`. The menu's _ordering_ is the only thing with judgment in
it: when a file is unreviewed, "mark and open next" comes first, because that is the loop
the plugin exists to accelerate.

**A new eligibility rule** — exclude by tag, by frontmatter, by filename — has one obvious
home. `Review.isEligible` is the single predicate, and `setExcludedFolders` is documented
(`review.ts:43`) as "the only way in" precisely so a new rule cannot be bolted on somewhere
that skips normalization.

**A schema change that needs to transform existing data** has no home. `CURRENT_SCHEMA_VERSION`
is a _fence_, not a migration hook: it stops a newer file from being clobbered, and that is
all it does. The v1 migration that used to exist was deleted in #99 on the grounds that the
snapshot model and the reviewed-paths model had nothing in common to carry across. If you
add a v3 that does, you will be writing the migration framework as well as the migration,
and nothing currently forces you to bump the constant when you change the shape.

**Anything that makes "reviewed" richer than a boolean** touches the data model, the status
bar, the menu, the stats, and the persisted format at once. See the first section: that is
a rewrite, and `README.md` has already declined it on the user's behalf.

## Where a maintainer would do damage

Three specific ways, in descending order of how easy they are to do by accident:

1. **Collapsing the three copies of state.** `Review` (authoritative), `plugin.data` (the
   persisted mirror), and `SettingTab.drafts` (pre-normalization rows) look like duplication
   and are not — the drafts copy in particular exists to defeat the very normalization that
   makes the stored list correct. Merging them would reintroduce #56.
2. **Routing a state change around `mutate`.** It will work in every test you can run
   locally, because you cannot easily make `saveData` fail. It breaks only for the user whose
   disk is full or whose vault is on a flaky sync mount — the exact user the rail was built
   for.
3. **Importing `obsidian` into `review.ts` or `data.ts`.** Nothing fails. Typecheck passes,
   lint passes, the bundler marks it external, and the tests keep passing because a type-only
   import has no runtime. The boundary can erode completely with every gate green.

## Uncertainties

I am inferring intent from code, comments, commit messages and `CHANGELOG.md`. There is no
ADR trail and one maintainer, so "the author decided X" below always means "the code reads
as though the author decided X."

**Whether the rename/delete bypass of `mutate` is a decision or an omission.** It is
defensible — the vault has already moved the file, so refusing to reconcile would leave the
plugin wrong in the other direction — but nothing says so, and the same handlers fire a
"changes will not be saved" `Notice` that describes a user action the user did not take.
I filed it as a finding because the two readings imply different fixes, and only the author
can say which.

**The status-bar toggle's placement in `plugin.data` rather than `Review`.** It is the one
persisted field that is a preference rather than review state, and it is also the one the
save path handles least carefully. That may be principled (it is genuinely not review
state) or it may be where it landed when #101 consolidated everything else.

**How often `onExternalSettingsChange` actually fires.** The race I describe is real in the
code, but I cannot tell from source whether Obsidian fires the hook aggressively enough for
a single-user, single-device installation to ever hit it. The severity I assigned assumes it
can.

**The previous `THEORY.md` described a system that no longer exists.** It documented
`rewriteReviewedPaths` and `removeByPrefix` as the tested pure functions, a v1-to-v2
migration inside `loadSettings`, a `getReviewedCount()` method, and "no explicit lock or
queue" on the save path. None of those are in the tree at `fa116ba` — they were removed or
replaced by #99, #101, and #97. I have not filed that as a finding because this document
replaces it, but it is a caution about how fast this file goes stale: three refactors in one
release cycle invalidated most of it.

**`manifest.json` still credits "originally by Alexander."** `README.md` says the fork
diverged in data model, UI, and internal structure. Whether anything structural survives
from the original — or whether any registry-side assumption depends on the old behavior —
I could not determine.

## Index

| #   | Severity | Issue                                                                  | Primary location                                      |
| --- | -------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | high     | `external-settings-reload-does-not-await-the-write-queue`              | `src/plugin.ts:211-214`                               |
| 2   | medium   | `mutate-rollback-leaves-plugin-data-holding-the-failed-state`          | `src/plugin.ts:296-303`, `src/settingsTab.ts:43`      |
| 3   | medium   | `review-state-mutations-outside-mutate-apply-while-writes-are-blocked` | `src/plugin.ts:344-356`, `src/settingsTab.ts:110-117` |
| 4   | medium   | `nothing-enforces-the-obsidian-free-boundary-in-review-and-data`       | `tsconfig.json:12`, `biome.json`                      |
| 5   | low      | `schema-version-is-the-one-persisted-field-that-skips-normalizedata`   | `src/plugin.ts:131-132`, `src/data.ts:32`             |

**Total: 5 issues (0 critical, 1 high, 3 medium, 1 low)**
