# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin to randomly review vault notes and track progress.

## Development Commands

```bash
bun install              # Install dependencies
bun run dev              # Watch mode with auto-rebuild (no minification, sourcemaps)
bun run build            # Production build (runs check first)
bun run check            # Run all checks (typecheck + biome)
bun run typecheck        # TypeScript type checking only
bun run lint             # Biome lint + format check
bun run lint:fix         # Auto-fix lint and format issues
bun run format           # Format code with Biome
bun run audit            # Check dependencies for critical vulnerabilities
bun run deploy           # Copy build output to local Obsidian vault for testing
bun run version          # Sync package.json version to manifest.json + versions.json
bun test                 # Run tests
bun test src/main.test.ts -t "computeStats"   # Run a single test by name
```

## Architecture

### Build System

- **Build script**: `build.ts` uses Bun's native bundler
- **Entry point**: `src/main.ts`
- **Output**: `./main.js` (CommonJS format, minified in production)
- **Externals**: `obsidian` and `electron` are not bundled

### Data Model

The plugin persists only the set of reviewed file paths plus excluded folders (via Obsidian's `loadData`/`saveData` into `data.json`). The vault itself is the source of truth for which files exist — so operations like `rewriteReviewedPaths` (rename) and `removeByPrefix` (folder delete) reconcile the stored set against current vault state rather than maintaining an authoritative file list.

### Modules

- `src/main.ts` — plugin entry + pure logic (`computeStats`, `isExcluded`, `rewriteReviewedPaths`, `removeByPrefix`)
- `src/folderSuggest.ts` — settings-tab folder autocomplete via Obsidian's `AbstractInputSuggest`
- `src/__mocks__/` — Obsidian API stubs used by `bun test`

### Release Process

Tag and push to trigger `.github/workflows/` release automation:

```bash
git tag -a <version> -m "Release <version>"
git push origin <version>
```

Never hand-create GitHub releases — the workflow attaches `main.js`, `manifest.json`, and `styles.css` to the tag.

## Gotchas

- `tsc --noEmit` reports errors for `obsidian`, `bun:test`, and `node:fs` modules — these resolve only inside the Obsidian/Bun runtime. CI passes because it installs all type packages. Local failures are expected.
- `bun run deploy` requires `OBSIDIAN_DEPLOY_DEST` to be set (path to the plugin folder inside a vault). See `.env.local.example`. Bun auto-loads `.env.local`.
- If issue descriptions (line numbers, function names, code structure) don't match the current codebase, stop and flag the discrepancy before proceeding with a fix.

## Testing

Pure logic is exported from `src/main.ts` and tested directly in `src/main.test.ts`. Plugin integration (Obsidian API calls) is not unit-tested — the `__mocks__/` stubs only cover what the pure-logic tests need.
