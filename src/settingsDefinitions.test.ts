import { describe, expect, test } from "bun:test";
import type {
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionList,
} from "obsidian";
import { normalizeState } from "./review";
import {
  folderKey,
  parseFolderKey,
  reviewSettingDefinitions,
  type TabActions,
  type TabModel,
  validateFolderRow,
} from "./settingsDefinitions";

// The tab is data (#193), so it is tested as data: no DOM and no Obsidian.
function model(over: Partial<TabModel> = {}): TabModel {
  return {
    state: normalizeState({ excludedFolders: ["Templates", "Archive"] }),
    blocked: null,
    stats: { eligible: 10, reviewed: 4, percentCompleted: 40 },
    ...over,
  };
}

function actions() {
  const calls: string[] = [];
  const a: TabActions = {
    reset: () => calls.push("reset"),
    addFolder: () => calls.push("add"),
    deleteFolder: (i) => calls.push(`delete ${i}`),
  };
  return { a, calls };
}

const groups = (m: TabModel, a = actions().a) =>
  reviewSettingDefinitions(m, a) as (
    | SettingDefinitionGroup
    | SettingDefinitionList
  )[];

const heading = (m: TabModel, h: string) => {
  const g = groups(m).find((x) => x.heading === h);
  if (!g) throw new Error(`no group ${h}`);
  return g;
};

const evaluate = (v: boolean | (() => boolean) | undefined) =>
  typeof v === "function" ? v() : (v ?? true);

describe("reviewSettingDefinitions", () => {
  test("shows the read-only banner only while writes are blocked", () => {
    const title = "Changes are not being saved";
    expect(evaluate(heading(model(), title).visible)).toBe(false);
    const blocked = heading(model({ blocked: "Reload to retry." }), title);
    expect(evaluate(blocked.visible)).toBe(true);
    expect((blocked.items?.[0] as SettingDefinition | undefined)?.desc).toBe(
      "Reload to retry.",
    );
  });

  test("excluded folders are a list of folder pickers keyed by position", () => {
    const list = heading(model(), "Excluded folders") as SettingDefinitionList;
    expect(list.type).toBe("list");
    const rows = (list.items ?? []) as SettingDefinition[];
    expect(
      rows.map((r) =>
        "control" in r && r.control
          ? [r.name, r.control.type, r.control.key]
          : [],
      ),
    ).toEqual([
      ["Templates", "folder", "excludedFolders.0"],
      ["Archive", "folder", "excludedFolders.1"],
    ]);
  });

  test("the list's add and delete reach the actions", () => {
    const { a, calls } = actions();
    const list = groups(model(), a).find(
      (g) => g.heading === "Excluded folders",
    ) as SettingDefinitionList;
    list.addItem?.action({} as HTMLElement);
    list.onDelete?.(1);
    expect(calls).toEqual(["add", "delete 1"]);
  });

  test("reset is an action row showing when the review began", () => {
    const { a, calls } = actions();
    const review = groups(
      model({
        state: normalizeState({ reviewStartedAt: "2026-10-01T12:00:00Z" }),
      }),
      a,
    ).find((g) => g.heading === "Review");
    const reset = review?.items?.[0] as SettingDefinition | undefined;
    if (!reset) throw new Error("no reset row");
    expect(reset.desc).toContain("Review started on");
    if (!("action" in reset) || !reset.action) throw new Error("no action");
    reset.action({} as HTMLElement, 0);
    expect(calls).toEqual(["reset"]);
  });

  test("shows the counts", () => {
    const rows = heading(model(), "Review").items as SettingDefinition[];
    expect(rows.map((r) => [r.name, r.desc])).toEqual([
      ["Reset review", "No active review."],
      ["Eligible files", "10"],
      ["Reviewed", "4 (40%)"],
    ]);
  });

  test("the status bar is a toggle", () => {
    const row = heading(model(), "Status bar").items?.[0] as
      | SettingDefinition
      | undefined;
    expect(row && "control" in row && row.control?.key).toBe("showStatusBar");
  });
});

describe("validateFolderRow", () => {
  const folders = ["Templates", "Archive"];

  test("accepts a new folder and a half-typed one", () => {
    expect(validateFolderRow(folders, 1, "Daily")).toBeUndefined();
    expect(validateFolderRow(folders, 1, "Te")).toBeUndefined();
  });

  test("rejects emptying a row, which normalization would delete", () => {
    expect(validateFolderRow(folders, 1, "  ")).toBeTruthy();
  });

  test("rejects a duplicate, which normalization would collapse", () => {
    expect(validateFolderRow(folders, 1, "Templates/")).toBeTruthy();
    expect(validateFolderRow(folders, 0, "Templates")).toBeUndefined();
  });
});

describe("folder keys", () => {
  test("round-trip a position", () => {
    expect(parseFolderKey(folderKey(3))).toBe(3);
  });

  test("reject anything else", () => {
    expect(parseFolderKey("showStatusBar")).toBeNull();
    expect(parseFolderKey("excludedFolders.x")).toBeNull();
    expect(parseFolderKey("excludedFolders.-1")).toBeNull();
  });
});
