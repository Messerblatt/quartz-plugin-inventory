/**
 * Browser runtime for the Rucksack component.
 *
 * Runs inside a <script> tag after DOMContentLoaded (bundled to a plain JS
 * string by the inline-script-loader), so it is side-effect driven.
 *
 * Anything in a fenced block is stowable. rehype-pretty-code renders a fence as:
 *   <figure data-rehype-pretty-code-figure>
 *     <pre data-language="item" ...><code ...>Item name</code></pre>
 *   </figure>
 * so "everything in a fence" is simply every rendered <pre>; `languages` narrows
 * that to specific fence languages when a site wants it. The first non-empty
 * line is the entry's name; optional following lines may carry a quantity
 * (`x3`) and a location (`Location: Cellar`). Anchors are derived from the
 * slugified name, so entries survive renames of unrelated pages.
 *
 * Persistence: IndexedDB (via Dexie, see ../../lib/db.ts). Each entry stores
 * { slug, name, category, quantity, location, timestamp, page, anchor }.
 * The panel's open/closed flag stays in localStorage - it is a single byte and
 * must be readable synchronously while the panel renders.
 */

import STASH_SRC from "../../../oh.mp3";
import UNPLINK_SRC from "../assets/unplink.mp3";
import {
  anchorForName,
  blockSelector,
  detailsFromBlock,
  displayCategory,
  entrySources,
  findMergeTarget,
  findSameBlock,
  isBlockCarried,
  isLanguageStashable,
  nameFromBlock,
  normalizeCategory,
  RUCKSACK_EVENTS,
  addStashedEntry,
  sortEntries,
  truncateName,
  type RucksackEventDetail,
  type RucksackEventSource,
  type RucksackEntry,
} from "../../lib/rucksack.ts";
import {
  configFromAttributes,
  resolveConfig,
  type ResolvedRucksackConfig,
  type RucksackOptions,
} from "../../lib/config.ts";
import {
  openRucksackStore,
  requestPersistentStorage,
  type RucksackStore,
} from "../../lib/db.ts";

const OPEN_KEY_SUFFIX = ":open";
const ROOT_SELECTOR = "[data-rucksack]";
const BLOCK_ATTR = "data-rucksack-block";
const NAME_ATTR = "data-rucksack-name";
/** Keep in sync with the `.is-stashing` animation in rucksack.scss. */
const BLINK_MS = 620;

/** Attribute the toggle button is mounted with, and the block it points at. */
const TOGGLE_ATTR = "data-rucksack-toggle-block";

/**
 * Notify the host Quartz site after a successful stash operation. Events are
 * dispatched on `document`, matching Quartz's own navigation events and making
 * them available to site code without coupling the plugin to a global API.
 */
function emitRucksackEvent(
  name: (typeof RUCKSACK_EVENTS)[keyof typeof RUCKSACK_EVENTS],
  entry: RucksackEntry,
  storageKey: string,
  source: RucksackEventSource,
) {
  const detail: RucksackEventDetail = {
    entry: {
      ...entry,
      sources: entry.sources ? [...entry.sources] : undefined,
    },
    storageKey,
    source,
  };
  document.dispatchEvent(new CustomEvent(name, { detail }));
  if (eventLoggingEnabled()) {
    console.log(`[rucksack] ${name}`, detail);
  }
}

// --- Configuration ---------------------------------------------------------

/**
 * The config this page runs with: the one the component inlined, refined by the
 * panel's `data-*` attributes, which win. Read once and cached - it is fixed
 * for the life of the page.
 */
let cachedConfig: ResolvedRucksackConfig | undefined;

function config(): ResolvedRucksackConfig {
  if (cachedConfig) return cachedConfig;
  const inlined = (window as unknown as Record<string, unknown>)["__RUCKSACK_CONFIG__"];
  const base = typeof inlined === "object" && inlined !== null ? inlined : undefined;
  const root = document.querySelector(ROOT_SELECTOR);
  const attrs = root ? configFromAttributes((name) => root.getAttribute(name)) : {};
  cachedConfig = resolveConfig({ ...(base as Partial<RucksackOptions>), ...attrs });
  return cachedConfig;
}

