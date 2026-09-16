import type ReviewPlugin from "./plugin";

/**
 * "Which review actions apply to the file I am looking at" is one domain rule.
 * It used to be written three times — as `checkCallback`s in `onload`, as three
 * literal arrays in the review menu, and again in the status-bar menu — each
 * carrying its own copy of the same label strings. Adding an action meant
 * editing three files and remembering that the palette and the menu decided
 * availability separately.
 *
 * `availableWhen` is the rule; `run` is the action; `label` is the runAsync
 * tag. Everything that offers these actions reads them from here.
 */
export type ReviewCommand = {
  id: string;
  name: string;
  /** Undefined means "always available". */
  availableWhen?: "reviewed" | "not_reviewed";
  label: string;
  run: (plugin: ReviewPlugin) => Promise<unknown>;
};

export const COMMANDS: readonly ReviewCommand[] = [
  {
    id: "mark-reviewed-and-open-next",
    name: "Mark file as reviewed and open next",
    availableWhen: "not_reviewed",
    label: "mark reviewed",
    run: (p) => p.markReviewed({ openNext: true }),
  },
  {
    id: "mark-reviewed",
    name: "Mark file as reviewed",
    availableWhen: "not_reviewed",
    label: "mark reviewed",
    run: (p) => p.markReviewed(),
  },
  {
    id: "mark-unreviewed",
    name: "Mark file as unreviewed",
    availableWhen: "reviewed",
    label: "mark unreviewed",
    run: (p) => p.markUnreviewed(),
  },
  {
    id: "open-random-unreviewed",
    name: "Open random unreviewed file",
    label: "open random file",
    run: (p) => p.openRandomFile(),
  },
];

/**
 * The commands that apply to the active file. `status` is undefined when there
 * is no eligible markdown file open, which leaves only the always-available
 * ones.
 *
 * Order is the menu's one piece of judgement and is the reason this returns a
 * list rather than a set: when a file is unreviewed, "mark and open next" comes
 * first, because that is the loop the plugin exists to accelerate.
 */
export function availableCommands(
  status: "reviewed" | "not_reviewed" | undefined,
): ReviewCommand[] {
  return COMMANDS.filter(
    (command) => !command.availableWhen || command.availableWhen === status,
  );
}
