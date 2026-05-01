# Review

Randomly review your vault notes and track progress in [Obsidian](https://obsidian.md/). Originally by [Alexander](https://x.com/sashakryzh).

## You probably shouldn't install this

This is personal tooling, not a general-purpose plugin. It is opinionated in ways that only make sense for one person's workflow:

- **Single user.** The only known installation is the maintainer's. Breaking changes ship without migration paths (see `CHANGELOG.md` — 2.0.0 replaced the snapshot data model entirely, discarding old review data on upgrade).
- **Fork, not upstream.** This diverged from the original and is not a drop-in replacement. The data model, UI, and internal structure have all changed.
- **Two states only.** Every markdown file is either reviewed or not reviewed. There is no priority, rating, or scheduling system.
- **No issue triage for feature requests.** Bugs are welcome; feature requests from other users will almost always be closed as out-of-scope.

If you want something similar, the code is MIT-licensed — fork it and adapt. Don't expect upstream to accommodate your workflow.

## How It Works

Every markdown file in your vault is either **reviewed** or **not reviewed**. The plugin stores only the set of reviewed file paths — the vault itself is the source of truth for which files exist.

**Commands:**

- **Open random unreviewed file** — picks a random file you haven't reviewed yet
- **Mark file as reviewed** — adds the current file to the reviewed set
- **Mark file as reviewed and open next** — mark and immediately get the next random file
- **Mark file as unreviewed** — removes the current file from the reviewed set
- **Open review menu** — command palette-style modal with all review actions

**Status bar** shows "Reviewed" or "Not reviewed" for the active file. Click to change.

**Excluded folders** let you skip folders you don't want to review (templates, daily notes, etc.). Configure in settings with folder autocomplete.

**Reset** clears all review progress when you're ready to start over. Excluded folders are preserved.

**Statistics** in the settings panel show eligible files, reviewed count, and completion percentage.

## Alternatives

- [SashaKryzh/obsidian-vault-review](https://github.com/SashaKryzh/obsidian-vault-review) — the original upstream this fork diverged from.
