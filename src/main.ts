import {
  type App,
  Menu,
  Modal,
  Notice,
  type PaneType,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  type TAbstractFile,
  type TFile,
  TFolder,
} from "obsidian";
import { FolderSuggest } from "./folderSuggest";

type PluginData = {
  schemaVersion: number;
  reviewedPaths: string[];
  reviewStartedAt?: string;
  excludedFolders: string[];
  showStatusBar: boolean;
};

const CURRENT_SCHEMA_VERSION = 2;

const DEFAULT_DATA: PluginData = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  reviewedPaths: [],
  excludedFolders: [],
  showStatusBar: true,
};

export function isExcluded(
  filePath: string,
  excludedFolders: string[],
): boolean {
  return excludedFolders.some((folder) => filePath.startsWith(`${folder}/`));
}

export function computeStats(reviewedCount: number, eligibleCount: number) {
  const notReviewed = eligibleCount - reviewedCount;
  const percentCompleted = eligibleCount
    ? Math.round((reviewedCount / eligibleCount) * 100)
    : 0;

  return {
    reviewed: reviewedCount,
    eligible: eligibleCount,
    notReviewed,
    percentCompleted,
  };
}

export function rewriteReviewedPaths(
  reviewedPaths: Set<string>,
  oldPath: string,
  newPath: string,
): boolean {
  const oldPrefix = `${oldPath}/`;
  const newPrefix = `${newPath}/`;
  const toAdd: string[] = [];
  let changed = false;
  for (const p of reviewedPaths) {
    if (p.startsWith(oldPrefix)) {
      reviewedPaths.delete(p);
      toAdd.push(newPrefix + p.slice(oldPrefix.length));
      changed = true;
    }
  }
  for (const p of toAdd) {
    reviewedPaths.add(p);
  }
  return changed;
}

export function removeByPrefix(
  reviewedPaths: Set<string>,
  folderPath: string,
): boolean {
  const prefix = `${folderPath}/`;
  let changed = false;
  for (const p of reviewedPaths) {
    if (p.startsWith(prefix)) {
      reviewedPaths.delete(p);
      changed = true;
    }
  }
  return changed;
}

export default class ReviewPlugin extends Plugin {
  data!: PluginData;
  reviewedPaths!: Set<string>;
  statusBar!: StatusBar;

