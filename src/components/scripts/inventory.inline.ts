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
  DEFAULT_CATEGORY,
  DEFAULT_STORAGE_KEY,
  ITEM_SELECTOR,
  addEntry,
  isItemCategory,
  itemNameFromBlock,
  parseInventory,
  removeEntry,
  serializeInventory,
  slugify,
  sortInventory,
  toggleEntry,
  truncateTitle,
  type InventoryEntry,
  type ItemCategory,
} from "../../lib/inventory.ts";

const OPEN_KEY_SUFFIX = ":open";
const ROOT_SELECTOR = "[data-inventory]";
const ITEM_TITLE_ATTR = "data-inventory-item-title";

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

/**
 * Path of the current page, without the leading slash but with any trailing
 * slash and subpath intact, so `/${page}` rebuilds the exact URL we came from.
 * (Quartz emits both `foo` and `foo/` style URLs depending on config.)
 */
function currentPage(): string {
  const path = decodeURIComponent(location.pathname).replace(/^\/+/, "");
  if (path === "" || path === "index" || path === "index/") return "index";
  return path;
}

/** Fence language of a block, i.e. the category it belongs to. */
function blockCategory(el: HTMLElement): ItemCategory {
  const language = el.getAttribute("data-language");
  return isItemCategory(language) ? language : DEFAULT_CATEGORY;
}

/** Storage key of the (first) inventory panel on the page, or the default. */
function storageKeyFor(doc: Document = document): string {
  return (
    doc.querySelector<HTMLElement>(ROOT_SELECTOR)?.getAttribute("data-inventory-key") ??
    DEFAULT_STORAGE_KEY
  );
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
  category: ItemCategory;
}

/**
 * Tag blank rendered lines so CSS can drop them. rehype-pretty-code wraps every
 * line in `span[data-line]`, and the fence's leading/trailing newline shows up
 * as an empty line around the item name. Without this, a one-line fence whose
 * only span *is* the name would be hidden by a `:last-child` rule and render
 * as an empty block.
 */
function markBlankLines(el: HTMLElement) {
  for (const line of Array.from(el.querySelectorAll<HTMLElement>("span[data-line]"))) {
    line.classList.toggle("is-blank-line", line.textContent?.trim() === "");
  }
}

/**
 * The item name, read from the rendered lines only. rehype-pretty-code injects
 * a "copy source" clipboard button into the block, so the block's raw
 * textContent would otherwise start with the button's label instead of the
 * item name.
 */
function itemTitle(el: HTMLElement): string {
  const lines = el.querySelectorAll<HTMLElement>("span[data-line]");
  if (lines.length > 0) {
    for (const line of Array.from(lines)) {
      const name = itemNameFromBlock(line.textContent);
      if (name) return name;
    }
    return "";
  }
  return itemNameFromBlock(el.textContent);
}

function discoverItems(): DiscoveredItem[] {
  const page = currentPage();
  const items: DiscoveredItem[] = [];
  const used = new Map<string, number>();

  for (const el of itemBlocks()) {
    markBlankLines(el);
    // ```item is the default; ```event / ```secret and friends get their own.
    const category = blockCategory(el);

    // Prefer the rendered text; fall back to the title captured on a previous
    // run so a block whose text is hidden (stashed) still gets its button.
    const title = itemTitle(el) || el.getAttribute(ITEM_TITLE_ATTR) || "";
    if (!title) continue;

    const base = slugify(title) || "item";
    // De-duplicate anchors when a page repeats the same item name.
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const anchor = seen === 0 ? base : `${base}-${seen}`;
    const slug = `${page}#${anchor}`;

    el.setAttribute("data-inventory-item", anchor);
    el.setAttribute(ITEM_TITLE_ATTR, title);
    el.setAttribute("data-inventory-category", category);
    el.classList.add("inventory-item-block");
    el.classList.add(`inventory-item-block--${category}`);

    items.push({ el, title, slug, anchor, category });
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
    category: item.category,
  };
}

