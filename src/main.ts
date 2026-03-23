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

type PluginData = {
  snapshot?: Snapshot;
  showStatusBar: boolean;
};

export type SnapshotFile = {
  path: string;
  status: SnapshotFileStatus;
};

type Snapshot = {
  files: SnapshotFile[];
  createdAt: Date;
};

type FileStatus = "new" | "to_review" | "reviewed" | "deleted";

export type SnapshotFileStatus = Exclude<FileStatus, "new">;

const DEFAULT_SETTINGS: PluginData = {
  showStatusBar: true,
};

export function computeStats(
  snapshotFiles: SnapshotFile[],
  allVaultFilesCount: number,
) {
  const total = snapshotFiles.length;
  const deleted = snapshotFiles.filter((f) => f.status === "deleted").length;
  const reviewed = snapshotFiles.filter((f) => f.status === "reviewed").length;
  const toReview = total - reviewed - deleted;
  const active = total - deleted;
  const percentCompleted = active ? Math.round((reviewed / active) * 100) : 0;
  const percentDeleted = total ? Math.round((deleted / total) * 100) : 0;
  const notInSnapshot = allVaultFilesCount - total + deleted;

  return {
    total,
    deleted,
    reviewed,
    toReview,
    active,
    percentCompleted,
    percentDeleted,
    notInSnapshot,
  };
}

export default class ReviewPlugin extends Plugin {
  data!: PluginData;

  statusBar!: StatusBar;

  onload = async () => {
    await this.loadSettings();

    // Ribbon
    this.addRibbonIcon("scan-eye", "Open review", () => {
      this.openFileStatusController();
    });

    // Status bar
    this.statusBar = new StatusBar(this.addStatusBarItem(), this);

    // Commands
    this.addCommand({
      id: "open-random-file",
      name: "Open random not reviewed file",
      callback: () => {
        this.openRandomFile();
      },
    });
    this.addCommand({
      id: "complete-review",
      name: "Review file",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "to_review";
        }

        this.completeReview();
      },
    });
    this.addCommand({
      id: "complete-review-and-open-next",
      name: "Review file and open next random file",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "to_review";
        }

        this.completeReview({ openNext: true });
      },
    });
    this.addCommand({
      id: "unreview-file",
      name: "Unreview file",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "reviewed";
        }

        this.unreviewFile();
      },
    });

    // Settings
    this.addSettingTab(new ReviewSettingTab(this.app, this));

    // Events
    this.registerEvent(this.app.vault.on("rename", this.handleFileRename));
    this.registerEvent(this.app.vault.on("delete", this.handleFileDelete));
    this.registerEvent(
      this.app.workspace.on("file-open", this.statusBar.update),
    );
  };

  loadSettings = async () => {
    const saved = await this.loadData();
    this.data = {
      ...DEFAULT_SETTINGS,
      ...saved,
    };

    if (typeof this.data.snapshot?.createdAt === "string") {
      this.data.snapshot.createdAt = new Date(this.data.snapshot.createdAt);
    }
  };

  saveSettings = async () => {
    await this.saveData(this.data);
  };

  onExternalSettingsChange = async () => {
    await this.loadSettings();
    this.statusBar.update();
  };

  getActiveFile = (): TFile | null => {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile?.extension !== "md") {
      return null;
    }
    return activeFile;
  };

  getSnapshotFile = (path?: string) => {
    path = path ?? this.getActiveFile()?.path;
    if (!path) {
      return;
    }

    return this.data.snapshot?.files.find((f) => f.path === path);
  };

  getActiveFileStatus = (): FileStatus | undefined => {
    const activeFile = this.getActiveFile();
    if (!activeFile) {
      return;
    }

    return this.getSnapshotFile(activeFile.path)?.status ?? "new";
  };

  getToReviewFiles = () => {
    return (
      this.data.snapshot?.files.filter((file) => file.status === "to_review") ??
      []
    );
  };

  openFileStatusController = () => {
    if (!this.data.snapshot) {
      new Notice("Vault review snapshot is not created");
      return;
    }

    new FileStatusControllerModal(this.app, this).open();
  };

  openRandomFile = () => {
    if (!this.data.snapshot) {
      new Notice("Vault review snapshot is not created");
      return;
    }

    const files = this.getToReviewFiles();
    if (!files.length) {
      new Notice("All files are reviewed");
      return;
    }

    const randomFile = files[Math.floor(Math.random() * files.length)];
    this.focusFile(randomFile, false);
  };

  private focusFile = async (
    file: SnapshotFile,
    newLeaf: boolean | PaneType,
  ) => {
    const targetFile = this.app.vault.getFileByPath(file.path);

    if (targetFile) {
      const leaf = this.app.workspace.getLeaf(newLeaf);
      leaf.openFile(targetFile);
    } else {
      new Notice(`Cannot find a file ${file.path}`);
      if (this.data.snapshot) {
        this.data.snapshot.files = this.data.snapshot.files.filter(
          (fp) => fp.path !== file.path,
        );
        this.statusBar.update();
        await this.saveSettings();
      }
    }
  };

  completeReview = async ({
    file,
    openNext = false,
  }: {
    file?: SnapshotFile;
    openNext?: boolean;
  } = {}) => {
    const activeFile = file ?? this.getActiveFile();
    if (!activeFile) {
      return;
    }

    const snapshotFile = this.getSnapshotFile(activeFile.path);

    if (!snapshotFile) {
      new Notice("File was added to snapshot and marked as reviewed");
      this.data.snapshot?.files.push({
        path: activeFile.path,
        status: "reviewed",
      });
    } else {
      snapshotFile.status = "reviewed";
    }

    if (openNext) {
      this.openRandomFile();
    }

    this.statusBar.update();
    await this.saveSettings();
  };

  unreviewFile = async (file?: SnapshotFile) => {
    const activeFile = file ?? this.getActiveFile();
    if (!activeFile) {
      return;
    }

    const snapshotFile = this.getSnapshotFile(activeFile.path);

    if (!snapshotFile) {
      new Notice("File was added to snapshot and marked as not reviewed");
      this.data.snapshot?.files.push({
        path: activeFile.path,
        status: "to_review",
      });
    } else {
      snapshotFile.status = "to_review";
    }

    this.statusBar.update();
    await this.saveSettings();
  };

  deleteSnapshot = async ({
    confirm = true,
  }: {
    confirm?: boolean;
  } = {}): Promise<boolean> => {
    if (confirm && !(await this.confirmDelete())) {
      return false;
    }

    this.data.snapshot = undefined;
    this.statusBar.update();
    await this.saveSettings();
    return true;
  };

  private confirmDelete = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const modal = new ConfirmSnapshotDeleteModal(this.app, resolve);
      modal.open();
    });
  };

  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
    if (file instanceof TFolder) {
      return;
    }

    const snapshotFile = this.getSnapshotFile(oldPath);
    if (snapshotFile) {
      snapshotFile.path = file.path;
      await this.saveSettings();
    }
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    if (file instanceof TFolder || !this.data.snapshot) {
      return;
    }

    const snapshotFile = this.getSnapshotFile(file.path);
    if (snapshotFile) {
      snapshotFile.status = "deleted";
      this.statusBar.update();
      await this.saveSettings();
    }
  };
}