  onload = async () => {
    await this.loadSettings();

    this.addRibbonIcon("scan-eye", "Open review", () => {
      this.openReviewMenu();
    });

    this.statusBar = new StatusBar(this.addStatusBarItem(), this);

    this.addCommand({
      id: "open-random-unreviewed",
      name: "Open random unreviewed file",
      callback: () => this.openRandomFile(),
    });
    this.addCommand({
      id: "mark-reviewed",
      name: "Mark file as reviewed",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "not_reviewed") return false;
        if (!checking) this.markReviewed();
        return true;
      },
    });
    this.addCommand({
      id: "mark-reviewed-and-open-next",
      name: "Mark file as reviewed and open next",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "not_reviewed") return false;
        if (!checking) this.markReviewed({ openNext: true });
        return true;
      },
    });
    this.addCommand({
      id: "mark-unreviewed",
      name: "Mark file as unreviewed",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "reviewed") return false;
        if (!checking) this.markUnreviewed();
        return true;
      },
    });
    this.addCommand({
      id: "open-review-menu",
      name: "Open review menu",
      callback: () => this.openReviewMenu(),
    });

    this.addSettingTab(new ReviewSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("rename", this.handleFileRename));
    this.registerEvent(this.app.vault.on("delete", this.handleFileDelete));
    this.registerEvent(
      this.app.workspace.on("file-open", this.statusBar.update),
    );
  };

  loadSettings = async () => {
    const saved = await this.loadData();
    this.data = { ...DEFAULT_DATA, ...saved };
    // Discard old snapshot field from v1
    delete (this.data as Record<string, unknown>).snapshot;
    this.data.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.reviewedPaths = new Set(this.data.reviewedPaths);
  };

  saveSettings = async () => {
    this.data.reviewedPaths = [...this.reviewedPaths];
    await this.saveData(this.data);
  };

  onExternalSettingsChange = async () => {
    await this.loadSettings();
    this.statusBar.update();
  };

  getActiveMarkdownFile = (): TFile | null => {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile?.extension !== "md") return null;
    return activeFile;
  };

  isFileEligible = (path: string): boolean => {
    return !isExcluded(path, this.data.excludedFolders);
  };

  getEligibleFiles = (): TFile[] => {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.isFileEligible(f.path));
  };

  getActiveFileStatus = (): "reviewed" | "not_reviewed" | undefined => {
    const file = this.getActiveMarkdownFile();
    if (!file || !this.isFileEligible(file.path)) return undefined;
    return this.reviewedPaths.has(file.path) ? "reviewed" : "not_reviewed";
  };

  getUnreviewedFiles = (): TFile[] => {
    return this.getEligibleFiles().filter(
      (f) => !this.reviewedPaths.has(f.path),
    );
  };

  openReviewMenu = () => {
    new ReviewMenuModal(this.app, this).open();
  };

  openRandomFile = () => {
    const files = this.getUnreviewedFiles();
    if (!files.length) {
      new Notice("All files are reviewed");
      return;
    }
    const randomFile = files[Math.floor(Math.random() * files.length)];
    const leaf = this.app.workspace.getLeaf(false);
    leaf.openFile(randomFile);
  };

  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    this.reviewedPaths.add(file.path);
    if (!this.data.reviewStartedAt) {
      this.data.reviewStartedAt = new Date().toISOString();
    }

    this.statusBar.update();
    await this.saveSettings();

    if (openNext) this.openRandomFile();
  };

  markUnreviewed = async () => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    this.reviewedPaths.delete(file.path);
    this.statusBar.update();
    await this.saveSettings();
  };

  resetReview = async ({
    confirm = true,
  }: {
    confirm?: boolean;
  } = {}): Promise<boolean> => {
    if (confirm && !(await this.confirmReset())) return false;

    this.reviewedPaths.clear();
    this.data.reviewStartedAt = undefined;
    this.statusBar.update();
    await this.saveSettings();
    return true;
  };

  private confirmReset = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const modal = new ConfirmResetModal(this.app, resolve);
      modal.open();
    });
  };

  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
    if (file instanceof TFolder) {
      if (rewriteReviewedPaths(this.reviewedPaths, oldPath, file.path)) {
        await this.saveSettings();
      }
      return;
    }

    if (this.reviewedPaths.has(oldPath)) {
      this.reviewedPaths.delete(oldPath);
      this.reviewedPaths.add(file.path);
      await this.saveSettings();
    }
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    if (file instanceof TFolder) {
      if (removeByPrefix(this.reviewedPaths, file.path)) {
        this.statusBar.update();
        await this.saveSettings();
      }
      return;
    }

    if (this.reviewedPaths.has(file.path)) {
      this.reviewedPaths.delete(file.path);
      this.statusBar.update();
      await this.saveSettings();
    }
  };
}

class StatusBar {
  element: HTMLElement;
  plugin: ReviewPlugin;
  private statusSpan: Element;

  constructor(element: HTMLElement, plugin: ReviewPlugin) {
    this.element = element;
    this.plugin = plugin;
    this.statusSpan = element.createSpan("status");

    this.statusSpan.setText("Not reviewed");
    element.addClass("mod-clickable");
    plugin.registerDomEvent(element, "click", this.onClick);

    this.update();
  }

  update = () => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) {
      this.setIsVisible(false);
      return;
    }

    this.setIsVisible(this.plugin.data.showStatusBar);

    if (status === "reviewed") {
      this.statusSpan.setText("Reviewed");
    } else {
      this.statusSpan.setText("Not reviewed");
    }
  };

  private onClick = (event: MouseEvent) => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) return;

    const isReviewed = status === "reviewed";
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle("Reviewed");
      item.setChecked(isReviewed);
      item.onClick(() => this.plugin.markReviewed());
    });
    menu.addItem((item) => {
      item.setTitle("Not reviewed");
      item.setChecked(!isReviewed);
      item.onClick(() => this.plugin.markUnreviewed());
    });

    menu.showAtMouseEvent(event);
  };

  private setIsVisible = (isVisible: boolean) => {
    this.element.toggleClass("is-hidden", !isVisible);
  };
}

class ReviewSettingTab extends PluginSettingTab {
  plugin: ReviewPlugin;

