import {
  Notice,
  Plugin,
  type TAbstractFile,
  type TFile,
  TFolder,
} from "obsidian";
import { ConfirmResetModal, ReviewMenuModal } from "./modals";
import { isExcluded, ReviewState, type ReviewStats } from "./reviewState";
import { ReviewSettingTab } from "./settingsTab";
import { StatusBar } from "./statusBar";

export type PluginData = {
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

export default class ReviewPlugin extends Plugin {
  data!: PluginData;
  private state = new ReviewState();
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
    // Migrate showStatusBar from pre-1.2 nested settings shape
    if (
      saved?.settings?.showStatusBar !== undefined &&
      saved.showStatusBar === undefined
    ) {
      this.data.showStatusBar = saved.settings.showStatusBar;
    }
    delete (this.data as Record<string, unknown>).settings;
    delete (this.data as Record<string, unknown>).snapshot;
    this.data.schemaVersion = CURRENT_SCHEMA_VERSION;
    this.state.load(this.data.reviewedPaths, this.data.reviewStartedAt);
  };

  saveSettings = async () => {
    this.data.reviewedPaths = [...this.state.reviewedPaths];
    this.data.reviewStartedAt = this.state.reviewStartedAt;
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
    return this.isReviewed(file.path) ? "reviewed" : "not_reviewed";
  };

  isReviewed = (path: string): boolean => {
    return this.state.isReviewed(path);
  };

  getStats = (): ReviewStats => {
    return this.state.stats(this.getEligibleFiles().map((f) => f.path));
  };

  openReviewMenu = () => {
    new ReviewMenuModal(this.app, this).open();
  };

  openRandomFile = () => {
    const eligible = this.getEligibleFiles();
    const path = this.state.pickRandomUnreviewed(eligible.map((f) => f.path));
    const randomFile = eligible.find((f) => f.path === path);
    if (!randomFile) {
      new Notice("All files are reviewed");
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    leaf.openFile(randomFile);
  };

  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    this.state.markReviewed(file.path);
    this.statusBar.update();
    await this.saveSettings();

    if (openNext) this.openRandomFile();
  };

  markUnreviewed = async () => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    this.state.markUnreviewed(file.path);
    this.statusBar.update();
    await this.saveSettings();
  };

  resetReview = async ({
    confirm = true,
  }: {
    confirm?: boolean;
  } = {}): Promise<boolean> => {
    if (confirm && !(await this.confirmReset())) return false;

    this.state.reset();
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
    const changed =
      file instanceof TFolder
        ? this.state.renameFolder(oldPath, file.path)
        : this.state.renameFile(oldPath, file.path);
    if (changed) await this.saveSettings();
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    const changed =
      file instanceof TFolder
        ? this.state.deleteFolder(file.path)
        : this.state.deleteFile(file.path);
    if (changed) {
      this.statusBar.update();
      await this.saveSettings();
    }
  };
}