class StatusBar {
  element: HTMLElement;
  plugin: ReviewPlugin;

  isReviewed = false;

  constructor(element: HTMLElement, plugin: ReviewPlugin) {
    this.element = element;
    this.plugin = plugin;

    element.createSpan("status").setText("Not reviewed");
    element.addClass("mod-clickable");
    element.addEventListener("click", this.onClick);

    this.update();
  }

  update = () => {
    if (!this.plugin.data.snapshot) {
      this.setIsVisible(false);
      return;
    }

    const activeFileStatus = this.plugin.getActiveFileStatus();
    if (!activeFileStatus || activeFileStatus === "deleted") {
      this.setIsVisible(false);
      return;
    }

    this.setIsVisible(this.plugin.data.showStatusBar);
    this.isReviewed = activeFileStatus === "reviewed";

    if (activeFileStatus === "new") {
      this.setText("New file");
    } else if (activeFileStatus === "to_review") {
      this.setText("Not reviewed");
    } else if (activeFileStatus === "reviewed") {
      this.setText("Reviewed");
    } else {
      this.setText("Unknown status");
    }
  };

  private onClick = (event: MouseEvent) => {
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle("Reviewed");
      item.setChecked(this.isReviewed);
      item.onClick(() => this.plugin.completeReview());
    });
    menu.addItem((item) => {
      item.setTitle("Not reviewed");
      item.setChecked(!this.isReviewed);
      item.onClick(() => this.plugin.unreviewFile());
    });

    menu.showAtMouseEvent(event);
  };

  private setText = (text: string) => {
    this.element.getElementsByClassName("status")[0].setText(text);
  };

  private setIsVisible = (isVisible: boolean) => {
    this.element.toggleClass("hidden", !isVisible);
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

    const snapshot = this.plugin.data.snapshot;

    // Main action
    const settingEl = new Setting(containerEl)
      .setName("Snapshot")
      .setDesc(
        snapshot?.createdAt
          ? `Snapshot created on ${snapshot?.createdAt.toLocaleDateString()}.`
          : "Create a snapshot of the vault.",
      );
    if (snapshot) {
      settingEl.addButton((btn) => {
        btn.setIcon("trash");
        btn.setWarning();
        btn.onClick(async () => {
          await this.plugin.deleteSnapshot();
          this.display();
        });
      });
      settingEl.addButton((btn) => {
        btn.setButtonText("Add all new files to snapshot").onClick(async () => {
          const vaultFiles = this.plugin.app.vault
            .getMarkdownFiles()
            .filter(
              (file) =>
                !this.plugin.data.snapshot?.files.some(
                  (f) => f.path === file.path,
                ),
            )
            .map(
              (file): SnapshotFile => ({
                path: file.path,
                status: "to_review",
              }),
            );
          this.plugin.data.snapshot?.files.push(...vaultFiles);
          this.plugin.statusBar.update();
          this.display();
          await this.plugin.saveSettings();
        });
      });
    } else {
      settingEl.addButton((btn) => {
        btn.setButtonText("Create snapshot");
        btn.setCta();
        btn.onClick(async () => {
          const files = this.plugin.app.vault.getMarkdownFiles().map(
            (file): SnapshotFile => ({
              path: file.path,
              status: "to_review",
            }),
          );
          this.plugin.data.snapshot = {
            files,
            createdAt: new Date(),
          };
          this.plugin.statusBar.update();
          this.display();
          await this.plugin.saveSettings();
        });
      });
    }

    // Snapshot info
    if (snapshot) {
      containerEl.createDiv("snapshot-info", (div) => {
        const allFilesLength = this.plugin.app.vault.getMarkdownFiles().length;
        const stats = computeStats(snapshot.files, allFilesLength);

        div.createEl("p").setText(`Markdown files in vault: ${allFilesLength}`);

        const inSnapshotEl = div.createEl("p", "in-snapshot");
        inSnapshotEl.createSpan().setText(`In snapshot: ${stats.total}`);
        inSnapshotEl.createSpan().setText(`To review: ${stats.toReview}`);
        inSnapshotEl
          .createSpan()
          .setText(`Reviewed: ${stats.reviewed} (${stats.percentCompleted}%)`);
        inSnapshotEl
          .createSpan()
          .setText(`Deleted: ${stats.deleted} (${stats.percentDeleted}%)`);

        div.createEl("p").setText(`Not in snapshot: ${stats.notInSnapshot}`);
      });
    }

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
          resolve(false);
          this.close();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Delete");
        btn.setWarning();
        btn.onClick(() => {
          resolve(true);
          this.close();
        });
      });

    this.onClose = () => resolve(false);
  }
}

