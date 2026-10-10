/**
 * Browser runtime for the Inventory component.
 *
 * Runs inside a <script> tag after DOMContentLoaded (bundled to a plain JS
 * string by the inline-script-loader), so it is side-effect driven.
 *
 * Items are marked in Obsidian with an ```item fence (```event and ```secret
 * work too), which rehype-pretty-code renders as:
 *   <figure data-rehype-pretty-code-figure>
 *     <pre data-language="item" ...><code ...>Item name</code></pre>
 *   </figure>
 * The first non-empty line is the item name; optional following lines may carry
 * a quantity (`x3`) and a location (`Location: Cellar`). Anchors are derived
 * from the slugified name, so entries survive renames of unrelated pages.
 *
 * Persistence: IndexedDB (via Dexie, see ../../lib/db.ts). Each entry stores
 * { slug, name, category, quantity, location, timestamp, page, anchor }.
 * The panel's open/closed flag stays in localStorage - it is a single byte and
 * must be readable synchronously while the panel renders.
 */

import {
  DEFAULT_CATEGORY,
  DEFAULT_STORAGE_KEY,
  ITEM_SELECTOR,
  isItemCategory,
  itemDetailsFromBlock,
  itemNameFromBlock,
  normalizeQuantity,
  slugify,
  sortInventory,
  truncateTitle,
  type InventoryEntry,
  type ItemCategory,
} from "../../lib/inventory.ts";
import {
  openInventoryStore,
  requestPersistentStorage,
  type InventoryStore,
} from "../../lib/db.ts";

const OPEN_KEY_SUFFIX = ":open";
const ROOT_SELECTOR = "[data-inventory]";
const ITEM_NAME_ATTR = "data-inventory-item-title";

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
 * slash and subpath intact, so the stored slug round-trips.
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

// --- Store -----------------------------------------------------------------

/** One store per storage key, opened lazily and cached for the page. */
const stores = new Map<string, Promise<InventoryStore>>();

function storeFor(storageKey: string): Promise<InventoryStore> {
  const existing = stores.get(storageKey);
  if (existing) return existing;
  const created = openInventoryStore(storageKey).catch((error: unknown) => {
    // Keep the panel usable (empty) if IndexedDB is unavailable, e.g. private
    // mode with storage disabled.
    console.warn("[inventory] IndexedDB unavailable, inventory is disabled", error);
    stores.delete(storageKey);
    throw error;
  });
  stores.set(storageKey, created);
  return created;
}

// --- Item discovery --------------------------------------------------------

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
  name: string;
  slug: string;
  anchor: string;
  category: ItemCategory;
  quantity: number;
  location: string;
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
function itemName(el: HTMLElement): string {
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

/** Raw fence text (all rendered lines), used to read quantity/location hints. */
function itemBlockText(el: HTMLElement): string {
  const lines = Array.from(el.querySelectorAll<HTMLElement>("span[data-line]"));
  const source = lines.length > 0 ? lines : [el];
  return source
    .map((line) => line.textContent ?? "")
    .join("\n")
    .trim();
}

function discoverItems(): DiscoveredItem[] {
  const page = currentPage();
  const items: DiscoveredItem[] = [];
  const used = new Map<string, number>();

  for (const el of itemBlocks()) {
    markBlankLines(el);
    // ```item is the default; ```event / ```secret and friends get their own.
    const category = blockCategory(el);

    // Prefer the rendered text; fall back to the name captured on a previous
    // run so a block whose text is hidden (stashed) still gets its button.
    const name = itemName(el) || el.getAttribute(ITEM_NAME_ATTR) || "";
    if (!name) continue;

    const details = itemDetailsFromBlock(itemBlockText(el));
    // A stashed block has no visible text, so its hints cannot be re-read.
    const stashed = el.classList.contains("is-stashed-item");
    const quantity = stashed ? 1 : details.quantity;
    const location = stashed ? "" : details.location;

    const base = slugify(name) || "item";
    // De-duplicate anchors when a page repeats the same item name.
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const anchor = seen === 0 ? base : `${base}-${seen}`;
    const slug = `${page}#${anchor}`;

    el.setAttribute("data-inventory-item", anchor);
    el.setAttribute(ITEM_NAME_ATTR, name);
    el.setAttribute("data-inventory-category", category);
    el.classList.add("inventory-item-block");
    el.classList.add(`inventory-item-block--${category}`);

    items.push({ el, name, slug, anchor, category, quantity, location });
  }

  return items;
}

/** The entry a block maps to when stashed. Existing entries keep their
 *  quantity/location so re-stashing never resets them. */
function entryFor(item: DiscoveredItem, existing?: InventoryEntry): InventoryEntry {
  return {
    slug: item.slug,
    name: item.name,
    category: item.category,
    quantity: existing?.quantity ?? item.quantity,
    location: existing?.location ?? item.location,
    timestamp: existing?.timestamp ?? new Date().toISOString(),
    page: currentPage(),
    anchor: item.anchor,
  };
}

// --- Rendering -------------------------------------------------------------

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
  // so panel-only updates work even when the block was mounted elsewhere.
  const page = currentPage();
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>("[data-inventory-item]"),
  )) {
    const anchor = el.getAttribute("data-inventory-item");
    el.classList.toggle("is-stashed-item", anchor != null && isStashed(`${page}#${anchor}`));
  }
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
    fillList(list, entries, list.hasAttribute("data-inventory-modal-items"));
  }
}

