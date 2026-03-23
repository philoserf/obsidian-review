import { AbstractInputSuggest, type App, type TFolder } from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private onSelectCallback?: (value: string) => void;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    onSelectCallback?: (value: string) => void,
  ) {
    super(app, inputEl);
    this.onSelectCallback = onSelectCallback;
  }

  getSuggestions(query: string): TFolder[] {
    const lowerQuery = query.toLowerCase();
    return this.app.vault
      .getAllFolders()
      .filter((folder) => folder.path.toLowerCase().contains(lowerQuery));
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    this.onSelectCallback?.(folder.path);
    this.close();
  }
}