interface RucksackDebugApi {
  setEventLogging(enabled: boolean): void;
  getEventLogging(): boolean;
}

let eventLoggingOverride: boolean | undefined;

function eventLoggingEnabled(): boolean {
  return eventLoggingOverride ?? config().logEvents;
}

/**
 * Small page-local API for debugging from the browser console. The override is
 * intentionally not persisted: a production reload returns to `logEvents`.
 */
function installDebugApi() {
  const host = window as Window & {
    __RUCKSACK__?: RucksackDebugApi & Record<string, unknown>;
  };
  const api: RucksackDebugApi & Record<string, unknown> =
    host.__RUCKSACK__ && typeof host.__RUCKSACK__ === "object"
      ? host.__RUCKSACK__
      : ({} as RucksackDebugApi & Record<string, unknown>);

  api.setEventLogging = (enabled: boolean) => {
    eventLoggingOverride = Boolean(enabled);
  };
  api.getEventLogging = () => eventLoggingEnabled();
  host.__RUCKSACK__ = api;
}

installDebugApi();

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

/** Storage key of the (first) rucksack panel on the page, or the config's. */
function storageKeyFor(doc: Document = document): string {
  return (
    doc.querySelector<HTMLElement>(ROOT_SELECTOR)?.getAttribute("data-rucksack-key") ??
    config().storageKey
  );
}

// --- Store -----------------------------------------------------------------

/** One store per storage key, opened lazily and cached for the page. */
const stores = new Map<string, Promise<RucksackStore>>();

function storeFor(storageKey: string): Promise<RucksackStore> {
  const existing = stores.get(storageKey);
  if (existing) return existing;
  const created = openRucksackStore(storageKey).catch((error: unknown) => {
    // Keep the panel usable (empty) if IndexedDB is unavailable, e.g. private
    // mode with storage disabled.
    console.warn("[rucksack] IndexedDB unavailable, rucksack is disabled", error);
    stores.delete(storageKey);
    throw error;
  });
  stores.set(storageKey, created);
  return created;
}

// --- Block discovery -------------------------------------------------------

/**
 * Contexts a `<pre>` can sit in that are not a page's prose - an editor's code
 * block, a form, a live preview. Stashing those would inject buttons into
 * something the reader is typing into.
 */
const EDITOR_SELECTOR = "[contenteditable], form, [role='textbox'], .cm-editor, .quill";

/**
 * Stashable blocks on this page: every rendered fence, or just the fence
 * languages the config allows.
 *
 * When stashing *all* fences, both the <pre> and the nested <code> can match
 * `[data-language]`, so keep only the outermost match of each block and never
 * descend into an already-matched element. With `pre` the outermost element is
 * the only candidate anyway.
 */
function stowableBlocks(): HTMLElement[] {
  const cfg = config();
  const selector = blockSelector(cfg.languages, cfg.excludeLanguages);
  const blocks: HTMLElement[] = [];

  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    // Skip anything nested inside an already collected block.
    if (el.parentElement?.closest(selector)) continue;
    if (el.closest(EDITOR_SELECTOR)) continue;
    if (!isLanguageStashable(blockLanguage(el), cfg.languages, cfg.excludeLanguages)) continue;
    blocks.push(el);
  }

  return blocks;
}

/** Fence language of a block, i.e. the category it belongs to. */
function blockLanguage(el: HTMLElement): string {
  return normalizeCategory(
    el.getAttribute("data-language") ??
      el.querySelector<HTMLElement>("[data-language]")?.getAttribute("data-language"),
  );
}

/**
 * Stashed blocks, keyed by anchor, with the comment node left behind in their
 * place.
 *
 * With `removeFromDom` on (the default), a stashed block is removed from the
 * document entirely - fence, figure and "+ Stash" button - so the page reads
 * like the thing was picked up. The element is parked here rather than
 * discarded, and the placeholder remembers where it belongs, so unstashing it
 * later (from the panel's remove button) puts it back exactly where it was
 * instead of leaving a hole. With `removeFromDom` off nothing is ever parked;
 * the block stays in place and is only marked.
 */
