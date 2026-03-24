# Review

An Obsidian plugin to randomly review your vault notes and track progress.

Originally by [Alexander](https://x.com/sashakryzh). Redesigned and maintained by [Mark Ayers](https://github.com/philoserf).

## What

Review helps you systematically work through every note in your vault. Open a random unreviewed file, mark it reviewed, move on. The plugin tracks which files you've reviewed and shows your progress.

## Why

Large vaults accumulate notes that never get revisited. Review surfaces forgotten notes randomly so you can update, reorganize, or delete them. It turns an overwhelming backlog into a manageable daily habit.

## How

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
