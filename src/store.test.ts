import { describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  markReviewed,
  type PluginData,
  reset,
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
    expect(await h.store.mutate((s) => markReviewed(s, "a.md"))).toBe(false);
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
    expect(await store.mutate((s) => markReviewed(s, "a.md"))).toBe(true);
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

describe("mutate", () => {
  test("persists the change and reports true", async () => {
    const h = harness();
    await h.store.reload();

    expect(await h.store.mutate((s) => markReviewed(s, "a.md"))).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].reviewedPaths).toEqual(["a.md"]);
  });

  // The invariant: the UI must not show progress that is not on disk.
  test("a save that throws rolls the state back", async () => {
    const h = harness({ saveThrows: true });
    await h.store.reload();

    const before = h.store.state;
    await expect(
      h.store.mutate((s) => markReviewed(s, "a.md")),
    ).rejects.toThrow("disk full");
    expect(h.store.state).toBe(before);
    expect(h.errors.some((e) => e.includes("saveData failed"))).toBe(true);
  });

  test("repaints on apply and again on rollback", async () => {
    let repaints = 0;
    const store = new Store({
      load: async () => null,
      save: async () => {
        throw new Error("disk full");
      },
      notify: () => {},
      log: () => {},
      warn: () => {},
      onChange: () => repaints++,
    });
    await store.reload();

    await expect(
      store.mutate((s) => markReviewed(s, "a.md")),
    ).rejects.toThrow();
    expect(repaints).toBe(2);
  });

  test("a transition that changes nothing still reports true", async () => {
    const h = harness();
    await h.store.reload();
    expect(await h.store.mutate((s) => reset(s))).toBe(true);
  });
});

describe("the write queue", () => {
  test("overlapping saves land in call order", async () => {
    const h = harness({ manualWrites: true });
    await h.store.reload();

    h.store.setState(markReviewed(h.store.state, "a.md"));
    const first = h.store.save();
    h.store.setState(markReviewed(h.store.state, "b.md"));
    const second = h.store.save();

    await h.settle(true);
    await first;
    await h.settle(true);
    await second;

    expect(h.writes.map((w) => w.reviewedPaths)).toEqual([
      ["a.md"],
      ["a.md", "b.md"],
    ]);
  });

  test("a failed write does not stop its successor", async () => {
    const h = harness({ manualWrites: true });
    await h.store.reload();

    h.store.setState(markReviewed(h.store.state, "a.md"));
    const first = h.store.save();
    h.store.setState(markReviewed(h.store.state, "b.md"));
    const second = h.store.save();

    await h.settle(false);
    await expect(first).rejects.toThrow();
    await h.settle(true);
    await second;

    expect(h.writes).toHaveLength(2);
  });

  // Each queued write carries the state that was current when it was
  // requested, not whatever the store holds by the time its turn comes.
  test("a queued write carries its own snapshot", async () => {
    const h = harness({ manualWrites: true });
    await h.store.reload();

    h.store.setState(markReviewed(h.store.state, "a.md"));
    const first = h.store.save();

    // Change the state while the first write is still in flight.
    h.store.setState(markReviewed(h.store.state, "b.md"));

    await h.settle(true);
    await first;

    expect(h.writes[0].reviewedPaths).toEqual(["a.md"]);
  });
});

describe("save", () => {
  test("a fenced store writes nothing and resolves", async () => {
    const h = harness({ loadThrows: true });
    await h.store.reload();

    await h.store.save();
    expect(h.writes).toHaveLength(0);
  });
});
