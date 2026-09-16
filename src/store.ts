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
 * point: the write fence and the write queue are the plugin's densest code and
 * were the only part of it no test could reach.
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
  /**
   * The persisted document. Private and read through the getter below: the
   * design rests on `commit` being the only way to change state, and a public
   * field left that as convention. Assigning it from a UI module typechecked,
   * ran, and skipped the fence, the queue and the write — after which the next
   * successful commit would serialize the smuggled value as though it had been
   * persisted all along.
   */
  private current: PluginState = EMPTY_STATE;

  /** The current state. Replaced by `commit` and `reload`, by nothing else. */
  get state(): PluginState {
    return this.current;
  }

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

  /**
   * True when writes are currently refused. Read only by `store.test.ts`, which
   * is the whole of its job: it is the seam the fence assertions go through —
   * that a failed read raises it, that a reload lifts it again, that a newer
   * schema version raises it. Nothing in the plugin consults it, deliberately.
   * A settings tab that showed a read-only session before the user tried to
   * write would be the caller that changes that; see #173.
   */
  get isBlocked(): boolean {
    return this.blocked !== null;
  }

  private readFromDisk = async (): Promise<void> => {
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
    this.current = {
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

  /**
   * Everything that touches state or disk runs through here, in call order.
   * One arm is enough: the `.catch` below means the tail never rejects, so a
   * failed predecessor cannot stop its successor.
   */
  private enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = this.pending.then(fn);
    this.pending = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  /**
   * Adopt what is on disk. Joins the write queue, so a save requested before
   * this reload lands before it rather than on top of it.
   */
  reload = (): Promise<void> => this.enqueue(this.readFromDisk);

  /**
   * Apply a transition and persist it. The transition runs *inside* the queued
   * critical section and state is replaced only after the write resolves, so
   * overlapping commits compose rather than racing, a refusal cannot slip in
   * behind the fence check, and a failed write needs no rollback.
   *
   * Returns false for both a refusal and an I/O failure — the caller's question
   * is "is this on disk?", and both answers are no. A transition that throws is
   * a programming error and propagates.
   */
  commit = (apply: (state: PluginState) => PluginState): Promise<boolean> =>
    this.enqueue(async () => {
      // The transition runs before the fence is consulted, because a change of
      // nothing is not a change to refuse. Vault reconciliation commits on
      // every rename and delete in the vault — attachments, daily notes, files
      // another plugin writes — and checking `blocked` first made a fenced
      // session pop a Notice for each one. `apply` is pure and synchronous, so
      // no await window opens between here and the fence below.
      const next = apply(this.current);
      if (next === this.current) return true;

      if (this.blocked) {
        this.deps.notify(
          `Review: ${this.blocked}. Changes will not be saved until you reload.`,
        );
        return false;
      }

      const payload = serialize(next);
      try {
        await this.deps.save(payload);
      } catch (err) {
        this.deps.log(
          `saveData failed (${payload.reviewedPaths.length} reviewed paths, ${payload.excludedFolders.length} excluded folders)`,
          err,
        );
        this.deps.notify(
          "Review: could not save your review — see console for details.",
        );
        return false;
      }

      this.current = next;
      this.deps.onChange?.();
      return true;
    });
}
