import {
  Notice,
  Plugin,
  type TAbstractFile,
  type TFile,
  TFolder,
} from "obsidian";
import { COMMANDS } from "./commands";
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
  setShowStatusBar,
  stats,
} from "./review";
import { ReviewSettingTab } from "./settingsTab";
import { StatusBar } from "./statusBar";
import { Store } from "./store";

export default class ReviewPlugin extends Plugin {
  statusBar!: StatusBar;
  private settingsTab?: ReviewSettingTab;

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

    for (const command of COMMANDS) {
      this.addCommand({
        id: command.id,
        name: command.name,
        ...(command.availableWhen
          ? {
              checkCallback: (checking: boolean) => {
                if (this.getActiveFileStatus() !== command.availableWhen)
                  return false;
                if (!checking) this.runAsync(command.run(this), command.label);
                return true;
              },
            }
          : {
              callback: () => this.runAsync(command.run(this), command.label),
            }),
      });
    }

    this.addCommand({
      id: "open-review-menu",
      name: "Open review menu",
      callback: () => this.openReviewMenu(),
    });

    this.settingsTab = new ReviewSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

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

  onExternalSettingsChange = async () => {
    // reload() joins the write queue, so a save requested before this lands
    // before it rather than on top of the state it just adopted.
    await this.loadSettings();
    this.statusBar.update();
    this.settingsTab?.invalidate();
  };

  getActiveMarkdownFile = (): TFile | null => {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile?.extension !== "md") return null;
    return activeFile;
  };

  getEligibleFiles = (): TFile[] => {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => isEligible(this.state, f.path));
  };

  getActiveFileStatus = (): "reviewed" | "not_reviewed" | undefined => {
    const file = this.getActiveMarkdownFile();
    if (!file || !isEligible(this.state, file.path)) return undefined;
    return isReviewed(this.state, file.path) ? "reviewed" : "not_reviewed";
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

    // Opening the file already in the leaf is a no-op the user reads as a
    // broken command. Falling back matters: with one unreviewed file left and
    // it open, filtering to an empty pool would silently do nothing, which is
    // worse than the stutter being fixed.
    const active = this.getActiveMarkdownFile();
    const others = unreviewed.filter((f) => f.path !== active?.path);
    const candidates = others.length ? others : unreviewed;

    // Both early returns above have already established a non-empty list.
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    await this.app.workspace.getLeaf(false).openFile(next);
  };

  /**
   * Apply a review-state change and report whether it was persisted. The UI
   * must not show progress that is not on disk: a refused write is declined
   * before anything changes, and a failed one is rolled back.
   */
  private commit = (apply: (state: PluginState) => PluginState) =>
    this.store.commit(apply);

  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    const saved = await this.commit((s) => markReviewed(s, file.path));
    if (saved && openNext) await this.openRandomFile();
  };

  markUnreviewed = async () => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    await this.commit((s) => markUnreviewed(s, file.path));
  };

  setExcludedFolders = async (list: string[]): Promise<boolean> => {
    return this.commit((s) => setExcludedFolders(s, list));
  };

  setShowStatusBar = (value: boolean): Promise<boolean> => {
    return this.commit((s) => setShowStatusBar(s, value));
  };

  resetReview = async (): Promise<boolean> => {
    if (!(await this.confirmReset())) return false;

    return this.commit((s) => reset(s));
  };

  private confirmReset = (): Promise<boolean> => {
    return new Promise((resolve) => {
      const modal = new ConfirmResetModal(this.app, resolve);
      modal.open();
    });
  };

  // The `instanceof` stays on this side of the boundary so `Review` needs no
  // Obsidian import and stays directly testable.
  // Through commit like every other writer: a reconciliation that cannot be
  // persisted must not be applied in memory either, or a blocked session
  // reports exclusions the next reload will contradict. commit writes nothing
  // when the transition changes nothing, so no guard is needed here.
  private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
    await this.commit((s) =>
      renamePath(s, oldPath, file.path, file instanceof TFolder),
    );
    this.settingsTab?.invalidate();
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    await this.commit((s) => removePath(s, file.path, file instanceof TFolder));
    this.settingsTab?.invalidate();
  };
}
