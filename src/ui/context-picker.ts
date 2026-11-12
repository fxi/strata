/**
 * The CONTEXT dialog: the prepared contexts of `contexts/index.json` to open,
 * a context file to import (validated against the schema), the current
 * context and view to export as a file, and a context file to open by URL.
 * Opening a context loads its page: `/strata/<id>`.
 */

import {
  IMPORTED,
  contextHref,
  contextsUrl,
  listContexts,
  localize,
  parseContext,
  storeImported,
} from "../context/load";
import type { StrataContext } from "../context/types";

export interface ContextPickerOptions {
  button: HTMLButtonElement;
  /** Id of the open context, if any. */
  current?: string;
  /** The open context with the current view, for export. */
  snapshot?: () => StrataContext;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) {
    node.className = className;
  }
  return node;
}

/** Saves text as a file. */
export function saveFile(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = element("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export class ContextPicker {
  readonly dialog: HTMLElement;
  private backdrop: HTMLElement;
  private message: HTMLElement;
  private list: HTMLElement;
  private exportButton: HTMLButtonElement;

  constructor(private options: ContextPickerOptions) {
    this.backdrop = element("div", "", "context-backdrop");
    this.backdrop.hidden = true;
    this.dialog = element("section", "", "context-picker");
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-label", "Contexts");
    this.backdrop.append(this.dialog);
    document.body.append(this.backdrop);

    const header = element("header");
    header.append(element("h2", "CONTEXTS"));
    const close = element("button", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.close());
    header.append(close);

    this.list = element("div", "", "context-list");
    this.message = element("pre", "", "context-message");
    this.message.hidden = true;

    const file = element("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.hidden = true;
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      file.value = "";
      if (chosen) {
        void this.import(chosen);
      }
    });
    const importButton = element("button", "Import file…");
    importButton.type = "button";
    importButton.addEventListener("click", () => file.click());
    const exportButton = (this.exportButton = element(
      "button",
      "Export current",
    ));
    exportButton.type = "button";
    exportButton.disabled = !options.snapshot;
    exportButton.title =
      "The context and the current view, as a .strata.json file";
    exportButton.addEventListener("click", () => this.export());
    const schema = element("a", "Schema");
    schema.href = `${contextsUrl()}schema.json`;
    schema.target = "_blank";
    schema.rel = "noopener";
    const files = element("div", "", "context-actions");
    files.append(importButton, exportButton, schema, file);

    const form = element("form", "", "context-url");
    const input = element("input");
    input.type = "url";
    input.placeholder = "https://…/my-context.json";
    input.setAttribute("aria-label", "Context file URL");
    const open = element("button", "Open URL");
    open.type = "submit";
    form.append(input, open);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const url = input.value.trim();
      if (url) {
        location.href = `${contextHref("")}?config=${encodeURIComponent(url)}`;
      }
    });

    this.dialog.append(header, this.list, files, form, this.message);

    options.button.addEventListener("click", () => this.toggle());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.close();
      }
    });
    this.backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === this.backdrop) {
        this.close();
      }
    });
  }

  /** The open context's id, marked in the list. */
  setCurrent(id: string): void {
    this.options.current = id;
  }

  /** Enables export of the open context and its view. */
  setSnapshot(snapshot: () => StrataContext): void {
    this.options.snapshot = snapshot;
    this.exportButton.disabled = false;
  }

  toggle(): void {
    if (this.backdrop.hidden) {
      this.open();
    } else {
      this.close();
    }
  }

  open(): void {
    this.backdrop.hidden = false;
    this.options.button.setAttribute("aria-expanded", "true");
    void this.renderList();
  }

  close(): void {
    this.backdrop.hidden = true;
    this.options.button.setAttribute("aria-expanded", "false");
  }

  private say(text: string | null, error = false): void {
    this.message.hidden = !text;
    this.message.textContent = text ?? "";
    this.message.classList.toggle("is-error", error);
  }

  private async renderList(): Promise<void> {
    this.list.replaceChildren(element("p", "Reading contexts…", "muted"));
    try {
      const contexts = await listContexts();
      this.list.replaceChildren(
        ...contexts.map((listing) => {
          const card = element("a", "", "context-card");
          card.href = contextHref(listing.id);
          if (listing.id === this.options.current) {
            card.classList.add("is-current");
            card.setAttribute("aria-current", "page");
          }
          card.append(
            element("strong", localize(listing.title)),
            element("span", localize(listing.description)),
            element("code", `/${listing.id}`),
          );
          return card;
        }),
      );
    } catch (error) {
      this.list.replaceChildren(
        element("p", `Cannot read the contexts: ${String(error)}`, "muted"),
      );
    }
  }

  private async import(file: File): Promise<void> {
    try {
      const context = parseContext(JSON.parse(await file.text()), file.name);
      storeImported(context);
      this.say(`Opening ${localize(context.title)}…`);
      location.href = contextHref(IMPORTED);
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error), true);
    }
  }

  private export(): void {
    const context = this.options.snapshot?.();
    if (!context) {
      return;
    }
    saveFile(
      `${context.id}.strata.json`,
      `${JSON.stringify(context, null, 2)}\n`,
      "application/json",
    );
  }
}
