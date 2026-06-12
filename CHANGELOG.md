# Changelog

## 2.1.0

### Fixed

- Declare `minAppVersion` 1.6.0 to match actual Obsidian API usage (#60)
- Surface async failures from UI handlers via Notice instead of swallowing them (#68)
- Handle loadData/saveData failures; act on the schema version with a downgrade guard (#61, #64)
- "Add excluded folder" no longer persists an empty entry; empty rows are pruned when settings close (#56)

### Changed

- Settings tab: remove redundant "Not reviewed" stats line, tighten layout (#51)
- Split `main.ts` into focused modules; extract testable `ReviewState` class (#59, #70)
- Update dependencies (obsidian 1.13.1, biome 2.5, typescript 6.0.3)

## 2.0.1

### Fixed

- Replace stale `.in-snapshot` CSS class with `.review-stats`
- Update `actions/checkout` to v6 in Claude workflows

### Changed

- CI workflow updates
- Remove `validate-plugin` script
- Bump `@types/node` to 25.5.2
- Update dependencies

## 2.0.0

**Breaking:** Review data model redesigned. Old snapshot data is discarded on upgrade.

- Replace snapshot model with reviewed-paths set — vault is now the source of truth for file existence
- Two states: reviewed or not reviewed (no more snapshot management)
- Add excluded folders setting with folder autocomplete
- Fix status bar click listener leak — use `registerDomEvent` for automatic cleanup (#37)
- Fix status bar menu not updating file review status correctly (#34)
- Fix deleted files accumulating in snapshot data forever (#35)
- Fix linear scan for every file lookup — `Set` gives O(1) (#36)
- Fix negative "not in snapshot" count (#33)
- Fix `bun run dev` not watching for changes — use `bun --watch` (#38)
- Fix TypeScript 6 compatibility — add `node` and `bun` types to tsconfig
- Add `FolderSuggest` autocomplete component for excluded folder inputs
- Update dev dependencies (biome, @types/bun, typescript)

## 1.2.0

- Restrict release workflow tag filter to version tags only (#4)
- Mark missing files as deleted instead of removing from snapshot (#6)
- Handle folder rename by updating child file paths in snapshot (#8)
- Add schemaVersion field to settings for future migrations (#15)
- Enable linked source maps for development builds (#19)
- Extract rewritePaths as testable pure function with tests
- Refactor: simplify types, naming, and code structure throughout

## 1.1.0

- Add repository settings configuration
- Fix deleteSnapshot promise double-resolve guard
- Include styles.css in deploy script
- Normalize CI workflow whitespace and manifest.json field order
- Update LICENSE to MIT with current copyright
- Update @biomejs/biome and @types/node

## 1.0.0

Initial release. Randomly review your vault and track progress.
