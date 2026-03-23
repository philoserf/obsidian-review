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
  schemaVersion: number;
  snapshot?: Snapshot;
  showStatusBar: boolean;
};

export type SnapshotFile = {
  path: string;
  status: ReviewStatus;
};

type Snapshot = {
  files: SnapshotFile[];
  createdAt: Date;
};

export type ReviewStatus = "to_review" | "reviewed" | "deleted";

type DisplayStatus = ReviewStatus | "new";

const CURRENT_SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS: PluginData = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
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

export function rewritePaths(
  files: SnapshotFile[],
  oldPath: string,
  newPath: string,
): boolean {
  const oldPrefix = `${oldPath}/`;
  const newPrefix = `${newPath}/`;
  let changed = false;
  for (const f of files) {
    if (f.path.startsWith(oldPrefix)) {
      f.path = newPrefix + f.path.slice(oldPrefix.length);
      changed = true;
    }
  }
  return changed;
}

export function markFolderDeleted(
  files: SnapshotFile[],
  folderPath: string,
): boolean {
  const prefix = `${folderPath}/`;
  let changed = false;
  for (const f of files) {
    if (f.path.startsWith(prefix) && f.status !== "deleted") {
      f.status = "deleted";
      changed = true;
    }
  }
  return changed;
}

export default class ReviewPlugin extends Plugin {
  data!: PluginData;

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
      callback: () => {
        this.openRandomFile();
      },
    });
    this.addCommand({
      id: "mark-reviewed",
      name: "Mark file as reviewed",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "to_review";
        }

        this.markReviewed();
      },
    });
    this.addCommand({
      id: "mark-reviewed-and-open-next",
      name: "Mark file as reviewed and open next",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "to_review";
        }

        this.markReviewed({ openNext: true });
      },
    });
    this.addCommand({
      id: "mark-unreviewed",
      name: "Mark file as unreviewed",
      checkCallback: (checking) => {
        if (checking) {
          return this.getActiveFileStatus() === "reviewed";
        }

        this.markUnreviewed();
      },
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
    this.data = {
      ...DEFAULT_SETTINGS,
      ...saved,
    };

    // Migrate from pre-1.2 nested settings shape
    if (
      saved?.settings?.showStatusBar !== undefined &&
      saved.showStatusBar === undefined
    ) {
      this.data.showStatusBar = saved.settings.showStatusBar;
    }
    delete (this.data as Record<string, unknown>).settings;

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

  getActiveMarkdownFile = (): TFile | null => {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile?.extension !== "md") {
      return null;
    }
    return activeFile;
  };

  getSnapshotFile = (path: string) => {
    return this.data.snapshot?.files.find((f) => f.path === path);
  };

  getActiveFileStatus = (): DisplayStatus | undefined => {
    const activeFile = this.getActiveMarkdownFile();
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

  openReviewMenu = () => {
    if (!this.data.snapshot) {
      new Notice("Vault review snapshot is not created");
      return;
    }

    new ReviewMenuModal(this.app, this).open();
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
      new Notice(`Cannot find file: ${file.path}`);
      const snapshotFile = this.getSnapshotFile(file.path);
      if (snapshotFile) {
        snapshotFile.status = "deleted";
        this.statusBar.update();
        await this.saveSettings();
      }
    }
  };

  markReviewed = async ({
    file,
    openNext = false,
  }: {
    file?: SnapshotFile;
    openNext?: boolean;
  } = {}) => {
    const activeFile = file ?? this.getActiveMarkdownFile();
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

  markUnreviewed = async (file?: SnapshotFile) => {
    const activeFile = file ?? this.getActiveMarkdownFile();
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
    if (!this.data.snapshot) return;

    if (file instanceof TFolder) {
      if (rewritePaths(this.data.snapshot.files, oldPath, file.path)) {
        await this.saveSettings();
      }
      return;
    }

    const snapshotFile = this.getSnapshotFile(oldPath);
    if (snapshotFile) {
      snapshotFile.path = file.path;
      await this.saveSettings();
    }
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    if (!this.data.snapshot) {
      return;
    }

    if (file instanceof TFolder) {
      if (markFolderDeleted(this.data.snapshot.files, file.path)) {
        this.statusBar.update();
        await this.saveSettings();
      }
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
  private statusSpan: Element;

  constructor(element: HTMLElement, plugin: ReviewPlugin) {
    this.element = element;
    this.plugin = plugin;
    this.statusSpan = element.createSpan("status");

    this.statusSpan.setText("Not reviewed");
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

    if (activeFileStatus === "new") {
      this.statusSpan.setText("New file");
    } else if (activeFileStatus === "to_review") {
      this.statusSpan.setText("Not reviewed");
    } else if (activeFileStatus === "reviewed") {
      this.statusSpan.setText("Reviewed");
    } else {
      this.statusSpan.setText("Unknown status");
    }
  };

  private onClick = (event: MouseEvent) => {
    const isReviewed = this.plugin.getActiveFileStatus() === "reviewed";
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

    const snapshot = this.plugin.data.snapshot;

    // Main action
    const settingEl = new Setting(containerEl)
      .setName("Snapshot")
      .setDesc(
        snapshot?.createdAt
          ? `Snapshot created on ${snapshot.createdAt.toLocaleDateString()}.`
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
