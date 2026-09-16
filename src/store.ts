import {
  CURRENT_SCHEMA_VERSION,
  EMPTY_STATE,
  normalizeState,
  type PluginData,
  type PluginState,
  serialize,
} from "./review";

/**
 * Everything the store needs from the outside world, as plain functions. The
 * plugin binds these to Obsidian (`loadData`, `saveData`, `Notice`, `console`);
 * a test binds them to whatever it wants to observe or make fail. That is the
 * point: the write fence, the queue and the rollback are the plugin's densest
 * code and were the only part of it no test could reach.
 */
export type StoreDeps = {
  load: () => Promise<unknown>;
  save: (data: PluginData) => Promise<void>;
  notify: (message: string) => void;
  log: (message: string, err?: unknown) => void;
  warn: (message: string) => void;
  /** Called whenever `state` is replaced, so the UI can repaint. */
  onChange?: () => void;
};

export class Store {
  state: PluginState = EMPTY_STATE;

  /**
   * Why writing is refused, or null when it is allowed. Set on every path
   * through reload(): data we failed to read must not be overwritten by the
   * defaults we fell back to, and data from a newer plugin version must not be
   * truncated to what this version understands.
   */
  private blocked: string | null = null;

  /** Tail of the serialized write queue. Never rejects — see the catch below. */
  private pending: Promise<void> = Promise.resolve();

  constructor(private deps: StoreDeps) {}

  /** True when writes are currently refused. */
  get isBlocked(): boolean {
    return this.blocked !== null;
  }

  /** Settles when every write queued so far has finished, however it finished. */
  get settled(): Promise<void> {
    return this.pending;
  }

  reload = async (): Promise<void> => {
    let raw: unknown = null;
    let loadFailed = false;

    try {
      raw = await this.deps.load();
    } catch (err) {
      // Distinct from `raw === null`, which is also a fresh install.
      loadFailed = true;
      this.deps.log("loadData failed; running read-only", err);
      this.deps.notify(
        "Review: could not read saved data. The plugin is read-only until Obsidian reloads it — your saved review will not be overwritten. See console for details.",
      );
    }

    // Every persisted field, schemaVersion included, passes through the one
    // validator before anything reads it.
    const normalized = normalizeState(raw);
    const savedVersion = normalized.schemaVersion;
    const isNewer = savedVersion > CURRENT_SCHEMA_VERSION;

    if (isNewer) {
      this.deps.warn(
        `data has schema v${savedVersion}, newer than v${CURRENT_SCHEMA_VERSION}; loading read-only`,
      );
      this.deps.notify(
        "Review: saved data is from a newer plugin version. Changes will not be saved until the plugin is updated.",
      );
    }

    // Keep a newer version's number, so the file is not truncated to v2
    // if something later lifts the write block.
    this.state = {
      ...normalized,
      schemaVersion: isNewer ? savedVersion : CURRENT_SCHEMA_VERSION,
    };

    // Assigned on every path, back to null included, so a reload after a
    // transient read failure lifts the block.
    if (loadFailed) {
      this.blocked = "saved data could not be read";
    } else if (isNewer) {
      this.blocked = "saved data is from a newer plugin version";
    } else {
      this.blocked = null;
    }
  };

  save = (): Promise<void> => {
    if (this.blocked) {
      this.deps.warn(`not saving: ${this.blocked}`);
      this.deps.notify(
        `Review: ${this.blocked}. Changes will not be saved until you reload.`,
      );
      return Promise.resolve();
    }

    // Snapshot at call time, not write time: a queued write must carry the
    // state that was current when it was requested, not whatever `state` holds
    // by the time its turn comes.
    const payload = serialize(this.state);

    // Serialize, so overlapping saves land in call order. One arm is enough:
    // the `.catch` below means the tail never rejects, so a failed predecessor
    // cannot stop its successor.
    const next = this.pending.then(() =>
      this.deps.save(payload).catch((err) => {
        this.deps.log(
          `saveData failed (${payload.reviewedPaths.length} reviewed paths, ${payload.excludedFolders.length} excluded folders)`,
          err,
        );
        throw err;
      }),
    );
    this.pending = next.catch(() => {});
    return next;
  };

  /**
   * Apply a transition and persist it, rolling back if the write fails. The UI
   * must not show progress that is not on disk, so a caller acts on the
   * returned boolean rather than assuming the change stuck.
   */
  mutate = async (
    apply: (state: PluginState) => PluginState,
  ): Promise<boolean> => {
    if (this.blocked) {
      this.deps.notify(
        `Review: ${this.blocked}. Changes will not be saved until you reload.`,
      );
      return false;
    }

    // Settle any in-flight write first, so a rollback cannot be overtaken by
    // a save that was already queued from the state we are about to undo.
    await this.pending;

    const prev = this.state;

    this.state = apply(prev);
    this.deps.onChange?.();

    try {
      await this.save();
      return true;
    } catch (err) {
      this.state = prev;
      this.deps.onChange?.();
      throw err;
    }
  };

  /** Replace the state without persisting. Used by the vault reconcilers. */
  setState = (state: PluginState): void => {
    if (state === this.state) return;
    this.state = state;
    this.deps.onChange?.();
  };
}
