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

import PLING_SRC from "../assets/pling.mp3";
import UNPLINK_SRC from "../assets/unplink.mp3";
import {
  DEFAULT_CATEGORY,
  DEFAULT_STORAGE_KEY,
  ITEM_SELECTOR,
  addStashedItem,
  entrySources,
  findMergeTarget,
  findSameBlock,
  isBlockCarried,
  isItemCategory,
  itemDetailsFromBlock,
  itemNameFromBlock,
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
/** Keep in sync with the `.is-stashing` animation in inventory.scss. */
const BLINK_MS = 620;

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

/**
 * Stashed blocks, keyed by anchor, with the comment node left behind in their
 * place.
 *
 * A stashed item is removed from the document entirely - fence, figure and
 * "+ Stash" button - so the page reads like the item was picked up. The element
 * is parked here rather than discarded, and the placeholder remembers where it
 * belongs, so unstashing it later (from the panel's remove button) puts it back
 * exactly where it was instead of leaving a hole.
 */
const parkedBlocks = new Map<string, { figure: HTMLElement; placeholder: Comment }>();

/** Take a stashed block out of the page. Idempotent. */
function parkBlock(anchor: string, figure: HTMLElement) {
  if (parkedBlocks.has(anchor)) return;
  const placeholder = document.createComment(`inventory:stashed:${anchor}`);
  figure.replaceWith(placeholder);
  parkedBlocks.set(anchor, { figure, placeholder });
}

/** Put an unstashed block back where it came from. Idempotent. */
function unparkBlock(anchor: string) {
  const parked = parkedBlocks.get(anchor);
  if (!parked) return;
  parkedBlocks.delete(anchor);
  // The placeholder's parent is gone when Quartz re-rendered the page; the fresh
  // markup is rediscovered and re-parked instead, so drop the stale copy.
  if (parked.placeholder.parentNode) parked.placeholder.replaceWith(parked.figure);
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

  // Parked (stashed) blocks are gone from the document but still hold their
  // anchors. Keep their slots reserved, or the anchors of the blocks after them
  // would shift down and a "kompass-1" would quietly become a "kompass" - a
  // different item in the store. Live blocks take the lowest free slot.
  const taken = new Map<string, Set<number>>();
  for (const anchor of parkedBlocks.keys()) {
    const cut = anchor.lastIndexOf("-");
    const index = cut > 0 ? Number.parseInt(anchor.slice(cut + 1), 10) : NaN;
    const base = Number.isFinite(index) ? anchor.slice(0, cut) : anchor;
    const slot = Number.isFinite(index) ? index : 0;
    if (!taken.has(base)) taken.set(base, new Set());
    taken.get(base)?.add(slot);
  }

  const nextFreeSlot = (base: string): number => {
    let used = taken.get(base);
    if (!used) {
      used = new Set<number>();
      taken.set(base, used);
    }
    let slot = 0;
    while (used.has(slot)) slot += 1;
    used.add(slot);
    return slot;
  };

  for (const el of itemBlocks()) {
    markBlankLines(el);
    // ```item is the default; ```event / ```secret and friends get their own.
    const category = blockCategory(el);

    // Stashed blocks are parked out of the document, so everything below is
    // reading a live block with its text intact.
    const name = itemName(el) || el.getAttribute(ITEM_NAME_ATTR) || "";
    if (!name) continue;

    const details = itemDetailsFromBlock(itemBlockText(el));

    const base = slugify(name) || "item";
    // De-duplicate anchors when a page repeats the same item name.
    const slot = nextFreeSlot(base);
    const anchor = slot === 0 ? base : `${base}-${slot}`;
    const slug = `${page}#${anchor}`;

    el.setAttribute("data-inventory-item", anchor);
    el.setAttribute(ITEM_NAME_ATTR, name);
    el.setAttribute("data-inventory-category", category);
    el.classList.add("inventory-item-block");
    el.classList.add(`inventory-item-block--${category}`);

    items.push({
      el,
      name,
      slug,
      anchor,
      category,
      quantity: details.quantity,
      location: details.location,
    });
  }

  return items;
}

/** The entry a block maps to when stashed. Existing entries keep their
 *  quantity/location/timestamp so re-stashing never resets them. */
function entryFor(item: DiscoveredItem, existing?: InventoryEntry): InventoryEntry {
  return {
    slug: item.slug,
    name: item.name,
    category: item.category,
    quantity: item.quantity,
    location: item.location,
    timestamp: existing?.timestamp ?? new Date().toISOString(),
    page: currentPage(),
    anchor: item.anchor,
    sources: existing ? [...new Set([...entrySources(existing), item.slug])] : [item.slug],
  };
}

// --- Rendering -------------------------------------------------------------

/**
 * Keep every item button (and its block) on the page in sync with the carried
 * items.
 *
 * State is decided by the block's anchor, not by its name: two `kompass` blocks
 * on one page are two items, so stashing one leaves the other as "+ Stash".
 */
function refreshItemButtons(entries: InventoryEntry[]) {
  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>("[data-inventory-item-toggle]"),
  )) {
    const stashed = isCarried(entries, button);
    button.textContent = stashed ? "\u2713 Stashed" : "+ Stash";
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
  }

  // Stashed blocks leave the page entirely - fence, figure and button - so the
  // reader sees a clean page and can no longer re-stash the same block.
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>("[data-inventory-item]"),
  )) {
    const anchor = el.getAttribute("data-inventory-item");
    if (!anchor) continue;
    if (isCarried(entries, el)) parkBlock(anchor, figureOf(el));
    else unparkBlock(anchor);
  }

  // Parked blocks are out of the document, so their buttons cannot be found by
  // the loop above; clear the stale one before the figure goes back in.
  for (const [anchor, parked] of parkedBlocks) {
    const button = parked.figure.querySelector<HTMLElement>("[data-inventory-item-toggle]");
    if (!button) continue;
    const stashed = isCarried(entries, button);
    button.textContent = stashed ? "\u2713 Stashed" : "+ Stash";
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
    if (!stashed) unparkBlock(anchor);
  }
}

