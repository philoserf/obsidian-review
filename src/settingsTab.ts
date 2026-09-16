import { type App, debounce, PluginSettingTab, Setting } from "obsidian";
import { FolderSuggest } from "./folderSuggest";
import type ReviewPlugin from "./main";

export class ReviewSettingTab extends PluginSettingTab {
  plugin: ReviewPlugin;

  /**
   * Excluded-folder rows as typed, before normalization — null while the tab
   * is closed. Rows live here rather than in the plugin so a half-typed or
   * momentarily-empty one survives on screen: setExcludedFolders drops empties
   * and dedupes, which would otherwise delete a row out from under the user
   * mid-word.
   */
  private drafts: string[] | null = null;

  /**
   * What `drafts` was seeded from. `hide()` compares against it so an untouched
   * tab commits nothing — otherwise closing the tab writes back a snapshot that
   * may be older than what the vault has since reconciled.
   */
  private seeded: string[] = [];

  private debouncedCommit = debounce(() => this.commit(), 500, true);

  constructor(app: App, plugin: ReviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private commit(): void {
    // Refuse rather than fall back to []: "no drafts" means the tab is closed,
    // not that the user cleared every folder. An `?? []` here silently persists
    // an empty exclusion list.
    if (!this.drafts) return;

    this.plugin.runAsync(
      this.plugin.setExcludedFolders(this.drafts),
      "save excluded folders",
    );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Seeded once per tab session, not per render: display() is also called by
    // the tab itself after adding or deleting a row, and re-seeding there would
    // make a just-added empty row vanish and a just-deleted one reappear before
    // its async commit lands. invalidate() is what re-seeds, and only when the
    // change came from outside.
    if (!this.drafts) {
      this.seeded = [...this.plugin.state.excludedFolders];
      this.drafts = [...this.seeded];
    }
    const drafts = this.drafts;

    // Before anything the user might edit, not after they try: the fence exists
    // to protect a review that cannot be reconstructed, and a Notice that
    // arrives once they have already changed something tells them too late to
    // have chosen otherwise. The store's message carries its own remedy,
    // because reloading fixes one fence and not the other.
    const blocked = this.plugin.store.blocked;
    if (blocked) {
      containerEl.createDiv("review-blocked", (div) => {
        div.createEl("strong").setText("Changes are not being saved");
        div.createEl("p").setText(blocked);
      });
    }

    const reviewSetting = new Setting(containerEl)
      .setName("Review")
      .setDesc(
        this.plugin.state.reviewStartedAt
          ? `Review started on ${new Date(this.plugin.state.reviewStartedAt).toLocaleDateString()}.`
          : "No active review.",
      );
    reviewSetting.addButton((btn) => {
      btn.setButtonText("Reset review");
      btn.setWarning();
      btn.onClick(() =>
        this.plugin.runAsync(
          // Only repaint when the reset was actually persisted: a cancelled or
          // refused reset must not re-render as though something happened.
          this.plugin.resetReview().then((reset) => {
            if (reset) this.display();
          }),
          "reset review",
        ),
      );
    });

    const stats = this.plugin.getStats();

    containerEl.createDiv("review-stats", (div) => {
      div.createEl("p").setText(`Eligible files: ${stats.eligible}`);
      div
        .createEl("p")
        .setText(`Reviewed: ${stats.reviewed} (${stats.percentCompleted}%)`);
    });

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Files in these folders will not appear in review.");

    for (let i = 0; i < drafts.length; i++) {
      new Setting(containerEl)
        .setClass("review-excluded-folder")
        .addText((text) => {
          text.setValue(drafts[i]);
          // Only the draft changes per keystroke; normalization runs once the
          // debounce fires, so typing a second "Templates" cannot collapse two
          // visible rows into one entry mid-word.
          text.onChange((value) => {
            drafts[i] = value;
            this.debouncedCommit();
          });
          new FolderSuggest(this.app, text.inputEl).onSelect((folder) => {
            text.setValue(folder.path);
            drafts[i] = folder.path;
            this.commit();
          });
        })
        .addButton((btn) => {
          btn.setIcon("trash");
          btn.onClick(() => {
            drafts.splice(i, 1);
            this.commit();
            this.display();
          });
        });
    }

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText("Add excluded folder");
      btn.onClick(() => {
        drafts.push("");
        this.display();
      });
    });

    new Setting(containerEl)
      .setName("Status bar")
      .setDesc("Show file review status in the status bar.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.state.showStatusBar);
        toggle.onChange((value) => {
          // Through commit: a blocked write used to leave the switch flipped
          // and the bar hidden with nothing on disk, and the next reload
          // silently put it back.
          this.plugin.runAsync(
            this.plugin.setShowStatusBar(value),
            "save settings",
          );
        });
      });
  }

  /**
   * Drop the editing buffer because something outside the tab changed the
   * excluded folders — a vault rename or delete, or a reload from disk. The
   * vault is authoritative over an open editor, which is the reconciliation
   * policy the rest of the plugin already follows.
   */
  invalidate(): void {
    this.debouncedCommit.cancel();
    this.drafts = null;
    if (this.containerEl.isShown()) this.display();
  }

  hide(): void {
    // Cancel before committing: a keystroke inside the debounce window leaves a
    // pending call that would otherwise fire after `drafts` is null.
    this.debouncedCommit.cancel();

    // Commit rather than prune: an edit made inside the debounce window would
    // otherwise be lost when the tab closes. Only when the rows actually
    // diverge from what the tab was given, though — an untouched tab that has
    // been open across a vault rename would otherwise write the pre-rename
    // list back over the reconciled one.
    if (this.drafts && this.drafts.join("\n") !== this.seeded.join("\n")) {
      this.commit();
    }
    this.drafts = null;
  }
}
