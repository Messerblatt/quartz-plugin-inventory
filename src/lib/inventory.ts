/**
 * Pure, dependency-free inventory model.
 *
 * Persistence lives in `./db.ts` (Dexie / IndexedDB); everything here is plain
 * data plus small helpers, so it stays testable and importable on its own.
 */

export interface InventoryEntry {
  /** Unique id: `page#anchor` of the block the item was first stashed from. */
  slug: string;
  /** Identity used for de-duplication: `category:slugified name`. Items with
   *  the same merge key are a single row whose quantity grows. */
  mergeKey: string;
  /** Name of the item, as written inside the fence (never truncated). */
  name: string;
  /** Fence language the item came from: "item", "event", "secret", … */
  category: ItemCategory;
  /** How many of this item are carried. Always >= 1. */
  quantity: number;
  /** Where the item was found, e.g. "Cellar, shelf 2". May be empty. */
  location: string;
  /** ISO timestamp of when the item was first stashed. */
  timestamp: string;
  /** Every `page#anchor` this item was stashed from, newest last. */
  origins: string[];
  /** Note slug the item was first stashed from, kept for provenance. */
  page: string;
  /** Anchor id of the item block on that page. */
  anchor: string;
}

export const DEFAULT_STORAGE_KEY = "quartz:inventory";

/**
 * Fence languages treated as stowable. `item` is the default; the others exist
 * so categories such as ```event or ```secret can be added next to it without
 * touching the runtime.
 */
export const ITEM_CATEGORIES = ["item", "event", "secret"] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const DEFAULT_CATEGORY: ItemCategory = "item";

