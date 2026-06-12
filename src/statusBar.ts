import { Menu } from "obsidian";
import type ReviewPlugin from "./plugin";

export class StatusBar {
  private element: HTMLElement;
  private plugin: ReviewPlugin;
  private statusSpan: Element;

  constructor(element: HTMLElement, plugin: ReviewPlugin) {
    this.element = element;
    this.plugin = plugin;
    this.statusSpan = element.createSpan("status");

    this.statusSpan.setText("Not reviewed");
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

    this.setIsVisible(this.plugin.data.showStatusBar);

    if (status === "reviewed") {
      this.statusSpan.setText("Reviewed");
    } else {
      this.statusSpan.setText("Not reviewed");
    }
  };

  private onClick = (event: MouseEvent) => {
    const status = this.plugin.getActiveFileStatus();
    if (!status) return;

    const isReviewed = status === "reviewed";
    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle("Reviewed");
      item.setChecked(isReviewed);
      item.onClick(() => this.plugin.markReviewed());
    });
    menu.addItem((item) => {
      item.setTitle("Not reviewed");
      item.setChecked(!isReviewed);
      item.onClick(() => this.plugin.markUnreviewed());
    });

    menu.showAtMouseEvent(event);
  };

  private setIsVisible = (isVisible: boolean) => {
    this.element.toggleClass("is-hidden", !isVisible);
  };
}
