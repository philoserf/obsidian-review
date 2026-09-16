import { describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  markReviewed,
  type PluginData,
  renamePath,
  reset,
  setShowStatusBar,
} from "./review";
import { Store, type StoreDeps } from "./store";

type Harness = {
  store: Store;
  writes: PluginData[];
  notices: string[];
  errors: string[];
  /** Wait for a write to reach the deps, then resolve or reject it. */
  settle: (ok: boolean) => Promise<void>;
};

function harness(
  options: {
    initial?: unknown;
    loadThrows?: boolean;
    saveThrows?: boolean;
    manualWrites?: boolean;
  } = {},
): Harness {
  const writes: PluginData[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const releases: ((ok: boolean) => void)[] = [];

  const deps: StoreDeps = {
    load: async () => {
      if (options.loadThrows) throw new Error("disk on fire");
      return options.initial ?? null;
    },
    save: async (data) => {
      writes.push(data);
      if (options.saveThrows) throw new Error("disk full");
      if (options.manualWrites) {
        await new Promise<void>((resolve, reject) => {
          releases.push((ok) =>
            ok ? resolve() : reject(new Error("disk full")),
          );
        });
      }
    },
    notify: (m) => notices.push(m),
    log: (m) => errors.push(m),
    warn: (m) => errors.push(m),
  };

  return {
    store: new Store(deps),
    writes,
    notices,
    errors,
    settle: async (ok) => {
      // The queue dispatches on a microtask, so the write may not have reached
      // `save` yet when the test asks to settle it.
      while (!releases.length) await Promise.resolve();
      releases.shift()?.(ok);
    },
  };
}

describe("reload", () => {
  test("adopts a valid file and allows writing", async () => {
    const h = harness({ initial: { reviewedPaths: ["a.md"] } });
    await h.store.reload();
    expect([...h.store.state.reviewedPaths]).toEqual(["a.md"]);
    expect(h.store.isBlocked).toBe(false);
  });

  // The fence exists for this user: a read that failed must not be overwritten
  // by the defaults we fell back to.
  test("a load that throws sets the fence and notifies", async () => {
    const h = harness({ loadThrows: true });
    await h.store.reload();
    expect(h.store.isBlocked).toBe(true);
    expect(h.notices[0]).toContain("could not read saved data");
  });

  test("a fenced store refuses to commit, and writes nothing", async () => {
    const h = harness({ loadThrows: true });
    await h.store.reload();

    const before = h.store.state;
    expect(await h.store.commit((s) => markReviewed(s, "a.md"))).toBe(false);
    expect(h.store.state).toBe(before);
    expect(h.writes).toHaveLength(0);
  });

  test("a second reload lifts a fence set by a transient read failure", async () => {
    const writes: PluginData[] = [];
    let fail = true;
    const store = new Store({
      load: async () => {
        if (fail) throw new Error("transient");
        return null;
      },
      save: async (d) => void writes.push(d),
      notify: () => {},
      log: () => {},
      warn: () => {},
    });

    await store.reload();
    expect(store.isBlocked).toBe(true);

    fail = false;
    await store.reload();
    expect(store.isBlocked).toBe(false);
    expect(await store.commit((s) => markReviewed(s, "a.md"))).toBe(true);
    expect(writes).toHaveLength(1);
  });

  test("data from a newer schema fences writes but keeps its version", async () => {
    const h = harness({
      initial: { schemaVersion: 99, reviewedPaths: ["a.md"] },
    });
    await h.store.reload();
    expect(h.store.isBlocked).toBe(true);
    expect(h.store.state.schemaVersion).toBe(99);
    expect(h.notices[0]).toContain("newer plugin version");
  });

  test("current data is stamped with the current version", async () => {
    const h = harness({ initial: {} });
    await h.store.reload();
    expect(h.store.state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("commit", () => {
  test("persists the change and reports true", async () => {
    const h = harness();
    await h.store.reload();

    expect(await h.store.commit((s) => markReviewed(s, "a.md"))).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].reviewedPaths).toEqual(["a.md"]);
  });
});

describe("the write queue", () => {
  test("overlapping commits write in call order", async () => {
    const h = harness({ manualWrites: true });
    await h.store.reload();

    const first = h.store.commit((st) => markReviewed(st, "a.md"));
    const second = h.store.commit((st) => markReviewed(st, "b.md"));

    await h.settle(true);
    expect(await first).toBe(true);
    await h.settle(true);
    expect(await second).toBe(true);

    expect(h.writes.map((w) => w.reviewedPaths)).toEqual([
      ["a.md"],
      ["a.md", "b.md"],
    ]);
  });

  // A failed predecessor must not stop its successor: the queue tail swallows
  // the rejection so the next caller still runs.
  test("a failed write does not stop its successor", async () => {
    const h = harness({ manualWrites: true });
    await h.store.reload();

    const first = h.store.commit((st) => markReviewed(st, "a.md"));
    const second = h.store.commit((st) => markReviewed(st, "b.md"));

    await h.settle(false);
    expect(await first).toBe(false);
    await h.settle(true);
    expect(await second).toBe(true);

    expect(h.writes).toHaveLength(2);
    // The failed commit was never adopted, so the successor built on the
    // state that was actually persisted.
    expect([...h.store.state.reviewedPaths]).toEqual(["b.md"]);
  });
});

describe("a fenced store", () => {
  test("writes nothing and reports false", async () => {
    const h = harness({ loadThrows: true });
    await h.store.reload();

    expect(await h.store.commit((st) => markReviewed(st, "a.md"))).toBe(false);
    expect(h.writes).toHaveLength(0);
  });
});

describe("commit-after-write", () => {
  // #112: two mutate calls that overlap took the same rollback snapshot, so
  // one failed write reverted the other's change in memory while the other's
  // change landed on disk.
  test("overlapping commits compose instead of racing", async () => {
    const h = harness();
    await h.store.reload();

    const [a, b] = await Promise.all([
      h.store.commit((s) => markReviewed(s, "a.md")),
      h.store.commit((s) => markReviewed(s, "b.md")),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect([...h.store.state.reviewedPaths].sort()).toEqual(["a.md", "b.md"]);
    expect(h.writes.at(-1)?.reviewedPaths.sort()).toEqual(["a.md", "b.md"]);
  });

  // #119: nothing is applied speculatively, so a failed write needs no undo.
  test("a failed write leaves the state untouched and reports false", async () => {
    const h = harness({ saveThrows: true });
    await h.store.reload();

    const before = h.store.state;
    expect(await h.store.commit((s) => markReviewed(s, "a.md"))).toBe(false);
    expect(h.store.state).toBe(before);
  });

  // #116: a refusal arriving inside the critical section used to return true,
  // because the fence was checked before the await and never re-checked.
  test("a refused commit reports false rather than true", async () => {
    const h = harness({ loadThrows: true });
    await h.store.reload();

    expect(await h.store.commit((s) => markReviewed(s, "a.md"))).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  test("repaints once, after the write resolves", async () => {
    const repaints: string[] = [];
    const store = new Store({
      load: async () => null,
      save: async () => void repaints.push("write"),
      notify: () => {},
      log: () => {},
      warn: () => {},
      onChange: () => repaints.push("repaint"),
    });
    await store.reload();

    await store.commit((s) => markReviewed(s, "a.md"));
    expect(repaints).toEqual(["write", "repaint"]);
  });

  test("a transition that changes nothing writes nothing", async () => {
    const h = harness();
    await h.store.reload();

    expect(await h.store.commit((s) => reset(s))).toBe(true);
    expect(h.writes).toHaveLength(0);
  });

  // #110: a queued write must not land on top of state just adopted from disk.
  test("a reload joins the queue behind a pending write", async () => {
    const h = harness({ manualWrites: true });
    await h.store.reload();

    const order: string[] = [];
    const write = h.store
      .commit((st) => markReviewed(st, "a.md"))
      .then(() => order.push("write"));
    const reload = h.store.reload().then(() => order.push("reload"));

    await h.settle(true);
    await Promise.all([write, reload]);

    // Before this fix the reload resolved first and the queued write then
    // overwrote the state it had just adopted from disk.
    expect(order).toEqual(["write", "reload"]);
  });
});

describe("#115 — every writer goes through the same door", () => {
  // The status-bar toggle used to write the preference straight into state and
  // then call a save that refused: the switch flipped, the bar hid, nothing was
  // written, and the next reload silently put it back.
  test("a fenced store refuses a preference change too", async () => {
    const h = harness({ loadThrows: true });
    await h.store.reload();

    expect(h.store.state.showStatusBar).toBe(true);
    expect(await h.store.commit((s) => setShowStatusBar(s, false))).toBe(false);
    expect(h.store.state.showStatusBar).toBe(true);
    expect(h.writes).toHaveLength(0);
  });

  // Vault reconciliation is not exempt: a rename that cannot be persisted must
  // not be applied in memory either, or a blocked session shows exclusions the
  // next reload contradicts.
  test("a fenced store refuses vault reconciliation", async () => {
    const h = harness({ loadThrows: true });
    await h.store.reload();

    expect(
      await h.store.commit((s) => renamePath(s, "Templates", "Meta", true)),
    ).toBe(false);
    expect(h.writes).toHaveLength(0);
  });
});
