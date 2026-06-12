import { type App, debounce, PluginSettingTab, Setting } from "obsidian";
import { FolderSuggest } from "./folderSuggest";
import type ReviewPlugin from "./plugin";

export class ReviewSettingTab extends PluginSettingTab {
  plugin: ReviewPlugin;
  private debouncedSave = debounce(
    () => this.plugin.runAsync(this.plugin.saveSettings(), "save settings"),
    500,
    true,
  );

  constructor(app: App, plugin: ReviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const reviewSetting = new Setting(containerEl)
      .setName("Review")
      .setDesc(
        this.plugin.data.reviewStartedAt
          ? `Review started on ${new Date(this.plugin.data.reviewStartedAt).toLocaleDateString()}.`
          : "No active review.",
      );
    reviewSetting.addButton((btn) => {
      btn.setButtonText("Reset review");
      btn.setWarning();
      btn.onClick(() =>
        this.plugin.runAsync(
          this.plugin.resetReview().then(() => this.display()),
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

    for (let i = 0; i < this.plugin.data.excludedFolders.length; i++) {
      const applyFolder = (value: string) => {
        this.plugin.data.excludedFolders[i] = value.replace(/\/+$/, "");
        this.plugin.statusBar.update();
      };
      new Setting(containerEl)
        .setClass("review-excluded-folder")
        .addText((text) => {
          text.setValue(this.plugin.data.excludedFolders[i]);
          text.onChange((value) => {
            applyFolder(value);
            this.debouncedSave();
          });
          new FolderSuggest(this.app, text.inputEl, (value) => {
            applyFolder(value);
            this.plugin.runAsync(this.plugin.saveSettings(), "save settings");
          });
        })
        .addButton((btn) => {
          btn.setIcon("trash");
          btn.onClick(() => {
            this.plugin.data.excludedFolders.splice(i, 1);
            this.plugin.statusBar.update();
            this.plugin.runAsync(this.plugin.saveSettings(), "save settings");
            this.display();
          });
        });
    }

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText("Add excluded folder");
      btn.onClick(() => {
        // Not persisted yet — typing in the new row saves it, and hide()
        // prunes rows left empty.
        this.plugin.data.excludedFolders.push("");
        this.display();
      });
    });

    new Setting(containerEl)
      .setName("Status bar")
      .setDesc("Show file review status in the status bar.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.data.showStatusBar);
        toggle.onChange((value) => {
          this.plugin.data.showStatusBar = value;
          this.plugin.statusBar.update();
          this.plugin.runAsync(this.plugin.saveSettings(), "save settings");
        });
      });
  }

  hide(): void {
    const folders = this.plugin.data.excludedFolders;
    const pruned = folders.filter((folder) => folder !== "");
    if (pruned.length !== folders.length) {
      this.plugin.data.excludedFolders = pruned;
      this.plugin.runAsync(this.plugin.saveSettings(), "save settings");
    }
  }
}
