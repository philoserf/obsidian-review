import { Menu } from "obsidian";
import { COMMANDS } from "./commands";
import type ReviewPlugin from "./main";

export class StatusBar {
  private element: HTMLElement;
  private plugin: ReviewPlugin;

  constructor(element: HTMLElement, plugin: ReviewPlugin) {
    this.element = element;
    this.plugin = plugin;

    element.setText("Not reviewed");
    element.addClass("mod-clickable");
    plugin.registerDomEvent(element, "click", this.onClick);

    this.update();
  }

  update = () => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) {
      this.setIsVisible(false);
      return;
    }

    this.setIsVisible(this.plugin.state.showStatusBar);

    this.element.setText(status === "reviewed" ? "Reviewed" : "Not reviewed");
  };

  private onClick = (event: MouseEvent) => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) return;

    const menu = new Menu();

    // The two plain state changes, named by id: "mark and open next" also
    // carries availableWhen but navigates, which is not what a checkbox in a
    // status-bar menu means. Reading run/label from the table still keeps the
    // actions from drifting from the commands they stand for.
    for (const id of ["mark-reviewed", "mark-unreviewed"] as const) {
      const command = COMMANDS.find((c) => c.id === id);
      if (!command) continue;

      menu.addItem((item) => {
        item.setTitle(id === "mark-reviewed" ? "Reviewed" : "Not reviewed");
        item.setChecked(command.availableWhen !== status);
        item.onClick(() =>
          this.plugin.runAsync(command.run(this.plugin), command.label),
        );
      });
    }

    menu.showAtMouseEvent(event);
  };

  // Obsidian's own `is-hidden` rules are scoped to ribbon and stacked-tab
  // elements, so the class styles nothing on a status-bar item. `toggle` sets
  // inline display, which needs no stylesheet to agree with it.
  private setIsVisible = (isVisible: boolean) => {
    this.element.toggle(isVisible);
  };
}
