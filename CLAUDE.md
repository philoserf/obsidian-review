# CLAUDE.md

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
```

## Architecture

### Build System

- **Build script**: `build.ts` uses Bun's native bundler
- **Entry point**: `src/main.ts`
- **Output**: `./main.js` (CommonJS format, minified in production)
- **Externals**: `obsidian` and `electron` are not bundled

### Release Process

Tag and push to trigger the GitHub Actions release workflow:

```bash
git tag -a <version> -m "Release <version>"
git push origin <version>
```

## Gotchas

- `tsc --noEmit` reports errors for `obsidian`, `bun:test`, and `node:fs` modules — these resolve only inside the Obsidian/Bun runtime. CI passes because it installs all type packages. Local failures are expected.
- If issue descriptions (line numbers, function names, code structure) don't match the current codebase, stop and flag the discrepancy before proceeding with a fix.

## Testing

Pure logic is exported from `src/main.ts` (`computeStats`, `isExcluded`, `rewriteReviewedPaths`, `removeByPrefix`) and tested directly in `src/main.test.ts`. Plugin integration (Obsidian API calls) is not unit-tested.

## Code Style

Enforced by Biome: 2-space indent, organized imports, git-aware VCS integration.
