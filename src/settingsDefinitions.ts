import type { SettingDefinitionItem } from "obsidian";
import { normalizeFolder, type PluginState, type ReviewStats } from "./review";

/** What the tab shows, read fresh on every `update()`. */
export interface TabModel {
  state: PluginState;
  /** The store's read-only reason, or null when writes are allowed. */
  blocked: string | null;
  stats: ReviewStats;
}

/** What the tab's action rows do; the wiring supplies them. */
export interface TabActions {
  reset(): void;
  addFolder(): void;
  deleteFolder(index: number): void;
}

const FOLDER_KEY = "excludedFolders.";

/** A list row's control key names its position: `excludedFolders.2`. */
export function folderKey(index: number): string {
  return `${FOLDER_KEY}${index}`;
}

export function parseFolderKey(key: string): number | null {
  if (!key.startsWith(FOLDER_KEY)) return null;
  const index = Number(key.slice(FOLDER_KEY.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * A row may not be emptied or made a duplicate of another, so the
 * normalization `setExcludedFolders` applies — drop empties, dedupe — never has
 * anything to remove: a half-typed value is stored as typed, and a value that
 * would collapse rows is rejected before it is stored.
 */
export function validateFolderRow(
  folders: readonly string[],
  index: number,
  value: string,
): string | undefined {
  const folder = normalizeFolder(value);
  if (!folder) return "Choose a folder, or delete this row.";
  const duplicate = folders.some(
    (other, i) => i !== index && normalizeFolder(other) === folder,
  );
  return duplicate ? "That folder is already excluded." : undefined;
}

/**
 * The settings tab as data (Obsidian 1.13 declarative settings, #193). Side
 * effect free: Obsidian also calls it once at registration, to build the
 * settings search index.
 */
export function reviewSettingDefinitions(
  model: TabModel,
  actions: TabActions,
): SettingDefinitionItem[] {
  const { state, blocked, stats } = model;
  const folders = state.excludedFolders;

  return [
    {
      type: "group",
      heading: "Changes are not being saved",
      visible: () => blocked !== null,
      items: [{ name: "Read-only", desc: blocked ?? "" }],
    },
    {
      type: "group",
      heading: "Review",
      items: [
        {
          name: "Reset review",
          desc: state.reviewStartedAt
            ? `Review started on ${new Date(state.reviewStartedAt).toLocaleDateString()}.`
            : "No active review.",
          action: () => actions.reset(),
        },
        { name: "Eligible files", desc: String(stats.eligible) },
        {
          name: "Reviewed",
          desc: `${stats.reviewed} (${stats.percentCompleted}%)`,
        },
      ],
    },
    {
      type: "list",
      heading: "Excluded folders",
      emptyState:
        "No folders excluded. Files in excluded folders do not appear in review.",
      addItem: { name: "Exclude a folder", action: () => actions.addFolder() },
      onDelete: (index) => actions.deleteFolder(index),
      items: folders.map((folder, index) => ({
        name: folder,
        control: {
          type: "folder" as const,
          key: folderKey(index),
          validate: (value: string) => validateFolderRow(folders, index, value),
        },
      })),
    },
    {
      type: "group",
      heading: "Status bar",
      items: [
        {
          name: "Status bar",
          desc: "Show file review status in the status bar.",
          control: { type: "toggle", key: "showStatusBar" },
        },
      ],
    },
  ];
}
