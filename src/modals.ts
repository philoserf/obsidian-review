import {
  type App,
  FuzzySuggestModal,
  Modal,
  Setting,
  SuggestModal,
  type TFolder,
} from "obsidian";
import { availableCommands, type ReviewCommand } from "./commands";
import type ReviewPlugin from "./main";

export class ConfirmResetModal extends Modal {
  private confirmed = false;
  private resolve: (confirmed: boolean) => void;

  constructor(app: App, resolve: (confirmed: boolean) => void) {
    super(app);
    this.resolve = resolve;

    this.setTitle("Reset review?");

    new Setting(this.contentEl)
      .setName("This action cannot be undone")
      .setDesc("All review progress will be lost.")
      .addButton((btn) => {
        btn.setButtonText("Cancel");
        btn.onClick(() => this.close());
      })
      .addButton((btn) => {
        btn.setButtonText("Reset");
        btn.setWarning();
        btn.onClick(() => {
          this.confirmed = true;
          this.close();
        });
      });
  }

  // The one settlement site. close() always runs onClose, whether it came from
  // a button, Escape, or a click outside, so every dismissal lands here.
  override onClose(): void {
    super.onClose();
    this.resolve(this.confirmed);
  }
}

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
    return availableCommands(this.plugin.getActiveFileStatus()).filter((c) =>
      c.name.toLowerCase().includes(query.toLowerCase()),
    );
  };

  renderSuggestion = (suggestion: ReviewCommand, el: HTMLElement) => {
    el.createEl("div", { text: suggestion.name });
  };

  onChooseSuggestion = (command: ReviewCommand) => {
    this.plugin.runAsync(command.run(this.plugin), command.label);
  };
}

/** Picks a folder to exclude from review. The vault root is not offered:
 * excluding it would exclude everything. */
export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  private onPick: (path: string) => void;

  constructor(app: App, onPick: (path: string) => void) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder("Folder to exclude from review");
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllFolders(false);
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onPick(folder.path);
  }
}
