/**
 * The palette menu: a button showing the chosen ramp, opening a list of the
 * palettes offered (a swatch and a name each, grouped sequential / diverging).
 * Arrow keys move, Enter picks, Escape or a click outside closes.
 */

import { rampBytes, rampColor, type PaletteInfo } from "../palettes";

/** A CSS gradient of a palette, for swatches. */
export function paletteGradient(id: string): string {
  const bytes = rampBytes(id);
  const stops = Array.from({ length: 12 }, (_, i) => {
    const t = i / 11;
    const [r, g, b] = rampColor(bytes, t);
    return `rgb(${r}, ${g}, ${b}) ${(t * 100).toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

const GROUPS: Record<PaletteInfo["kind"], string> = {
  sequential: "SEQUENTIAL",
  diverging: "DIVERGING",
};

export class PaletteMenu {
  readonly element: HTMLElement;
  private button: HTMLButtonElement;
  private list: HTMLElement;
  private options: PaletteInfo[] = [];
  private selected = "";

  constructor(private onPick: (id: string) => void) {
    this.element = document.createElement("div");
    this.element.className = "palette-menu";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "palette-button";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    this.list = document.createElement("div");
    this.list.className = "palette-list";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Palette");
    this.list.hidden = true;
    this.element.append(this.button, this.list);

    this.button.addEventListener("click", () =>
      this.list.hidden ? this.open() : this.close(),
    );
    this.button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.open();
      }
    });
    this.list.addEventListener("keydown", (event) => {
      const items = [
        ...this.list.querySelectorAll<HTMLElement>("[role=option]"),
      ];
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        this.button.focus();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!this.list.hidden && !this.element.contains(event.target as Node)) {
        this.close();
      }
    });
  }

  /** The palettes offered and the chosen one. */
  set(options: PaletteInfo[], selected: string): void {
    this.options = options;
    this.selected = selected;
    const chosen = options.find((option) => option.id === selected);
    this.button.replaceChildren(
      this.swatch(selected),
      Object.assign(document.createElement("span"), {
        className: "palette-name",
        textContent: (chosen?.label ?? selected).toUpperCase(),
      }),
      Object.assign(document.createElement("span"), {
        className: "palette-caret",
        textContent: "▾",
      }),
    );
    this.button.title = `Palette: ${chosen?.label ?? selected}`;
    this.element.hidden = options.length < 2;
    if (!this.list.hidden) {
      this.renderList();
    }
  }

  private swatch(id: string): HTMLElement {
    const swatch = document.createElement("span");
    swatch.className = "palette-swatch";
    swatch.style.background = paletteGradient(id);
    return swatch;
  }

  private renderList(): void {
    const kinds = new Set(this.options.map((option) => option.kind));
    const nodes: HTMLElement[] = [];
    for (const kind of ["sequential", "diverging"] as const) {
      const group = this.options.filter((option) => option.kind === kind);
      if (!group.length) {
        continue;
      }
      if (kinds.size > 1) {
        const heading = document.createElement("div");
        heading.className = "palette-group";
        heading.textContent = GROUPS[kind];
        nodes.push(heading);
      }
      for (const option of group) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "palette-option";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(option.id === this.selected));
        item.append(
          this.swatch(option.id),
          Object.assign(document.createElement("span"), {
            textContent: option.label.toUpperCase(),
          }),
        );
        item.addEventListener("click", () => {
          this.close();
          this.onPick(option.id);
          this.button.focus();
        });
        nodes.push(item);
      }
    }
    this.list.replaceChildren(...nodes);
  }

  /** Fixed over the page (the side column scrolls and would clip it): above the button, or below when there is more room. */
  private place(): void {
    const rect = this.button.getBoundingClientRect();
    const style = this.list.style;
    style.left = `${rect.left}px`;
    style.width = `${Math.max(rect.width, 220)}px`;
    const above = rect.top - 12;
    const below = window.innerHeight - rect.bottom - 12;
    if (above >= below) {
      style.top = "auto";
      style.bottom = `${window.innerHeight - rect.top + 4}px`;
      style.maxHeight = `${Math.min(420, above)}px`;
    } else {
      style.bottom = "auto";
      style.top = `${rect.bottom + 4}px`;
      style.maxHeight = `${Math.min(420, below)}px`;
    }
  }

  open(): void {
    this.renderList();
    this.list.hidden = false;
    this.place();
    this.button.setAttribute("aria-expanded", "true");
    const current =
      this.list.querySelector<HTMLElement>("[aria-selected=true]") ??
      this.list.querySelector<HTMLElement>("[role=option]");
    current?.focus();
    current?.scrollIntoView({ block: "nearest" });
  }

  close(): void {
    this.list.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
  }
}
