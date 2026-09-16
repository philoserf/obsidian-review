import { Menu } from "obsidian";
import type ReviewPlugin from "./plugin";

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

    this.setIsVisible(this.plugin.showStatusBar);

    this.element.setText(status === "reviewed" ? "Reviewed" : "Not reviewed");
  };

  private onClick = (event: MouseEvent) => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) return;

    const isReviewed = status === "reviewed";
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle("Reviewed");
      item.setChecked(isReviewed);
      item.onClick(() =>
        this.plugin.runAsync(this.plugin.markReviewed(), "mark reviewed"),
      );
    });
    menu.addItem((item) => {
      item.setTitle("Not reviewed");
      item.setChecked(!isReviewed);
      item.onClick(() =>
        this.plugin.runAsync(this.plugin.markUnreviewed(), "mark unreviewed"),
      );
    });

    menu.showAtMouseEvent(event);
  };

  // Obsidian's own `is-hidden` rules are scoped to ribbon and stacked-tab
  // elements, so the class styles nothing on a status-bar item. `toggle` sets
  // inline display, which needs no stylesheet to agree with it.
  private setIsVisible = (isVisible: boolean) => {
    this.element.toggle(isVisible);
  };
}