/** Per-item toggle button, injected into the figure wrapping the item block. */
function mountItemButton(item: DiscoveredItem, storageKey: string) {
  const figure = item.el.closest("figure") ?? item.el;
  // The button lives on the figure, not inside the block, so guard on it (or on
  // the block itself) - otherwise every re-run would stack up another button.
  const existing = figure.querySelector<HTMLElement>("[data-inventory-item-toggle]");
  if (existing) {
    if (existing.getAttribute("data-inventory-item-toggle") === item.slug) return;
    existing.remove();
  }

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
    // A stashed item keeps its block (and anchor) but shows no text.
    item.el.classList.toggle("is-stashed-item", stashed);
  };

  sync(parseInventory(read(storageKey)));

  button.addEventListener("click", () => {
    const next = toggleEntry(parseInventory(read(storageKey)), entryFor(item));
    write(storageKey, serializeInventory(next));
    syncAll(next);
  });

  figure.appendChild(button);
}

function setBadge(root: HTMLElement, count: number) {
  const badge = root.querySelector<HTMLElement>("[data-inventory-count]");
  if (badge) badge.textContent = String(count);
}

function render(root: HTMLElement, entries: InventoryEntry[]) {
  const empty = root.querySelector<HTMLElement>("[data-inventory-empty]");
  const panel = root.querySelector<HTMLElement>("[data-inventory-panel]");
  const toggle = root.querySelector<HTMLElement>("[data-inventory-toggle]");

  setBadge(root, entries.length);

  if (toggle && panel) {
    toggle.setAttribute("aria-expanded", String(!panel.hasAttribute("hidden")));
  }

  if (empty) empty.toggleAttribute("hidden", entries.length > 0);

  // "Show all" and the in-modal "Clear" are only useful with entries.
  for (const action of Array.from(
    root.querySelectorAll<HTMLElement>(
      "[data-inventory-show-all], [data-inventory-clear]",
    ),
  )) {
    action.toggleAttribute("hidden", entries.length === 0);
  }

  // Both the panel list and the modal list show the same entries.
  for (const list of Array.from(
    root.querySelectorAll<HTMLElement>(
      "[data-inventory-items], [data-inventory-modal-items]",
    ),
  )) {
    fillList(list, entries);
  }
}

function fillList(list: HTMLElement, entries: InventoryEntry[]) {
  list.textContent = "";

  for (const entry of sortInventory(entries)) {
    const li = document.createElement("li");
    li.className = "inventory-entry";
    li.setAttribute("data-inventory-slug", entry.slug);
    li.setAttribute("data-inventory-category", entry.category);

    // Plain text, not a link: the entry keeps the full title, the preview is
    // shortened so a long item name cannot blow up the panel or the modal.
    const name = document.createElement("span");
    name.className = "inventory-name";
    name.textContent = truncateTitle(entry.title);
    // Full title available on hover / to assistive tech.
    name.title = entry.title;
    if (truncateTitle(entry.title) !== entry.title.trim()) {
      name.setAttribute("aria-label", entry.title);
    }

    const category = document.createElement("span");
    category.className = "inventory-tag";
    category.textContent = entry.category;

    const meta = document.createElement("span");
    meta.className = "inventory-meta";
    meta.textContent = new Date(entry.addedAt).toLocaleDateString();

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "inventory-remove";
    remove.setAttribute("data-inventory-remove", entry.slug);
    remove.setAttribute("aria-label", `Remove ${entry.title} from inventory`);
    remove.textContent = "\u00d7";

    li.append(name, category, meta, remove);
    list.append(li);
  }
}