/** The <figure> wrapping an item block - what actually leaves the page. */
function figureOf(el: HTMLElement): HTMLElement {
  return el.closest("figure") ?? el;
}

/**
 * Is this element's block the one in the bag? The block carries its page-local
 * anchor in `data-inventory-item`; the button carries the full `page#anchor` slug
 * in `data-inventory-item-toggle`. Both reduce to the same anchor.
 */
function isCarried(entries: InventoryEntry[], el: HTMLElement): boolean {
  const anchor =
    el.getAttribute("data-inventory-item") ??
    el.getAttribute("data-inventory-item-toggle")?.split("#").pop();
  if (!anchor) return false;
  return isBlockCarried(entries, `${currentPage()}#${anchor}`);
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

  // The panel is a narrow sidebar, so it gets the compact list; the "Show all"
  // modal has the width for the full set of columns.
  for (const list of Array.from(root.querySelectorAll<HTMLElement>("[data-inventory-items]"))) {
    fillList(list, entries, { compact: true });
  }

  for (const list of Array.from(
    root.querySelectorAll<HTMLElement>("[data-inventory-modal-items]"),
  )) {
    fillList(list, entries, { compact: false });
  }
}

/**
 * One entry per line: name, category, quantity, location, date and the remove
 * button. All metadata is read-only - it comes from the fence and is never
 * edited in the UI.
 *
 * `compact` drops the quantity and date. In the narrow sidebar they wrapped
 * onto extra lines and pushed the list out of shape; the modal keeps them, and
 * the removed values stay available there and on the entry's tooltips.
 */
function fillList(
  list: HTMLElement,
  entries: InventoryEntry[],
  { compact = false }: { compact?: boolean } = {},
) {
  list.textContent = "";
  list.classList.toggle("inventory-list--compact", compact);

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

    const quantity = document.createElement("span");
    quantity.className = "inventory-quantity";
    quantity.textContent = `\u00d7${entry.quantity}`;
    quantity.title = `Quantity: ${entry.quantity}`;
    quantity.hidden = compact;

    const location = document.createElement("span");
    location.className = "inventory-location";
    location.textContent = entry.location;
    location.hidden = entry.location.length === 0;
    if (entry.location) location.title = `Found in ${entry.location}`;

    const meta = document.createElement("span");
    meta.className = "inventory-meta";
    meta.textContent = new Date(entry.timestamp).toLocaleDateString();
    meta.hidden = compact;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "inventory-remove";
    remove.setAttribute("data-inventory-remove", entry.slug);
    remove.setAttribute("aria-label", `Remove ${entry.name} from inventory`);
    remove.textContent = "\u00d7";

    li.append(name, category, quantity, location, meta, remove);
    // Without the quantity and date to break them up, a row needs to say what
    // it holds on its own.
    if (compact) {
      li.title = [entry.location, `\u00d7${entry.quantity}`, new Date(entry.timestamp).toLocaleDateString()]
        .filter(Boolean)
        .join(" \u00b7 ");
    }
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
  // Carry the item name on the button so state can be refreshed from the store
  // without keeping a reference to the discovered item.
  button.setAttribute(ITEM_NAME_ATTR, item.name);
  button.setAttribute("aria-label", `Stash ${item.name} in your inventory`);

  button.addEventListener("click", () => onToggle(item));

  figure.appendChild(button);
}

