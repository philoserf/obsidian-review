// Preload: mock the obsidian package before any test file imports it.
import { mock } from "bun:test";

mock.module("obsidian", () => {
  class Plugin {}
  class PluginSettingTab {}
  class Modal {
    open() {}
    close() {}
    onClose = () => {};
    contentEl = { createEl: () => ({}) };
    setTitle(_t: string) {
      return this;
    }
  }
  class Notice {}
  class Menu {
    addItem(_cb: unknown) {
      return this;
    }
    showAtMouseEvent(_e: unknown) {}
  }
  class Setting {
    setName(_n: string) {
      return this;
    }
    setDesc(_d: string) {
      return this;
    }
    addButton(_cb: unknown) {
      return this;
    }
    addToggle(_cb: unknown) {
      return this;
    }
  }
  class SuggestModal {
    open() {}
    setPlaceholder(_p: string) {}
  }
  class TFolder {}
  class AbstractInputSuggest {
    setValue(_v: string) {
      return this;
    }
    close() {}
  }

  const debounce = <T extends (...args: unknown[]) => unknown>(
    fn: T,
    _ms: number,
    _resetTimer?: boolean,
  ): T => fn;

  return {
    Plugin,
    PluginSettingTab,
    Modal,
    Notice,
    Menu,
    Setting,
    SuggestModal,
    TFolder,
    AbstractInputSuggest,
    debounce,
  };
});
