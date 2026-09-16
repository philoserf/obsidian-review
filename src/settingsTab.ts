import { type App, debounce, PluginSettingTab, Setting } from "obsidian";
import { FolderSuggest } from "./folderSuggest";
import type ReviewPlugin from "./plugin";
import { setShowStatusBar } from "./review";

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

    if (!this.drafts) {
      this.drafts = [...this.plugin.state.excludedFolders];
    }
    const drafts = this.drafts;

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
          this.plugin.store.setState(
            setShowStatusBar(this.plugin.state, value),
          );
          this.plugin.runAsync(this.plugin.saveSettings(), "save settings");
        });
      });
  }

  hide(): void {
    // Cancel before committing: a keystroke inside the debounce window leaves a
    // pending call that would otherwise fire after `drafts` is null.
    this.debouncedCommit.cancel();

    // Commit rather than prune: an edit made inside the debounce window would
    // otherwise be lost when the tab closes.
    this.commit();
    this.drafts = null;
  }
}