/** Discover item blocks and mount their toggle buttons. Idempotent. */
async function mountItems() {
  const storageKey = storageKeyFor();
  const store = await storeFor(storageKey);

  for (const item of discoverItems()) {
    mountItemButton(item, storageKey, (target) => void toggleItem(store, target));
  }

  refreshItemButtons(await store.all());
}

/**
 * Stash / unstash a block, then repaint everything from the store.
 *
 * A block is identified by its anchor, so stashing one `kompass` never touches
 * the other. Only when the same item name was carried from a *different* page
 * does stashing merge into that row's quantity instead of adding a new one.
 */
async function toggleItem(store: InventoryStore, item: DiscoveredItem) {
  const current = await store.all();

  // This exact block is already in the bag: take it back out. A block folded
  // into another page's row is unstashed from that row.
  const own = findSameBlock(current, item.slug);
  if (own) {
    const remaining = entrySources(own).filter((s) => s !== item.slug);
    if (remaining.length === 0) {
      await store.remove(own.slug);
    } else {
      await store.put({
        ...own,
        quantity: Math.max(1, own.quantity - item.quantity),
        sources: remaining,
      });
    }
    syncAll(await store.all());
    celebrateRemoval();
    return;
  }

  // The same item stashed elsewhere on the site: add to its quantity.
  const carried = findMergeTarget(current, currentPage(), item.name);
  if (carried) {
    const [merged] = addStashedItem(entryFor(item, carried), [carried]);
    if (merged) await store.put(merged);
  } else {
    await store.put(entryFor(item));
  }

  syncAll(await store.all());
  celebrate();
}

// --- Feedback ---------------------------------------------------------------

/**
 * The "pling" played when an item is stashed, as an inlined data URI so it
 * works on any static host with no asset pipeline.
 *
 * Autoplay policies reject audio until the page has been interacted with, and
 * every stash is a click, so this normally plays first time. A rejection is
 * swallowed: the inventory is still correct without the sound.
 */
const pling = typeof Audio === "function" ? new Audio(PLING_SRC) : null;
if (pling) pling.volume = 0.4;

/** The softer, descending counterpart, played when something leaves the bag. */
const unplink = typeof Audio === "function" ? new Audio(UNPLINK_SRC) : null;
if (unplink) unplink.volume = 0.35;

/**
 * Play a sound without letting a blocked or missing one interrupt anything.
 * Browsers return a promise that rejects when autoplay is disallowed; some
 * environments return nothing at all, so normalise before catching.
 */
function play(sound: HTMLAudioElement | null) {
  if (!sound) return;
  sound.currentTime = 0;
  void Promise.resolve(sound.play()).catch(() => {
    /* autoplay blocked - the inventory itself is already correct */
  });
}

let blinkTimer: ReturnType<typeof setTimeout> | undefined;

/** Blink the panel so a change is visible somewhere even off to the side. */
function blink() {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
    root.classList.remove("is-stashing");
    // Force a reflow so re-adding the class restarts the animation even when
    // two items change in quick succession.
    void root.offsetWidth;
    root.classList.add("is-stashing");
  }

  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => {
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
      root.classList.remove("is-stashing");
    }
  }, BLINK_MS);
}

/** Something went into the bag. */
function celebrate() {
  blink();
  play(pling);
}

/** Something came back out. */
function celebrateRemoval() {
  blink();
  play(unplink);
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

  // Item metadata (name, quantity, location) is read-only, so the only action
  // in the lists is removing an entry. Delegated so lists can be re-rendered.
  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const slug = target?.getAttribute?.("data-inventory-remove");
    if (!slug) return;
    event.preventDefault();
    void update((s) => s.remove(slug)).then(celebrateRemoval);
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