import {
  Notice,
  Plugin,
  type TAbstractFile,
  type TFile,
  TFolder,
} from "obsidian";
import { ConfirmResetModal, ReviewMenuModal } from "./modals";
import {
  isEligible,
  isReviewed,
  markReviewed,
  markUnreviewed,
  type PluginState,
  type ReviewStats,
  removePath,
  renamePath,
  reset,
  setExcludedFolders,
  stats,
} from "./review";
import { ReviewSettingTab } from "./settingsTab";
import { StatusBar } from "./statusBar";
import { Store } from "./store";

export default class ReviewPlugin extends Plugin {
  statusBar!: StatusBar;

  /**
   * Owns the persisted document, the write fence and the write queue. It takes
   * loadData/saveData/Notice/console as plain functions, which is what makes
   * the save path — the plugin's densest code — reachable from a test.
   */
  readonly store = new Store({
    load: () => this.loadData(),
    save: (data) => this.saveData(data),
    notify: (message) => new Notice(message),
    log: (message, err) => console.error(`[review] ${message}`, err),
    warn: (message) => console.warn(`[review] ${message}`),
    onChange: () => this.statusBar?.update(),
  });

  /** The persisted document. Read-only here; the store owns replacement. */
  get state(): PluginState {
    return this.store.state;
  }

  /**
   * Fire-and-forget bridge for UI callbacks that cannot await: surfaces
   * rejections via Notice instead of letting them vanish.
   */
  runAsync = (promise: Promise<unknown>, label: string) => {
    promise.catch((err) => {
      console.error(`[review] ${label} failed`, err);
      new Notice(`Review: ${label} failed — see console for details.`);
    });
  };

  onload = async () => {
    await this.loadSettings();

    this.addRibbonIcon("scan-eye", "Open review", () => {
      this.openReviewMenu();
    });

    this.statusBar = new StatusBar(this.addStatusBarItem(), this);

    this.addCommand({
      id: "open-random-unreviewed",
      name: "Open random unreviewed file",
      callback: () => this.runAsync(this.openRandomFile(), "open random file"),
    });
    this.addCommand({
      id: "mark-reviewed",
      name: "Mark file as reviewed",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "not_reviewed") return false;
        if (!checking) this.runAsync(this.markReviewed(), "mark reviewed");
        return true;
      },
    });
    this.addCommand({
      id: "mark-reviewed-and-open-next",
      name: "Mark file as reviewed and open next",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "not_reviewed") return false;
        if (!checking)
          this.runAsync(this.markReviewed({ openNext: true }), "mark reviewed");
        return true;
      },
    });
    this.addCommand({
      id: "mark-unreviewed",
      name: "Mark file as unreviewed",
      checkCallback: (checking) => {
        if (this.getActiveFileStatus() !== "reviewed") return false;
        if (!checking) this.runAsync(this.markUnreviewed(), "mark unreviewed");
        return true;
      },
    });
    this.addCommand({
      id: "open-review-menu",
      name: "Open review menu",
      callback: () => this.openReviewMenu(),
    });

    this.addSettingTab(new ReviewSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        this.runAsync(
          this.handleFileRename(file, oldPath),
          "update review state after rename",
        ),
      ),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) =>
        this.runAsync(
          this.handleFileDelete(file),
          "update review state after delete",
        ),
      ),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", this.statusBar.update),
    );
  };

  loadSettings = () => this.store.reload();

  saveSettings = () => this.store.save();

  onExternalSettingsChange = async () => {
    // Settle any in-flight write first. Queued writes carry a snapshot taken at
    // call time, so one that lands after this reload would overwrite the very
    // state we are adopting from disk.
    await this.store.settled;

    await this.loadSettings();
    this.statusBar.update();
  };

  getActiveMarkdownFile = (): TFile | null => {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile?.extension !== "md") return null;
    return activeFile;
  };

  isFileEligible = (path: string): boolean => {
    return isEligible(this.state, path);
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
    return isReviewed(this.state, path);
  };

  getStats = (): ReviewStats => {
    return stats(
      this.state,
      this.getEligibleFiles().map((f) => f.path),
    );
  };

  openReviewMenu = () => {
    new ReviewMenuModal(this.app, this).open();
  };

  openRandomFile = async () => {
    // An empty eligible list and a fully reviewed one are different problems,
    // and congratulating someone on a review they never started points them
    // away from the settings tab, which is where the actual fault is.
    const eligible = this.getEligibleFiles();
    if (!eligible.length) {
      new Notice(
        "No files are eligible for review — check your excluded folders.",
      );
      return;
    }

    const unreviewed = eligible.filter((f) => !isReviewed(this.state, f.path));
    if (!unreviewed.length) {
      new Notice("All files are reviewed");
      return;
    }

    // Both early returns above have already established a non-empty list.
    const next = unreviewed[Math.floor(Math.random() * unreviewed.length)];
    await this.app.workspace.getLeaf(false).openFile(next);
  };

  /**
   * Apply a review-state change and report whether it was persisted. The UI
   * must not show progress that is not on disk: a refused write is declined
   * before anything changes, and a failed one is rolled back.
   */
  private mutate = (apply: (state: PluginState) => PluginState) =>
    this.store.mutate(apply);

  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    const saved = await this.mutate((s) => markReviewed(s, file.path));
    if (saved && openNext) await this.openRandomFile();
  };

  markUnreviewed = async () => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    await this.mutate((s) => markUnreviewed(s, file.path));
  };

  setExcludedFolders = async (list: string[]): Promise<boolean> => {
    return this.mutate((s) => setExcludedFolders(s, list));
  };

  resetReview = async (): Promise<boolean> => {
    if (!(await this.confirmReset())) return false;

    return this.mutate((s) => reset(s));
  };

  private confirmReset = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const modal = new ConfirmResetModal(this.app, resolve);
      modal.open();
    });
  };

  // The `instanceof` stays on this side of the boundary so `Review` needs no
  // Obsidian import and stays directly testable.
  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
    const next = renamePath(
      this.state,
      oldPath,
      file.path,
      file instanceof TFolder,
    );
    if (next !== this.state) {
      this.store.setState(next);
      await this.saveSettings();
    }
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    const next = removePath(this.state, file.path, file instanceof TFolder);
    if (next !== this.state) {
      this.store.setState(next);
      await this.saveSettings();
    }
  };
}