const parkedBlocks = new Map<string, { figure: HTMLElement; placeholder: Comment }>();

/** Take a stashed block out of the page. Idempotent. */
function parkBlock(anchor: string, figure: HTMLElement) {
  if (parkedBlocks.has(anchor)) return;
  const placeholder = document.createComment(`rucksack:stashed:${anchor}`);
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

/** The <figure> wrapping a block - what actually leaves the page. */
function figureOf(el: HTMLElement): HTMLElement {
  return el.closest("figure") ?? el;
}

interface DiscoveredBlock {
  el: HTMLElement;
  figure: HTMLElement;
  name: string;
  slug: string;
  anchor: string;
  category: string;
  quantity: number;
  location: string;
}

/**
 * Tag blank rendered lines so CSS can drop them. rehype-pretty-code wraps every
 * line in `span[data-line]`, and the fence's leading/trailing newline shows up
 * as an empty line around the name. Without this, a one-line fence whose only
 * span *is* the name would be hidden by a `:last-child` rule and render as an
 * empty block.
 */
function markBlankLines(el: HTMLElement) {
  for (const line of Array.from(el.querySelectorAll<HTMLElement>("span[data-line]"))) {
    line.classList.toggle("is-blank-line", line.textContent?.trim() === "");
  }
}

/**
 * The entry name, read from the rendered lines only. rehype-pretty-code injects
 * a "copy source" clipboard button into the block, so the block's raw
 * textContent would otherwise start with the button's label instead of the name.
 */
function blockName(el: HTMLElement): string {
  const cfg = config();
  // A fence with no useful first line (a snippet, a command) can name itself
  // through an attribute instead.
  if (cfg.nameAttribute) {
    const named = figureOf(el).getAttribute(cfg.nameAttribute);
    if (named && named.trim().length > 0) return named.trim();
  }

  const lines = el.querySelectorAll<HTMLElement>("span[data-line]");
  if (lines.length > 0) {
    for (const line of Array.from(lines)) {
      const name = nameFromBlock(line.textContent);
      if (name) return name;
    }
    return "";
  }
  return nameFromBlock(el.textContent);
}

/** Raw fence text (all rendered lines), used to read quantity/location hints. */
function blockText(el: HTMLElement): string {
  const lines = Array.from(el.querySelectorAll<HTMLElement>("span[data-line]"));
  const source = lines.length > 0 ? lines : [el];
  return source
    .map((line) => line.textContent ?? "")
    .join("\n")
    .trim();
}

function discoverBlocks(): DiscoveredBlock[] {
  const page = currentPage();
  const cfg = config();
  const blocks: DiscoveredBlock[] = [];

  // Parked (stashed) blocks are gone from the document but still hold their
  // anchors. Keep their slots reserved, or the anchors of the blocks after them
  // would shift down and a "kompass-1" would quietly become a "kompass" - a
  // different entry in the store. Live blocks take the lowest free slot.
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

  for (const el of stowableBlocks()) {
    markBlankLines(el);
    const category = blockLanguage(el);

    // Parked blocks are parked out of the document, so everything below is
    // reading a live block with its text intact.
    const name = blockName(el) || el.getAttribute(NAME_ATTR) || "";
    if (!name) continue;

    const details = cfg.parseDetails ? detailsFromBlock(blockText(el)) : null;

    // De-duplicate anchors when a page repeats the same name.
    const slot = nextFreeSlot(anchorForName(name));
    const anchor = anchorForName(name, slot);
    const slug = `${page}#${anchor}`;

    el.setAttribute(BLOCK_ATTR, anchor);
    el.setAttribute(NAME_ATTR, name);
    el.setAttribute("data-rucksack-category", category);
    el.classList.add("rucksack-block");
    if (category) el.classList.add(`rucksack-block--${category}`);

    blocks.push({
      el,
      figure: figureOf(el),
      name,
      slug,
      anchor,
      category,
      quantity: details?.quantity ?? 1,
      location: details?.location ?? "",
    });
  }

  return blocks;
}

/** The entry a block maps to when stashed. Existing entries keep their
 *  quantity/location/timestamp so re-stashing never resets them. */
function entryFor(
  block: DiscoveredBlock,
  existing?: RucksackEntry,
): RucksackEntry {
  return {
    slug: block.slug,
    name: block.name,
    category: block.category,
    quantity: block.quantity,
    location: block.location,
    timestamp: existing?.timestamp ?? new Date().toISOString(),
    page: currentPage(),
    anchor: block.anchor,
    sources: existing
      ? [...new Set([...entrySources(existing), block.slug])]
      : [block.slug],
  };
}

// --- Rendering -------------------------------------------------------------

/**
 * Keep every block's toggle button (and the block itself) in sync with the
 * stashed entries.
 *
 * State is decided by the block's anchor, not by its name: two `kompass` blocks
 * on one page are two entries, so stashing one leaves the other as "+ Stash".
 */
function refreshBlockButtons(entries: RucksackEntry[]) {
  const cfg = config();

  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>(`[${TOGGLE_ATTR}]`),
  )) {
    const stashed = isCarried(entries, button);
    button.textContent = stashed ? cfg.stashedLabel : cfg.stashLabel;
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
  }

  for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${BLOCK_ATTR}]`))) {
    const anchor = el.getAttribute(BLOCK_ATTR);
    if (!anchor) continue;
    const carried = isCarried(entries, el);

    if (cfg.removeFromDom) {
      // Stashed blocks leave the page entirely - fence, figure and button - so
      // the reader sees a clean page and can no longer re-stash the same block.
      if (carried) parkBlock(anchor, figureOf(el));
      else unparkBlock(anchor);
    } else {
      // Keep the block where it is; marking it says the same thing without
      // leaving a hole in prose that referred to it.
      el.classList.toggle("is-stashed", carried);
      figureOf(el).classList.toggle("is-stashed", carried);
      unparkBlock(anchor);
    }
  }

  // Parked blocks are out of the document, so their buttons cannot be found by
  // the loop above; clear the stale one before the figure goes back in.
  for (const [anchor, parked] of parkedBlocks) {
    const button = parked.figure.querySelector<HTMLElement>(`[${TOGGLE_ATTR}]`);
    if (!button) continue;
    const stashed = isCarried(entries, button);
    button.textContent = stashed ? config().stashedLabel : config().stashLabel;
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
    if (!stashed) unparkBlock(anchor);
  }
}

/**
 * Is this element's block the one in the bag? The block carries its page-local
 * anchor in `data-rucksack-block`; the button carries the full `page#anchor` slug
 * in `data-rucksack-toggle-block`. Both reduce to the same anchor.
 */
