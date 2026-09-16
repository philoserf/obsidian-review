import {
  Notice,
  Plugin,
  type TAbstractFile,
  type TFile,
  TFolder,
} from "obsidian";
import {
  CURRENT_SCHEMA_VERSION,
  normalizeData,
  type PluginData,
  type SavedData,
} from "./data";
import { ConfirmResetModal, ReviewMenuModal } from "./modals";
import { pickRandom, Review, type ReviewStats } from "./review";
import { ReviewSettingTab } from "./settingsTab";
import { StatusBar } from "./statusBar";

export default class ReviewPlugin extends Plugin {
  data!: PluginData;
  readonly review = new Review();
  statusBar!: StatusBar;

  /**
   * Why writing is refused, or null when it is allowed. Set on every path
   * through loadSettings: data we failed to read must not be overwritten by
   * the defaults we fell back to, and data from a newer plugin version must
   * not be truncated to what this version understands.
   */
  private saveBlocked: string | null = null;

  /** Tail of the serialized write queue. Never rejects. */
  private savePending: Promise<void> = Promise.resolve();

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

  loadSettings = async () => {
    let saved: SavedData | null = null;
    let loadFailed = false;
    try {
      saved = await this.loadData();
    } catch (err) {
      // Distinct from `saved === null`, which is also a fresh install.
      loadFailed = true;
      console.error("[review] loadData failed; running read-only", err);
      new Notice(
        "Review: could not read saved data. The plugin is read-only until Obsidian reloads it — your saved review will not be overwritten. See console for details.",
      );
    }

    const savedVersion = saved?.schemaVersion ?? CURRENT_SCHEMA_VERSION;
    const isNewer = savedVersion > CURRENT_SCHEMA_VERSION;

    if (isNewer) {
      console.warn(
        `[review] data has schema v${savedVersion}, newer than v${CURRENT_SCHEMA_VERSION}; loading read-only`,
      );
      new Notice(
        "Review: saved data is from a newer plugin version. Changes will not be saved until the plugin is updated.",
      );
    }

    this.data = {
      ...normalizeData(saved),
      // Keep a newer version's number, so the file is not truncated to v2
      // if something later lifts the write block.
      schemaVersion: isNewer ? savedVersion : CURRENT_SCHEMA_VERSION,
    };

    // Assigned on every path, back to null included, so a reload after a
    // transient read failure lifts the block.
    if (loadFailed) {
      this.saveBlocked = "saved data could not be read";
    } else if (isNewer) {
      this.saveBlocked = "saved data is from a newer plugin version";
    } else {
      this.saveBlocked = null;
    }

    this.review.load(
      this.data.reviewedPaths,
      this.data.excludedFolders,
      this.data.reviewStartedAt,
    );
  };

  saveSettings = (): Promise<void> => {
    if (this.saveBlocked) {
      console.warn(`[review] not saving: ${this.saveBlocked}`);
      new Notice(
        `Review: ${this.saveBlocked}. Changes will not be saved until you reload.`,
      );
      return Promise.resolve();
    }

    this.data.reviewedPaths = [...this.review.reviewedPaths];
    this.data.excludedFolders = [...this.review.excludedFolders];
    this.data.reviewStartedAt = this.review.reviewStartedAt;

    // Snapshot at call time, not write time: a queued write must carry the
    // state that was current when it was requested, not whatever `this.data`
    // holds by the time its turn comes.
    const payload: PluginData = {
      ...this.data,
      reviewedPaths: [...this.data.reviewedPaths],
      excludedFolders: [...this.data.excludedFolders],
    };

    // Serialize, so overlapping saves land in call order. Both arms run the
    // write: a failed predecessor must not stop its successor.
    const next = this.savePending.then(
      () => this.writeSettings(payload),
      () => this.writeSettings(payload),
    );
    this.savePending = next.catch(() => {});
    return next;
  };

  private writeSettings = async (data: PluginData) => {
    try {
      await this.saveData(data);
    } catch (err) {
      console.error(
        `[review] saveData failed (${data.reviewedPaths.length} reviewed paths, ${data.excludedFolders.length} excluded folders)`,
        err,
      );
      throw err;
    }
  };

  onExternalSettingsChange = async () => {
    // Settle any in-flight write first. Queued writes carry a snapshot taken at
    // call time, so one that lands after this reload would overwrite the very
    // state we are adopting from disk.
    await this.savePending;

    await this.loadSettings();
    this.statusBar.update();
  };

  getActiveMarkdownFile = (): TFile | null => {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile?.extension !== "md") return null;
    return activeFile;
  };

  isFileEligible = (path: string): boolean => {
    return this.review.isEligible(path);
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
    return this.review.isReviewed(path);
  };

  getStats = (): ReviewStats => {
    return this.review.stats(this.getEligibleFiles().map((f) => f.path));
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

    const unreviewed = eligible.filter((f) => !this.review.isReviewed(f.path));
    if (!unreviewed.length) {
      new Notice("All files are reviewed");
      return;
    }

    const next = pickRandom(unreviewed);
    if (next) await this.app.workspace.getLeaf(false).openFile(next);
  };

  /**
   * Apply a review-state change and report whether it was persisted. The UI
   * must not show progress that is not on disk: a refused write is declined
   * before anything changes, and a failed one is rolled back.
   */
  private mutate = async (apply: () => void): Promise<boolean> => {
    if (this.saveBlocked) {
      new Notice(
        `Review: ${this.saveBlocked}. Changes will not be saved until you reload.`,
      );
      return false;
    }

    // Settle any in-flight write first, so a rollback cannot be overtaken by
    // a save that was already queued from the state we are about to undo.
    await this.savePending;

    const paths = [...this.review.reviewedPaths];
    const excludedFolders = [...this.review.excludedFolders];
    const startedAt = this.review.reviewStartedAt;

    apply();
    this.statusBar.update();

    try {
      await this.saveSettings();
      return true;
    } catch (err) {
      this.review.load(paths, excludedFolders, startedAt);
      this.statusBar.update();
      throw err;
    }
  };

  markReviewed = async ({ openNext = false }: { openNext?: boolean } = {}) => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    const saved = await this.mutate(() => this.review.markReviewed(file.path));
    if (saved && openNext) await this.openRandomFile();
  };

  markUnreviewed = async () => {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    await this.mutate(() => this.review.markUnreviewed(file.path));
  };

  setExcludedFolders = async (list: string[]): Promise<boolean> => {
    return this.mutate(() => this.review.setExcludedFolders(list));
  };

  resetReview = async ({
    confirm = true,
  }: {
    confirm?: boolean;
  } = {}): Promise<boolean> => {
    if (confirm && !(await this.confirmReset())) return false;

    return this.mutate(() => this.review.reset());
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
    if (this.review.rename(oldPath, file.path, file instanceof TFolder)) {
      this.statusBar.update();
      await this.saveSettings();
    }
  };

  private handleFileDelete = async (file: TAbstractFile) => {
    if (this.review.remove(file.path, file instanceof TFolder)) {
      this.statusBar.update();
      await this.saveSettings();
    }
  };
}