/** Keep every item button (and its block) on the page in sync with stored state. */
function refreshItemButtons(entries: InventoryEntry[]) {
  const isStashed = (slug: string | null) =>
    slug != null && entries.some((e) => e.slug === slug);

  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>("[data-inventory-item-toggle]"),
  )) {
    const stashed = isStashed(button.getAttribute("data-inventory-item-toggle"));
    button.textContent = stashed ? "\u2713 Stashed" : "+ Stash";
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
  }

  // Drive the blocks from their slug (page#anchor) rather than by DOM position,
  // so panels-only updates work even when the block was mounted elsewhere.
  const page = currentPage();
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>("[data-inventory-item]"),
  )) {
    const anchor = el.getAttribute("data-inventory-item");
    el.classList.toggle("is-stashed-item", anchor != null && isStashed(`${page}#${anchor}`));
  }
}

/** Re-render every panel and every item button from `entries`. */
function syncAll(entries: InventoryEntry[]) {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
    render(root, entries);
  }
  refreshItemButtons(entries);
}

/** Discover item blocks and mount their toggle buttons. Idempotent. */
function mountItems() {
  const storageKey = storageKeyFor();
  for (const item of discoverItems()) {
    mountItemButton(item, storageKey);
  }
  refreshItemButtons(parseInventory(read(storageKey)));
}

/** Hide the "Show all" modal and release the scroll lock. */
function closeModal(root: HTMLElement) {
  root.querySelector<HTMLElement>("[data-inventory-modal]")?.setAttribute("hidden", "");
  if (!document.querySelector("[data-inventory-modal]:not([hidden])")) {
    document.documentElement.classList.remove("inventory-modal-open");
  }
}

function initRoot(root: HTMLElement) {
  // `init` runs again after client-side navigation; never double-bind.
  if (root.hasAttribute("data-inventory-ready")) return;
  root.setAttribute("data-inventory-ready", "");

  const storageKey = root.getAttribute("data-inventory-key") ?? DEFAULT_STORAGE_KEY;
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
      syncAll(next);
      closeModal(root);
    });

  // --- "Show all" modal ---------------------------------------------------
  const modal = root.querySelector<HTMLElement>("[data-inventory-modal]");

  const openModal = () => {
    if (!modal) return;
    render(root, parseInventory(read(storageKey)));
    modal.removeAttribute("hidden");
    document.documentElement.classList.add("inventory-modal-open");
    (modal.querySelector<HTMLElement>("[data-inventory-modal-close]") ??
      modal)?.focus?.();
  };

  const closeDialog = () => closeModal(root);

  root
    .querySelector<HTMLElement>("[data-inventory-show-all]")
    ?.addEventListener("click", openModal);
  modal
    ?.querySelector<HTMLElement>("[data-inventory-modal-backdrop]")
    ?.addEventListener("click", closeDialog);
  modal
    ?.querySelector<HTMLElement>("[data-inventory-modal-close]")
    ?.addEventListener("click", closeDialog);
  // Clicking the backdrop but not the dialog must not close.
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hasAttribute("hidden")) closeDialog();
  });

  root.addEventListener("click", (event) => {
    const slug = (event.target as HTMLElement | null)?.getAttribute?.("data-inventory-remove");
    if (!slug) return;
    event.preventDefault();
    const next = removeEntry(parseInventory(read(storageKey)), slug);
    write(storageKey, serializeInventory(next));
    syncAll(next);
  });

  if (read(openKey) === "1") setOpen(true);
  render(root, parseInventory(read(storageKey)));
}

function init() {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
    initRoot(root);
  }
  // Item blocks are stowable even on pages that render no inventory panel.
  mountItems();
}

/**
 * Quartz swaps page content without a reload, so freshly inserted item blocks
 * would never get their buttons. Re-run (idempotently) after every navigation.
 */
function watchNavigation() {
  let queued = false;
  const rerun = () => {
    if (queued) return;
    queued = true;
    const run = () => {
      queued = false;
      init();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  };

  for (const type of ["popstate", "hashchange", "nav"] as const) {
    window.addEventListener(type, rerun);
  }
  document.addEventListener("nav:end", rerun as EventListener);

  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function patched(this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      rerun();
      return result;
    };
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    init();
    watchNavigation();
  }, { once: true });
} else {
  init();
  watchNavigation();
}