  constructor(app: App, plugin: ReviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Review section
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
      btn.onClick(async () => {
        await this.plugin.resetReview();
        this.display();
      });
    });

    // Stats
    const eligible = this.plugin.getEligibleFiles();
    const reviewedCount = eligible.filter((f) =>
      this.plugin.reviewedPaths.has(f.path),
    ).length;
    const stats = computeStats(reviewedCount, eligible.length);

    containerEl.createDiv("review-stats", (div) => {
      div.createEl("p").setText(`Eligible files: ${stats.eligible}`);
      div
        .createEl("p")
        .setText(`Reviewed: ${stats.reviewed} (${stats.percentCompleted}%)`);
      div.createEl("p").setText(`Not reviewed: ${stats.notReviewed}`);
    });

    // Excluded folders
    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Files in these folders will not appear in review.");

    for (let i = 0; i < this.plugin.data.excludedFolders.length; i++) {
      new Setting(containerEl)
        .addText((text) => {
          text.setValue(this.plugin.data.excludedFolders[i]);
          text.onChange(async (value) => {
            this.plugin.data.excludedFolders[i] = value.replace(/\/+$/, "");
            this.plugin.statusBar.update();
            await this.plugin.saveSettings();
          });
          new FolderSuggest(this.app, text.inputEl, async (value) => {
            this.plugin.data.excludedFolders[i] = value.replace(/\/+$/, "");
            this.plugin.statusBar.update();
            await this.plugin.saveSettings();
          });
        })
        .addButton((btn) => {
          btn.setIcon("trash");
          btn.onClick(async () => {
            this.plugin.data.excludedFolders.splice(i, 1);
            this.plugin.statusBar.update();
            await this.plugin.saveSettings();
            this.display();
          });
        });
    }

    new Setting(containerEl).addButton((btn) => {
      btn.setButtonText("Add excluded folder");
      btn.onClick(async () => {
        this.plugin.data.excludedFolders.push("");
        await this.plugin.saveSettings();
        this.display();
      });
    });

    // Status bar toggle
    new Setting(containerEl)
      .setName("Status bar")
      .setDesc("Show file review status in the status bar.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.data.showStatusBar);
        toggle.onChange(async (value) => {
          this.plugin.data.showStatusBar = value;
          this.plugin.statusBar.update();
          await this.plugin.saveSettings();
        });
      });
  }
}

class ConfirmSnapshotDeleteModal extends Modal {
  constructor(app: App, resolve: (confirmed: boolean) => void) {
    super(app);

    this.setTitle("Delete snapshot?");

    new Setting(this.contentEl)
      .setName("This action cannot be undone")
      .setDesc(
        "You will lose all progress and will need to create a new snapshot.",
      )
      .addButton((btn) => {
        btn.setButtonText("Cancel");
        btn.onClick(() => {
          settled = true;
          resolve(false);
          this.close();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Delete");
        btn.setWarning();
        btn.onClick(() => {
          settled = true;
          resolve(true);
          this.close();
        });
      });

    let settled = false;
    this.onClose = () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    };
  }
}

type ReviewCommand = { id: string; name: string };

const STATUS_DESCRIPTIONS: Partial<Record<DisplayStatus, string>> = {
  new: "This file is not in snapshot",
  to_review: "This file is not reviewed",
  reviewed: "This file is reviewed",
};

class ReviewMenuModal extends SuggestModal<ReviewCommand> {
  plugin: ReviewPlugin;

  constructor(app: App, plugin: ReviewPlugin) {
    super(app);
    this.plugin = plugin;

    const fileStatus = this.plugin.getActiveFileStatus();
    this.setPlaceholder(
      fileStatus ? (STATUS_DESCRIPTIONS[fileStatus] ?? "") : "",
    );
  }

  getSuggestions = (query: string): ReviewCommand[] => {
    const activeFile = this.plugin.getActiveMarkdownFile();
    let suggestions: ReviewCommand[];

    if (!activeFile) {
      suggestions = [
        { id: "open_random", name: "Open random unreviewed file" },
      ];
    } else {
      const isReviewed =
        this.plugin.getSnapshotFile(activeFile.path)?.status === "reviewed";

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
        this.plugin.openRandomFile();
        break;
      case "review":
        this.plugin.markReviewed();
        break;
      case "review_and_next":
        this.plugin.markReviewed({ openNext: true });
        break;
      case "unreview":
        this.plugin.markUnreviewed();
        break;
    }
  };
}