type Suggestion = { id: string; name: string };

const PLACEHOLDER: Record<string, string> = {
  new: "This file is not in snapshot",
  to_review: "This file is not reviewed",
  reviewed: "This file is reviewed",
};

class FileStatusControllerModal extends SuggestModal<Suggestion> {
  plugin: ReviewPlugin;

  constructor(app: App, plugin: ReviewPlugin) {
    super(app);
    this.plugin = plugin;

    const fileStatus = this.plugin.getActiveFileStatus();
    this.setPlaceholder(fileStatus ? (PLACEHOLDER[fileStatus] ?? "") : "");
  }

  getSuggestions = (query: string): Suggestion[] => {
    const activeFile = this.plugin.getActiveFile();
    let suggestions: Suggestion[];

    if (!activeFile) {
      suggestions = [
        { id: "open_random", name: "Open random not reviewed file" },
      ];
    } else {
      const isReviewed =
        this.plugin.getSnapshotFile(activeFile.path)?.status === "reviewed";

      if (isReviewed) {
        suggestions = [
          { id: "open_random", name: "Open random not reviewed file" },
          { id: "unreview", name: "Unreview file" },
        ];
      } else {
        suggestions = [
          {
            id: "review_and_next",
            name: "Review file and open next random file",
          },
          { id: "review", name: "Review file" },
          { id: "open_random", name: "Open random not reviewed file" },
        ];
      }
    }

    return suggestions.filter((s) =>
      s.name.toLowerCase().includes(query.toLowerCase()),
    );
  };

  renderSuggestion = (suggestion: Suggestion, el: HTMLElement) => {
    el.createEl("div", { text: suggestion.name });
  };

  onChooseSuggestion = (suggestion: Suggestion) => {
    switch (suggestion.id) {
      case "open_random":
        this.plugin.openRandomFile();
        break;
      case "review":
        this.plugin.completeReview();
        break;
      case "review_and_next":
        this.plugin.completeReview({ openNext: true });
        break;
      case "unreview":
        this.plugin.unreviewFile();
        break;
    }
  };
}
