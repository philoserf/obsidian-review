import {
  type App,
  PluginSettingTab,
  type SettingDefinitionItem,
} from "obsidian";
import type ReviewPlugin from "./main";
import { FolderPickerModal } from "./modals";
import {
  parseFolderKey,
  reviewSettingDefinitions,
} from "./settingsDefinitions";

// Declarative settings (Obsidian 1.13, #193). The definitions live in
// settingsDefinitions.ts, where they are tested as data; this class binds their
// keys to the store. Every write goes through a store commit, and every commit
// is followed by update(), so the tab always shows what is on disk — a refused
// or failed write re-renders the stored value rather than the attempted one.
export class ReviewSettingTab extends PluginSettingTab {
  plugin: ReviewPlugin;

  constructor(app: App, plugin: ReviewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return reviewSettingDefinitions(
      {
        state: this.plugin.state,
        blocked: this.plugin.store.blocked,
        stats: this.plugin.getStats(),
      },
      {
        reset: () => this.save(this.plugin.resetReview(), "reset review"),
        addFolder: () =>
          new FolderPickerModal(this.app, (folder) =>
            this.saveFolders([...this.plugin.state.excludedFolders, folder]),
          ).open(),
        deleteFolder: (index) =>
          this.saveFolders(
            this.plugin.state.excludedFolders.filter((_, i) => i !== index),
          ),
      },
    );
  }

  override getControlValue(key: string): unknown {
    const index = parseFolderKey(key);
    if (index !== null) return this.plugin.state.excludedFolders[index] ?? "";
    if (key === "showStatusBar") return this.plugin.state.showStatusBar;
    return undefined;
  }

  override setControlValue(key: string, value: unknown): void {
    const index = parseFolderKey(key);
    if (index !== null && typeof value === "string") {
      const folders = [...this.plugin.state.excludedFolders];
      folders[index] = value;
      this.saveFolders(folders);
    } else if (key === "showStatusBar" && typeof value === "boolean") {
      this.save(this.plugin.setShowStatusBar(value), "save settings");
    }
  }

  /**
   * Something outside the tab changed the state — a vault rename or delete,
   * or a reload from disk. The vault is authoritative, so the tab re-renders
   * from it.
   */
  invalidate(): void {
    this.update();
  }

  private saveFolders(folders: string[]): void {
    this.save(this.plugin.setExcludedFolders(folders), "save excluded folders");
  }

  private save(write: Promise<unknown>, label: string): void {
    this.plugin.runAsync(
      write.then(() => this.update()),
      label,
    );
  }
}