function fillList(list: HTMLElement, entries: InventoryEntry[], detailed: boolean) {
  list.textContent = "";

  for (const entry of sortInventory(entries)) {
    const li = document.createElement("li");
    li.className = "inventory-entry";
    li.setAttribute("data-inventory-slug", entry.slug);
    li.setAttribute("data-inventory-category", entry.category);

    // Plain text, not a link: the entry keeps the full name, the preview is
    // shortened so a long item name cannot blow up the panel or the modal.
    const name = document.createElement("span");
    name.className = "inventory-name";
    name.textContent = truncateTitle(entry.name);
    // Full name available on hover / to assistive tech.
    name.title = entry.name;
    if (truncateTitle(entry.name) !== entry.name.trim()) {
      name.setAttribute("aria-label", entry.name);
    }

    const category = document.createElement("span");
    category.className = "inventory-tag";
    category.textContent = entry.category;

    const quantity = document.createElement(detailed ? "input" : "span");
    quantity.className = "inventory-quantity";
    quantity.setAttribute("data-inventory-quantity", entry.slug);
    quantity.setAttribute("aria-label", `Quantity of ${entry.name}`);
    if (detailed) {
      const input = quantity as HTMLInputElement;
      input.type = "number";
      input.min = "1";
      input.max = "999";
      input.value = String(entry.quantity);
      input.title = "Quantity";
    } else {
      quantity.textContent = `\u00d7${entry.quantity}`;
      quantity.title = `Quantity: ${entry.quantity}`;
    }

    const location = document.createElement(detailed ? "input" : "span");
    location.className = "inventory-location";
    location.setAttribute("data-inventory-location", entry.slug);
    location.setAttribute("aria-label", `Where ${entry.name} was found`);
    if (detailed) {
      const input = location as HTMLInputElement;
      input.type = "text";
      input.placeholder = "Where found?";
      input.value = entry.location;
    } else {
      location.textContent = entry.location;
      location.hidden = entry.location.length === 0;
      if (entry.location) location.title = `Found in ${entry.location}`;
    }

    const meta = document.createElement("span");
    meta.className = "inventory-meta";
    meta.textContent = new Date(entry.timestamp).toLocaleDateString();

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "inventory-remove";
    remove.setAttribute("data-inventory-remove", entry.slug);
    remove.setAttribute("aria-label", `Remove ${entry.name} from inventory`);
    remove.textContent = "\u00d7";

    li.append(name, category, quantity, location, meta, remove);
    list.append(li);
  }
}

/** Re-render every panel and every item button from `entries`. */
function syncAll(entries: InventoryEntry[]) {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
    render(root, entries);
  }
  refreshItemButtons(entries);
}

// --- Item buttons ----------------------------------------------------------

/** Per-item toggle button, injected into the figure wrapping the item block. */
function mountItemButton(
  item: DiscoveredItem,
  storageKey: string,
  isStashed: (slug: string) => boolean,
  onToggle: (item: DiscoveredItem) => void,
) {
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
  button.setAttribute("aria-label", `Stash ${item.name} in your inventory`);

  const sync = () => {
    const stashed = isStashed(item.slug);
    button.textContent = stashed ? "\u2713 Stashed" : "+ Stash";
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
    // A stashed item keeps its block (and anchor) but shows no text.
    item.el.classList.toggle("is-stashed-item", stashed);
  };

  sync();

  button.addEventListener("click", () => onToggle(item));

  figure.appendChild(button);
}

