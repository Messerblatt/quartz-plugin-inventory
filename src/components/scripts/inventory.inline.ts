/**
 * Browser runtime for the Inventory component.
 *
 * Runs inside a <script> tag after DOMContentLoaded (bundled to a plain JS
 * string by the inline-script-loader), so it is side-effect driven.
 *
 * Items are marked in Obsidian with an ```item fence, which rehype-pretty-code
 * renders as:
 *   <figure data-rehype-pretty-code-figure>
 *     <pre data-language="item" ...><code ...>Item name</code></pre>
 *   </figure>
 * Every such block is a stowable item; the first non-empty line of the block is
 * its name. Ids/anchors are derived from the slugified name so entries survive
 * renames of unrelated pages.
 *
 * Storage layout (localStorage):
 *   quartz:inventory      -> InventoryEntry[] = { slug, title, page, anchor, addedAt }
 *   quartz:inventory:open -> "1" | "0"  (panel open/closed state)
 */

import {
  ITEM_SELECTOR,
  addEntry,
  itemNameFromBlock,
  parseInventory,
  removeEntry,
  serializeInventory,
  slugify,
  sortInventory,
  toggleEntry,
  type InventoryEntry,
} from "../../lib/inventory.ts";

const OPEN_KEY_SUFFIX = ":open";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled (private mode / quota) - fail silently */
  }
}

/** Note slug of the current page, without leading/trailing slash. */
function currentPage(): string {
  const parts = location.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return "index";
  return decodeURIComponent(last);
}

/**
 * Item blocks on this page. Both the <pre> and the nested <code> carry
 * `data-language="item"`, so keep only the outermost match of each block and
 * never descend into an already-matched element.
 */
function itemBlocks(): HTMLElement[] {
  const blocks: HTMLElement[] = [];

  for (const el of Array.from(document.querySelectorAll<HTMLElement>(ITEM_SELECTOR))) {
    // Skip anything nested inside an already collected block.
    if (el.parentElement?.closest(ITEM_SELECTOR)) continue;
    blocks.push(el);
  }

  return blocks;
}

interface DiscoveredItem {
  el: HTMLElement;
  title: string;
  slug: string;
  anchor: string;
}

function discoverItems(): DiscoveredItem[] {
  const page = currentPage();
  const items: DiscoveredItem[] = [];
  const used = new Map<string, number>();

  for (const el of itemBlocks()) {
    const title = itemNameFromBlock(el.textContent);
    if (!title) continue;

    const base = slugify(title) || "item";
    // De-duplicate anchors when a page repeats the same item name.
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const anchor = seen === 0 ? base : `${base}-${seen}`;
    const slug = `${page}#${anchor}`;

    el.setAttribute("data-inventory-item", anchor);
    el.classList.add("inventory-item-block");

    items.push({ el, title, slug, anchor });
  }

  return items;
}

function entryFor(item: DiscoveredItem): InventoryEntry {
  return {
    slug: item.slug,
    title: item.title,
    page: currentPage(),
    anchor: item.anchor,
    addedAt: new Date().toISOString(),
  };
}

/** Per-item toggle button, injected into the figure wrapping the item block. */
function mountItemButton(root: HTMLElement, item: DiscoveredItem, storageKey: string) {
  if (item.el.querySelector("[data-inventory-item-toggle]")) return;

  const figure = item.el.closest("figure") ?? item.el;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "inventory-item-toggle";
  button.setAttribute("data-inventory-item-toggle", item.slug);
  button.setAttribute("aria-label", `Stash ${item.title} in your inventory`);

  const sync = (entries: InventoryEntry[]) => {
    const stashed = entries.some((e) => e.slug === item.slug);
    button.textContent = stashed ? "\u2713 Stashed" : "+ Stash";
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
  };

  sync(parseInventory(read(storageKey)));

  button.addEventListener("click", () => {
    const next = toggleEntry(parseInventory(read(storageKey)), entryFor(item));
    write(storageKey, serializeInventory(next));
    sync(next);
    render(root, next);
  });

  figure.appendChild(button);
}

