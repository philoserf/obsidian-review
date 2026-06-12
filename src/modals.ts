import { type App, Modal, Setting, SuggestModal } from "obsidian";
import type ReviewPlugin from "./plugin";

export class ConfirmResetModal extends Modal {
  constructor(app: App, resolve: (confirmed: boolean) => void) {
    super(app);

    this.setTitle("Reset review?");

    let settled = false;

    new Setting(this.contentEl)
      .setName("This action cannot be undone")
      .setDesc("All review progress will be lost.")
      .addButton((btn) => {
        btn.setButtonText("Cancel");
        btn.onClick(() => {
          settled = true;
          resolve(false);
          this.close();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Reset");
        btn.setWarning();
        btn.onClick(() => {
          settled = true;
          resolve(true);
          this.close();
        });
      });

    this.onClose = () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };
  }
}

type ReviewCommand = { id: string; name: string };

export class ReviewMenuModal extends SuggestModal<ReviewCommand> {
  plugin: ReviewPlugin;

  constructor(app: App, plugin: ReviewPlugin) {
    super(app);
    this.plugin = plugin;

    const status = this.plugin.getActiveFileStatus();
    if (status === "reviewed") {
      this.setPlaceholder("This file is reviewed");
    } else if (status === "not_reviewed") {
      this.setPlaceholder("This file is not reviewed");
    }
  }

  getSuggestions = (query: string): ReviewCommand[] => {
    const file = this.plugin.getActiveMarkdownFile();
    let suggestions: ReviewCommand[];

    if (!file || !this.plugin.isFileEligible(file.path)) {
      suggestions = [
        { id: "open_random", name: "Open random unreviewed file" },
      ];
    } else {
      const isReviewed = this.plugin.isReviewed(file.path);

      if (isReviewed) {
        suggestions = [
          { id: "open_random", name: "Open random unreviewed file" },
          { id: "unreview", name: "Mark file as unreviewed" },
        ];
      } else {
        suggestions = [
          {
            id: "review_and_next",
            name: "Mark file as reviewed and open next",
          },
          { id: "review", name: "Mark file as reviewed" },
          { id: "open_random", name: "Open random unreviewed file" },
        ];
      }
    }

    return suggestions.filter((s) =>
      s.name.toLowerCase().includes(query.toLowerCase()),
    );
  };

  renderSuggestion = (suggestion: ReviewCommand, el: HTMLElement) => {
    el.createEl("div", { text: suggestion.name });
  };

  onChooseSuggestion = (suggestion: ReviewCommand) => {
    switch (suggestion.id) {
      case "open_random":
        this.plugin.runAsync(this.plugin.openRandomFile(), "open random file");
        break;
      case "review":
        this.plugin.runAsync(this.plugin.markReviewed(), "mark reviewed");
        break;
      case "review_and_next":
        this.plugin.runAsync(
          this.plugin.markReviewed({ openNext: true }),
          "mark reviewed",
        );
        break;
      case "unreview":
        this.plugin.runAsync(this.plugin.markUnreviewed(), "mark unreviewed");
        break;
    }
  };
}