function isCarried(entries: RucksackEntry[], el: HTMLElement): boolean {
  const anchor =
    el.getAttribute(BLOCK_ATTR) ?? el.getAttribute(TOGGLE_ATTR)?.split("#").pop();
  if (!anchor) return false;
  return isBlockCarried(entries, `${currentPage()}#${anchor}`);
}

function setBadge(root: HTMLElement, count: number) {
  const badge = root.querySelector<HTMLElement>("[data-rucksack-count]");
  if (badge) badge.textContent = String(count);
}

function render(root: HTMLElement, entries: RucksackEntry[]) {
  const empty = root.querySelector<HTMLElement>("[data-rucksack-empty]");
  const panel = root.querySelector<HTMLElement>("[data-rucksack-panel]");
  const toggle = root.querySelector<HTMLElement>("[data-rucksack-toggle]");

  setBadge(root, entries.length);

  if (toggle && panel) {
    toggle.setAttribute("aria-expanded", String(!panel.hasAttribute("hidden")));
  }

  if (empty) empty.toggleAttribute("hidden", entries.length > 0);

  // "Show all" and the in-modal "Clear" are only useful with entries.
  for (const action of Array.from(
    root.querySelectorAll<HTMLElement>(
      "[data-rucksack-show-all], [data-rucksack-clear]",
    ),
  )) {
    action.toggleAttribute("hidden", entries.length === 0);
  }

  // The panel is a narrow sidebar, so it gets the compact list; the "Show all"
  // modal has the width for the full set of columns.
  for (const list of Array.from(root.querySelectorAll<HTMLElement>("[data-rucksack-entries]"))) {
    fillList(list, entries, { compact: true });
  }

  for (const list of Array.from(
    root.querySelectorAll<HTMLElement>("[data-rucksack-modal-entries]"),
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
  entries: RucksackEntry[],
  { compact = false }: { compact?: boolean } = {},
) {
  const cfg = config();
  list.textContent = "";
  list.classList.toggle("rucksack-list--compact", compact);

  for (const entry of sortEntries(entries)) {
    const li = document.createElement("li");
    li.className = "rucksack-entry";
    li.setAttribute("data-rucksack-slug", entry.slug);
    li.setAttribute("data-rucksack-category", entry.category);

    // Plain text, not a link: the entry keeps the full name, the preview is
    // shortened so a long name cannot blow up the panel or the modal.
    const name = document.createElement("span");
    name.className = "rucksack-name";
    name.textContent = truncateName(entry.name, cfg.maxNameLength);
    // Full name available on hover / to assistive tech.
    name.title = entry.name;
    if (truncateName(entry.name, cfg.maxNameLength) !== entry.name.trim()) {
      name.setAttribute("aria-label", entry.name);
    }

    // A fence with no language still gets a tag, so a row of plain snippets
    // does not read as a row of unlabelled things.
    const category = document.createElement("span");
    category.className = "rucksack-tag";
    category.textContent = displayCategory(entry.category);

    const quantity = document.createElement("span");
    quantity.className = "rucksack-quantity";
    quantity.textContent = `\u00d7${entry.quantity}`;
    quantity.title = `Quantity: ${entry.quantity}`;
    quantity.hidden = compact;

    const location = document.createElement("span");
    location.className = "rucksack-location";
    location.textContent = entry.location;
    location.hidden = entry.location.length === 0;
    if (entry.location) location.title = `Found in ${entry.location}`;

    const meta = document.createElement("span");
    meta.className = "rucksack-meta";
    meta.textContent = new Date(entry.timestamp).toLocaleDateString();
    meta.hidden = compact;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "rucksack-remove";
    remove.setAttribute("data-rucksack-remove-entry", entry.slug);
    remove.setAttribute("aria-label", `Remove ${entry.name} from your rucksack`);
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

/** Re-render every panel and every block button from `entries`. */
function syncAll(entries: RucksackEntry[]) {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
    render(root, entries);
  }
  refreshBlockButtons(entries);
}

// --- Block buttons ---------------------------------------------------------

/** Per-block toggle button, injected into the figure wrapping the block. */
function mountBlockButton(
  block: DiscoveredBlock,
  onToggle: (block: DiscoveredBlock) => void,
) {
  const figure = block.figure;
  // The button lives on the figure, not inside the block, so guard on it (or on
  // the block itself) - otherwise every re-run would stack up another button.
  const existing = figure.querySelector<HTMLElement>(`[${TOGGLE_ATTR}]`);
  if (existing) {
    if (existing.getAttribute(TOGGLE_ATTR) === block.slug) return;
    existing.remove();
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "rucksack-block-toggle";
  button.setAttribute(TOGGLE_ATTR, block.slug);
  // Carry the name on the button so state can be refreshed from the store
  // without keeping a reference to the discovered block.
  button.setAttribute(NAME_ATTR, block.name);
  button.setAttribute("aria-label", `Stash ${block.name} in your rucksack`);

  button.addEventListener("click", () => onToggle(block));

  figure.appendChild(button);
}

/** Discover stashable blocks and mount their toggle buttons. Idempotent. */
async function mountBlocks() {
  const storageKey = storageKeyFor();
  const store = await storeFor(storageKey);

  for (const block of discoverBlocks()) {
    mountBlockButton(block, (target) => void toggleBlock(store, target, storageKey));
  }

  refreshBlockButtons(await store.all());
}

/**
 * Stash / unstash a block, then repaint everything from the store.
 *
 * A block is identified by its anchor, so stashing one `kompass` never touches
 * the other. Only when the same name was carried from a *different* page
 * (and `merge` is on) does stashing fold into that row's quantity instead of
 * adding a new one.
 */
async function toggleBlock(store: RucksackStore, block: DiscoveredBlock, storageKey: string) {
  const current = await store.all();

  // This exact block is already in the bag: take it back out. A block folded
  // into another page's row is unstashed from that row.
  const own = findSameBlock(current, block.slug);
  if (own) {
    const eventEntry = entryFor(block);
    const remaining = entrySources(own).filter((s) => s !== block.slug);
    if (remaining.length === 0) {
      await store.remove(own.slug);
    } else {
      await store.put({
        ...own,
        quantity: Math.max(1, own.quantity - block.quantity),
        sources: remaining,
      });
    }
    syncAll(await store.all());
    emitRucksackEvent(RUCKSACK_EVENTS.unstashed, eventEntry, storageKey, "block");
    celebrateRemoval();
    return;
  }

  // The same name stashed elsewhere on the site: add to its quantity.
  const carried = config().merge ? findMergeTarget(current, currentPage(), block.name) : undefined;
  const eventEntry = entryFor(block);
  if (carried) {
    const [merged] = addStashedEntry(entryFor(block, carried), [carried]);
    if (merged) await store.put(merged);
  } else {
    await store.put(entryFor(block));
  }

  syncAll(await store.all());
  emitRucksackEvent(RUCKSACK_EVENTS.stashed, eventEntry, storageKey, "block");
  celebrate();
}

// --- Feedback ---------------------------------------------------------------

/**
 * The "pling" played when a block is stashed, as an inlined data URI so it
 * works on any static host with no asset pipeline.
 *
 * Autoplay policies reject audio until the page has been interacted with, and
 * every stash is a click, so this normally plays first time. A rejection is
 * swallowed: the rucksack is still correct without the sound.
 */
const stashSound = typeof Audio === "function" ? new Audio(STASH_SRC) : null;
if (stashSound) stashSound.volume = 0.4;

/** The softer, descending counterpart, played when something leaves the bag. */
const unplink = typeof Audio === "function" ? new Audio(UNPLINK_SRC) : null;
if (unplink) unplink.volume = 0.35;

/**
 * Play a sound without letting a blocked or missing one interrupt anything.
 * Browsers return a promise that rejects when autoplay is disallowed; some
 * environments return nothing at all, so normalise before catching.
 */
function play(sound: HTMLAudioElement | null) {
  if (!sound || !config().sound) return;
  sound.currentTime = 0;
  void Promise.resolve(sound.play()).catch(() => {
    /* autoplay blocked - the rucksack itself is already correct */
  });
}

let blinkTimer: ReturnType<typeof setTimeout> | undefined;

/** Blink the panel so a change is visible somewhere even off to the side. */
function blink() {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
    root.classList.remove("is-stashing");
    // Force a reflow so re-adding the class restarts the animation even when
    // two entries change in quick succession.
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
  play(stashSound);
}

/** Something came back out. */
function celebrateRemoval() {
  blink();
  play(unplink);
}

// --- Component wiring ------------------------------------------------------

/** Hide the "Show all" modal and release the scroll lock. */
function closeModal(root: HTMLElement) {
  root.querySelector<HTMLElement>("[data-rucksack-modal]")?.setAttribute("hidden", "");
  if (!document.querySelector("[data-rucksack-modal]:not([hidden])")) {
    document.documentElement.classList.remove("rucksack-modal-open");
  }
}

async function initRoot(root: HTMLElement) {
  // `init` runs again after client-side navigation; never double-bind.
  if (root.hasAttribute("data-rucksack-ready")) return;
  root.setAttribute("data-rucksack-ready", "");

  const storageKey = root.getAttribute("data-rucksack-key") ?? config().storageKey;
  const openKey = storageKey + OPEN_KEY_SUFFIX;
  const panel = root.querySelector<HTMLElement>("[data-rucksack-panel]");

  let store: RucksackStore;
  try {
    store = await storeFor(storageKey);
  } catch {
    render(root, []);
    return;
  }

  const update = async (mutate: (current: RucksackStore) => Promise<void>): Promise<boolean> => {
    try {
      await mutate(store);
    } catch (error: unknown) {
      console.warn("[rucksack] could not update the rucksack", error);
      return false;
    }
    syncAll(await store.all());
    return true;
  };

  const setOpen = (open: boolean) => {
    if (panel) panel.toggleAttribute("hidden", !open);
    root
      .querySelector<HTMLElement>("[data-rucksack-toggle]")
      ?.setAttribute("aria-expanded", String(open));
    write(openKey, open ? "1" : "0");
  };

  root
    .querySelector<HTMLElement>("[data-rucksack-toggle]")
    ?.addEventListener("click", () => {
      setOpen(panel ? panel.hasAttribute("hidden") : true);
    });

  root
    .querySelector<HTMLElement>("[data-rucksack-clear]")
    ?.addEventListener("click", () => {
      void (async () => {
        const before = await store.all();
        if (!(await update(async (s) => s.clear()))) return;
        for (const entry of before) {
          emitRucksackEvent(RUCKSACK_EVENTS.unstashed, entry, storageKey, "clear");
        }
        celebrateRemoval();
        closeModal(root);
      })();
    });

  // --- "Show all" modal ---------------------------------------------------
  const modal = root.querySelector<HTMLElement>("[data-rucksack-modal]");

  const closeDialog = () => closeModal(root);

  root
    .querySelector<HTMLElement>("[data-rucksack-show-all]")
    ?.addEventListener("click", () => {
      if (!modal) return;
      // Repaint from the store so the modal is current even if it was opened
      // long after the panel rendered.
      void store.all().then((entries) => render(root, entries)).then(() => {
        modal.removeAttribute("hidden");
        document.documentElement.classList.add("rucksack-modal-open");
        modal.querySelector<HTMLElement>("[data-rucksack-modal-close]")?.focus();
      });
    });

  modal
    ?.querySelector<HTMLElement>("[data-rucksack-modal-backdrop]")
    ?.addEventListener("click", closeDialog);
  modal
    ?.querySelector<HTMLElement>("[data-rucksack-modal-close]")
    ?.addEventListener("click", closeDialog);
  // Clicking the backdrop but not the dialog must not close.
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hasAttribute("hidden")) closeDialog();
  });

  // Entry metadata (name, quantity, location) is read-only, so the only action
  // in the lists is removing an entry. Delegated so lists can be re-rendered.
  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const slug = target?.getAttribute?.("data-rucksack-remove-entry");
    if (!slug) return;
    event.preventDefault();
    void (async () => {
      const entry = await store.get(slug);
      if (!(await update((s) => s.remove(slug)))) return;
      if (entry) emitRucksackEvent(RUCKSACK_EVENTS.unstashed, entry, storageKey, "panel");
      celebrateRemoval();
    })();
  });

  if (read(openKey) === "1") setOpen(true);
  render(root, await store.all());
}

async function init() {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>(ROOT_SELECTOR))) {
    await initRoot(root);
  }
  // Blocks are stowable even on pages that render no rucksack panel.
  await mountBlocks();
}

/**
 * Quartz swaps page content without a reload, so freshly inserted blocks would
 * never get their buttons. Re-run (idempotently) after every navigation.
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
 * Without it the rucksack can be purged when site data is cleared.
 */
function requestPersistence() {
  void requestPersistentStorage().then((granted) => {
    document.documentElement.setAttribute("data-rucksack-persisted", String(granted));
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