function setBadge(root: HTMLElement, count: number) {
  const badge = root.querySelector<HTMLElement>("[data-inventory-count]");
  if (badge) badge.textContent = String(count);
}

function render(root: HTMLElement, entries: InventoryEntry[]) {
  const list = root.querySelector<HTMLElement>("[data-inventory-items]");
  const empty = root.querySelector<HTMLElement>("[data-inventory-empty]");
  const clear = root.querySelector<HTMLElement>("[data-inventory-clear]");
  const panel = root.querySelector<HTMLElement>("[data-inventory-panel]");
  const toggle = root.querySelector<HTMLElement>("[data-inventory-toggle]");

  setBadge(root, entries.length);

  if (toggle && panel) {
    toggle.setAttribute("aria-expanded", String(!panel.hasAttribute("hidden")));
  }

  if (empty) empty.toggleAttribute("hidden", entries.length > 0);
  if (clear) clear.toggleAttribute("hidden", entries.length === 0);
  if (!list) return;

  list.textContent = "";

  for (const entry of sortInventory(entries)) {
    const li = document.createElement("li");
    li.className = "inventory-entry";
    li.setAttribute("data-inventory-slug", entry.slug);

    const link = document.createElement("a");
    link.className = "inventory-link";
    link.href = entry.page === "index" ? `/#${entry.anchor}` : `/${entry.page}#${entry.anchor}`;
    link.textContent = entry.title;

    const meta = document.createElement("span");
    meta.className = "inventory-meta";
    meta.textContent = new Date(entry.addedAt).toLocaleDateString();

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "inventory-remove";
    remove.setAttribute("data-inventory-remove", entry.slug);
    remove.setAttribute("aria-label", `Remove ${entry.title} from inventory`);
    remove.textContent = "\u00d7";

    li.append(link, meta, remove);
    list.append(li);
  }
}

/** Keep every item button on the page in sync with stored state. */
function refreshItemButtons(entries: InventoryEntry[]) {
  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>("[data-inventory-item-toggle]"),
  )) {
    const slug = button.getAttribute("data-inventory-item-toggle");
    const stashed = slug != null && entries.some((e) => e.slug === slug);
    button.textContent = stashed ? "\u2713 Stashed" : "+ Stash";
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
  }
}

function init() {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>("[data-inventory]"))) {
    const storageKey = root.getAttribute("data-inventory-key") ?? "quartz:inventory";
    const openKey = storageKey + OPEN_KEY_SUFFIX;
    const panel = root.querySelector<HTMLElement>("[data-inventory-panel]");

    const setOpen = (open: boolean) => {
      if (panel) panel.toggleAttribute("hidden", !open);
      root
        .querySelector<HTMLElement>("[data-inventory-toggle]")
        ?.setAttribute("aria-expanded", String(open));
      write(openKey, open ? "1" : "0");
    };

    root
      .querySelector<HTMLElement>("[data-inventory-toggle]")
      ?.addEventListener("click", () => {
        setOpen(panel ? panel.hasAttribute("hidden") : true);
      });

    root
      .querySelector<HTMLElement>("[data-inventory-clear]")
      ?.addEventListener("click", () => {
        const next: InventoryEntry[] = [];
        write(storageKey, serializeInventory(next));
        render(root, next);
        refreshItemButtons(next);
      });

    root.addEventListener("click", (event) => {
      const slug = (event.target as HTMLElement | null)?.getAttribute?.("data-inventory-remove");
      if (!slug) return;
      event.preventDefault();
      const next = removeEntry(parseInventory(read(storageKey)), slug);
      write(storageKey, serializeInventory(next));
      render(root, next);
      refreshItemButtons(next);
    });

    if (read(openKey) === "1") setOpen(true);

    const entries = parseInventory(read(storageKey));
    render(root, entries);

    for (const item of discoverItems()) {
      mountItemButton(root, item, storageKey);
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
