# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin to randomly review vault notes and track progress. Bun-only toolchain: Bun runs the tests, bundles `src/main.ts` into the committed `main.js` (`bun build`, invoked from `package.json`), and copies the build into a vault (`deploy.ts`).

The current next step for this repo is tracked in the workspace backlog at `../NEXT.md` (the `obsidian-review` row). Read it when starting work; update it when that step ships.

`THEORY.md` explains why the code is shaped the way it is; `WALKTHROUGH.md` is a linear read of every module. Prefer them over re-deriving intent from the source.

## Commands

```bash
bun test                        # all tests
bun test src/review.test.ts     # one file
bun test -t setExcludedFolders  # tests whose describe+test name matches
bun run check                   # typecheck + biome (lint & format)
bun run lint:fix                # biome check --write
bun run build                   # check, then bundle to main.js
bun run dev                     # watch-mode rebuild, no check, sourcemaps
bun run deploy                  # build, then copy main.js/manifest.json/styles.css into a vault
```

## Architecture

### The boundary

`src/review.ts` (the persisted shape, its validation, and the pure transitions over it) and `src/store.ts` (the state, the write fence and the write queue) import nothing from Obsidian and hold all the logic worth testing. Everything Obsidian-facing lives in `src/main.ts` and the UI modules it owns (`statusBar.ts`, `settingsTab.ts`, `modals.ts`, `folderSuggest.ts`). `src/commands.ts` is the one table of review actions and their availability rule, read by the command palette, the review menu and the status-bar menu — adding an action means editing one array. The plugin class lives in `src/main.ts`, named for the bundle Obsidian loads rather than re-exported into it.

Keep `review.ts` and `store.ts` import-free — there is no Obsidian mock, and adding one would mean the boundary has leaked. A Biome `noRestrictedImports` override on those two files enforces it, so importing `obsidian` there fails `bun run check` rather than eroding one `import type` at a time. The file-vs-folder distinction crosses as a boolean, so `instanceof TFolder` stays in `main.ts`.

### Data model

The plugin persists only the set of reviewed file paths, excluded folders, a start timestamp, and the status-bar toggle (Obsidian's `loadData`/`saveData` into `data.json`). All five fields live in one immutable `PluginState` owned by `Store` — there is exactly one copy, replaced rather than modified, and `serialize` turns it into the JSON shape at write time. `PluginState` is `ReviewState` (reviewed paths, the start timestamp, excluded folders) intersected with `schemaVersion` and `showStatusBar`, so a new persisted field has a side to land on: the review, or the preferences that merely share its file. The intersection is flat, so `data.json` is unaffected. The vault is the source of truth for what exists, so `renamePath`/`removePath` reconcile _both_ stored sets against current vault state rather than maintaining an authoritative file list.

`normalizeFolders` in `review.ts` is the only way to write excluded folders. It trims, strips trailing slashes, drops empties, and dedupes — a folder stored unnormalized matches nothing, silently, because `isEligible` tests for a `${folder}/` prefix. All three writers go through it: `setExcludedFolders` (the UI), `normalizeState` (the disk), and `renamePath` (vault reconciliation, which maps entries independently and can collide two onto one).

### Persistence safety rails (`store.ts`)

`Store` owns the persisted document, the write fence and the write queue. It takes `load`/`save`/`notify`/`log`/`warn`/`onChange` as plain functions, which is what makes the save path — the plugin's densest code — reachable from `store.test.ts`. Four invariants that are easy to break by "simplifying" it:

- **`blocked`** — writes are refused when `load` threw, or when `data.json` carries a `schemaVersion` newer than `CURRENT_SCHEMA_VERSION`. It is reassigned on _every_ path through `reload`, including back to `null`, so a reload lifts a transient block. A newer version's number is preserved rather than truncated to the current one.
- **`normalizeState`** coerces rather than throwing: bad `data.json` must still render the settings tab so the user can repair it. Every field degrades to its default except `schemaVersion`, whose default reads as "not newer than me" and would switch the fence off — a version written as a string is parsed instead, and only an unreadable one falls back.
- **`enqueue`** serializes everything that touches state or disk — commits, bare saves, and reloads — in call order. A reload joining the same queue is what stops a pending write landing on top of state just adopted from disk.
- **`commit(apply)`** runs the transition _inside_ the queued critical section — and _before_ the fence check, so a transition that changes nothing is not announced as a refusal — and replaces the state only after the write resolves. So overlapping commits compose instead of racing, a refusal cannot slip in behind the fence check, and a failed write needs no rollback. It returns `false` for both a refusal and an I/O failure — the caller's question is "is this on disk?" and both answers are no. **It is the only way to change state** — the document is a private field read through a getter, and there is no bare save and no setter, so vault reconciliation and the status-bar preference go through it like everything else. That is a compiler fact, not a convention: assigning `store.state` from anywhere outside the class is a type error.

Because state is adopted after the write, the status bar repaints after `saveData` resolves rather than optimistically. That is deliberate: the UI must not show progress that is not on disk.

Fire-and-forget UI callbacks go through `plugin.runAsync(promise, label)` so rejections surface as a `Notice` instead of vanishing.

### Release process

Use the `obsidian-gate` then `obsidian-ship` skills — do not tag by hand. Never hand-create GitHub releases: pushing a `x.y.z` tag runs `.github/workflows/release.yml`, which attaches `main.js`, `manifest.json`, and `styles.css`. `version-bump.ts` syncs `manifest.json` and `versions.json` from `package.json`.

## Gotchas

- **`main.js` is committed and CI enforces it.** `.github/workflows/main.yml` runs `bun run build` then `git diff --exit-code main.js`. Any source change — or a dependency bump, or a Bun release that shifts bundler output — must be followed by a rebuild and a commit of `main.js`, or the PR fails. `bun run dev` writes an unminified, sourcemapped `main.js`, so run `bun run build` before committing.
- **`bun run typecheck` covers the tests too.** The `src/**/*.test.ts` exclusion was dropped when the store gained a test suite, so `tsc --noEmit` checks all of `src/`. It passes locally after `bun install` — a failure is a real failure, not an expected local artifact.
- `bun run deploy` requires `OBSIDIAN_DEPLOY_DEST` (path to the plugin folder inside a vault). See `.env.local.example`; Bun auto-loads `.env.local`. It runs `build` first, so it will not copy a stale `main.js` — and it refuses to deploy at all when `check` fails, formatting drift included. Use `bun run dev` for a tight edit loop.
- If issue descriptions (line numbers, function names, code structure) don't match the current codebase, stop and flag the discrepancy before proceeding with a fix.

## Testing

`src/review.test.ts` and `src/store.test.ts` test the Obsidian-free modules directly; the clock is injectable (`markReviewed(path, now)`). Plugin integration (Obsidian API calls) is not unit-tested — verify it by deploying into a vault.
