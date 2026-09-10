# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin to randomly review vault notes and track progress. Bun-only toolchain: Bun runs the tests, bundles `src/main.ts` into the committed `main.js` (`build.ts`), and copies the build into a vault (`deploy.ts`).

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

`src/review.ts` (`Review`, `pickRandom`) and `src/data.ts` (persisted shape) import nothing from Obsidian and hold all the logic worth testing. Everything Obsidian-facing lives in `src/plugin.ts` and the UI modules it owns (`statusBar.ts`, `settingsTab.ts`, `modals.ts`, `folderSuggest.ts`). `src/main.ts` is a two-line re-export because Obsidian requires that entrypoint name.

Keep `review.ts` and `data.ts` import-free — there is no Obsidian mock, and adding one would mean the boundary has leaked. The file-vs-folder distinction crosses as a boolean, so `instanceof TFolder` stays in `plugin.ts`.

### Data model

The plugin persists only the set of reviewed file paths, excluded folders, a start timestamp, and the status-bar toggle (Obsidian's `loadData`/`saveData` into `data.json`). The reviewed paths and excluded folders belong to `Review`, their single owner — the vault is the source of truth for what exists, so `Review.rename`/`remove` reconcile _both_ stored sets against current vault state rather than maintaining an authoritative file list.

`Review.setExcludedFolders` is the only way to write excluded folders. It trims, strips trailing slashes, drops empties, and dedupes — a folder stored unnormalized matches nothing, silently.

### Persistence safety rails (`plugin.ts`)

Four invariants that are easy to break by "simplifying" the save path:

- **`saveBlocked`** — writes are refused when `loadData` threw, or when `data.json` carries a `schemaVersion` newer than `CURRENT_SCHEMA_VERSION`. It is reassigned on _every_ path through `loadSettings`, including back to `null`, so a reload lifts a transient block. A newer version's number is preserved rather than truncated to the current one.
- **`normalizeData`** coerces every field to its default instead of throwing: bad `data.json` must still render the settings tab so the user can repair it.
- **`saveSettings`** snapshots the payload at call time and chains onto `savePending`, so overlapping saves land in call order and a failed write does not stop its successor.
- **`mutate`** awaits any in-flight write, applies the change, and rolls the whole `Review` back if the save fails. UI must never show progress that is not on disk. Route review-state changes through it, not through bare `saveSettings`.

Fire-and-forget UI callbacks go through `plugin.runAsync(promise, label)` so rejections surface as a `Notice` instead of vanishing.

### Release process

Use the `obsidian-gate` then `obsidian-ship` skills — do not tag by hand. Never hand-create GitHub releases: pushing a `x.y.z` tag runs `.github/workflows/release.yml`, which attaches `main.js`, `manifest.json`, and `styles.css`. `version-bump.ts` syncs `manifest.json` and `versions.json` from `package.json`.

## Gotchas

- **`main.js` is committed and CI enforces it.** `.github/workflows/main.yml` runs `bun run build` then `git diff --exit-code main.js`. Any source change — or a dependency bump, or a Bun release that shifts bundler output — must be followed by a rebuild and a commit of `main.js`, or the PR fails. `bun run dev` writes an unminified, sourcemapped `main.js`, so run `bun run build` before committing.
- **`bun run typecheck` does not cover the tests.** `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc --noEmit` checks 8 of the 10 files in `src/`. It passes locally after `bun install` (verified: exit 0, no output) — a failure is a real failure, not an expected local artifact.
- `bun run deploy` requires `OBSIDIAN_DEPLOY_DEST` (path to the plugin folder inside a vault). See `.env.local.example`; Bun auto-loads `.env.local`. It runs `build` first, so it will not copy a stale `main.js` — and it refuses to deploy at all when `check` fails, formatting drift included. Use `bun run dev` for a tight edit loop.
- If issue descriptions (line numbers, function names, code structure) don't match the current codebase, stop and flag the discrepancy before proceeding with a fix.

## Testing

`src/review.test.ts` and `src/data.test.ts` test the Obsidian-free modules directly; clock and rng are injectable (`markReviewed(path, now)`, `pickRandom(items, rng)`). Plugin integration (Obsidian API calls) is not unit-tested — verify it by deploying into a vault.