/** Discover item blocks and mount their toggle buttons. Idempotent. */
async function mountItems() {
  const storageKey = storageKeyFor();
  const store = await storeFor(storageKey);
  const entries = await store.all();

  for (const item of discoverItems()) {
    mountItemButton(
      item,
      storageKey,
      (slug) => entries.some((e) => e.slug === slug),
      (target) => void toggleItem(store, target),
    );
  }

  refreshItemButtons(entries);
}

/** Stash / unstash a block, then repaint everything from the store. */
async function toggleItem(store: InventoryStore, item: DiscoveredItem) {
  const existing = await store.get(item.slug);
  if (existing) {
    await store.remove(item.slug);
  } else {
    await store.put(entryFor(item));
  }
  syncAll(await store.all());
}

// --- Component wiring ------------------------------------------------------

/** Hide the "Show all" modal and release the scroll lock. */
function closeModal(root: HTMLElement) {
  root.querySelector<HTMLElement>("[data-inventory-modal]")?.setAttribute("hidden", "");
  if (!document.querySelector("[data-inventory-modal]:not([hidden])")) {
    document.documentElement.classList.remove("inventory-modal-open");
  }
}

async function initRoot(root: HTMLElement) {
  // `init` runs again after client-side navigation; never double-bind.
  if (root.hasAttribute("data-inventory-ready")) return;
  root.setAttribute("data-inventory-ready", "");

  const storageKey = root.getAttribute("data-inventory-key") ?? DEFAULT_STORAGE_KEY;
  const openKey = storageKey + OPEN_KEY_SUFFIX;
  const panel = root.querySelector<HTMLElement>("[data-inventory-panel]");

  let store: InventoryStore;
  try {
    store = await storeFor(storageKey);
  } catch {
    render(root, []);
    return;
  }

  const update = async (mutate: (current: InventoryStore) => Promise<void>) => {
    try {
      await mutate(store);
    } catch (error: unknown) {
      console.warn("[inventory] could not update the inventory", error);
    }
    syncAll(await store.all());
  };

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
      void update(async (s) => s.clear()).then(() => closeModal(root));
    });

  // --- "Show all" modal ---------------------------------------------------
  const modal = root.querySelector<HTMLElement>("[data-inventory-modal]");

  const closeDialog = () => closeModal(root);

  root
    .querySelector<HTMLElement>("[data-inventory-show-all]")
    ?.addEventListener("click", () => {
      if (!modal) return;
      // Repaint from the store so the modal is current even if it was opened
      // long after the panel rendered.
      void store.all().then((entries) => render(root, entries)).then(() => {
        modal.removeAttribute("hidden");
        document.documentElement.classList.add("inventory-modal-open");
        modal.querySelector<HTMLElement>("[data-inventory-modal-close]")?.focus();
      });
    });

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

  // Remove buttons, and the quantity/location editors of the modal, are handled
  // by delegation so the lists can be re-rendered freely.
  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const slug = target?.getAttribute?.("data-inventory-remove");
    if (!slug) return;
    event.preventDefault();
    void update((s) => s.remove(slug));
  });

  root.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target?.getAttribute) return;

    const slug = target.getAttribute("data-inventory-quantity");
    if (slug) {
      const quantity = normalizeQuantity(target.value);
      target.value = String(quantity);
      void update(async (s) => {
        const entry = await s.get(slug);
        if (entry) await s.put({ ...entry, quantity });
      });
      return;
    }

    const locationSlug = target.getAttribute("data-inventory-location");
    if (locationSlug) {
      const location = target.value.trim();
      void update(async (s) => {
        const entry = await s.get(locationSlug);
        if (entry) await s.put({ ...entry, location });
      });
    }
  });

  if (read(openKey) === "1") setOpen(true);
  render(root, await store.all());
}

async function init() {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
    await initRoot(root);
  }
  // Item blocks are stowable even on pages that render no inventory panel.
  await mountItems();
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
      void init();
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

/**
 * Ask the browser to keep this origin's data around (IndexedDB included).
 * Without it the inventory can be purged when site data is cleared.
 */
function requestPersistence() {
  void requestPersistentStorage().then((granted) => {
    document.documentElement.setAttribute("data-inventory-persisted", String(granted));
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    requestPersistence();
    void init();
    watchNavigation();
  }, { once: true });
} else {
  requestPersistence();
  void init();
  watchNavigation();
}