export function isItemCategory(value: unknown): value is ItemCategory {
  return (
    typeof value === "string" &&
    (ITEM_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Selector for item markers: rehype-pretty-code renders ```item fences as
 *  `<figure data-rehype-pretty-code-figure><pre data-language="item">...</pre></figure>`.
 *  Every element that carries a known `data-language` (the <pre>, the nested
 *  <code>, and any future wrapper) is matched; the outermost one wins. */
export const ITEM_SELECTOR = ITEM_CATEGORIES.map(
  (category) => `[data-language="${category}"]`,
).join(",");

export function isInventoryEntry(value: unknown): value is InventoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<InventoryEntry>;
  return (
    typeof entry.slug === "string" &&
    entry.slug.length > 0 &&
    typeof entry.name === "string" &&
    typeof entry.timestamp === "string" &&
    typeof entry.page === "string" &&
    typeof entry.anchor === "string"
  );
}

/** Clamp to a whole number of items, at least one. */
export function normalizeQuantity(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(999, Math.round(parsed)));
}

/**
 * Identity used to merge identical items: same category + same slugified name.
 * Stashing "health" twice therefore grows one row's quantity instead of adding
 * a second row.
 */
export function mergeKeyFor(name: string, category: ItemCategory): string {
  return `${category}:${slugify(name) || "item"}`;
}

/** Fill in defaults for anything a stored record (or legacy payload) lacks. */
export function normalizeEntry(value: unknown): InventoryEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<InventoryEntry> & { title?: string; addedAt?: string };

  const name = typeof entry.name === "string" ? entry.name : entry.title;
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  const timestamp =
    typeof entry.timestamp === "string"
      ? entry.timestamp
      : typeof entry.addedAt === "string"
        ? entry.addedAt
        : "";

  if (!name || !slug || !timestamp) return null;

  const category = isItemCategory(entry.category) ? entry.category : DEFAULT_CATEGORY;

  return {
    slug,
    mergeKey: mergeKeyFor(name, category),
    name,
    category,
    quantity: normalizeQuantity(entry.quantity),
    location: typeof entry.location === "string" ? entry.location : "",
    timestamp,
    origins: Array.isArray(entry.origins) && entry.origins.length > 0
      ? entry.origins.filter((origin): origin is string => typeof origin === "string")
      : [slug],
    page: typeof entry.page === "string" ? entry.page : "",
    anchor: typeof entry.anchor === "string" ? entry.anchor : "",
  };
}

/**
 * Add a freshly stashed block to the inventory.
 *
 * Identical items (same `mergeKey`) collapse into a single row: the quantity
 * grows, the new origin is remembered, and the original timestamp is kept.
 */
export function addStashedItem(
  entry: InventoryEntry,
  current: InventoryEntry[],
): InventoryEntry[] {
  const existing = current.find((e) => e.mergeKey === entry.mergeKey);

  if (!existing) return [entry, ...current];

  const origins = existing.origins.includes(entry.slug)
    ? existing.origins
    : [...existing.origins, entry.slug];

  const merged: InventoryEntry = {
    ...existing,
    quantity: normalizeQuantity(existing.quantity + entry.quantity),
    origins,
  };

  return [merged, ...current.filter((e) => e.mergeKey !== entry.mergeKey)];
}

/**
 * Take a block back out of the inventory. Merged rows only lose the quantity
 * contributed by that origin; the row disappears once nothing is left of it.
 */
export function removeStashedItem(
  entry: Pick<InventoryEntry, "slug" | "mergeKey" | "quantity">,
  current: InventoryEntry[],
): InventoryEntry[] {
  const existing = current.find((e) => e.mergeKey === entry.mergeKey);
  if (!existing) return current;

  if (!existing.origins.includes(entry.slug)) return current;

  const origins = existing.origins.filter((origin) => origin !== entry.slug);
  const quantity = existing.quantity - entry.quantity;

  if (origins.length === 0 || quantity < 1) {
    return current.filter((e) => e.mergeKey !== entry.mergeKey);
  }

  return [
    { ...existing, origins, quantity },
    ...current.filter((e) => e.mergeKey !== entry.mergeKey),
  ];
}

/**
 * Parse a legacy `localStorage` payload, dropping malformed records. Pre-1.0
 * inventories only had `title`/`addedAt` and no category, quantity or location.
 */
export function parseInventory(raw: string | null): InventoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeEntry)
      .filter((entry): entry is InventoryEntry => entry !== null);
  } catch {
    return [];
  }
}

export function serializeInventory(entries: InventoryEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/** Newest entries first. */
export function sortInventory(entries: InventoryEntry[]): InventoryEntry[] {
  return [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function removeEntry(entries: InventoryEntry[], slug: string): InventoryEntry[] {
  return entries.filter((e) => e.slug !== slug);
}

export function addEntry(
  entries: InventoryEntry[],
  entry: InventoryEntry,
): InventoryEntry[] {
  const withoutDuplicate = entries.filter((e) => e.slug !== entry.slug);
  return sortInventory([entry, ...withoutDuplicate]);
}

export function toggleEntry(
  entries: InventoryEntry[],
  entry: InventoryEntry,
): InventoryEntry[] {
  const exists = entries.some((e) => e.slug === entry.slug);
  return exists ? removeEntry(entries, entry.slug) : addEntry(entries, entry);
}

/**
 * GitHub-style slug, matching what Quartz uses for heading anchors.
 * Kept dependency-free so it can be reused outside the browser bundle.
 */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/**
 * Extract the item name from an ```item fence.
 * Takes the first non-empty trimmed line of the block's text.
 */
export function itemNameFromBlock(text: string | null | undefined): string {
  if (!text) return "";
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export interface ItemDetails {
  quantity: number;
  location: string;
}

/**
 * Read quantity/location hints from the remaining lines of a fence, so authors
 * can write:
 *
 *   ```item
 *   Diesel
 *   x3
 *   Location: Cellar, shelf 2
 *   ```
 *
 * Recognised forms: `x3` / `3x` / a bare number for quantity, and
 * `location: …` (also `found in …`, `where: …`). Anything else is ignored and
 * falls back to the defaults.
 */
export function itemDetailsFromBlock(text: string | null | undefined): ItemDetails {
  const details: ItemDetails = { quantity: 1, location: "" };
  if (!text) return details;

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    // Drop the name line (the first non-empty one).
    .filter((line) => line.length > 0)
    .slice(1);

  for (const line of lines) {
    const labeled = /^(?:location|found\s+in|where)\s*[:=]\s*(.+)$/i.exec(line);
    if (labeled) {
      details.location = labeled[1]?.trim() ?? "";
      continue;
    }
    const quantity = /^x\s*(\d+)$|^(\d+)\s*x$|^(\d+)$/i.exec(line);
    if (quantity) {
      details.quantity = normalizeQuantity(quantity[1] ?? quantity[2] ?? quantity[3]);
    }
  }

  return details;
}

/** Longest item name shown in full before it is elided. */
export const MAX_DISPLAY_TITLE = 20;

/**
 * Shorten an item name for display, e.g.
 *   "Lorem Ipsum ladada blablaba" -> "Lorem Ipsum ladada..."
 * Display only - the stored name is never truncated.
 */
export function truncateTitle(
  title: string | null | undefined,
  max: number = MAX_DISPLAY_TITLE,
): string {
  const text = (title ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}...`;
}