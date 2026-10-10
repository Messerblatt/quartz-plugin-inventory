export interface InventoryEntry {
  /** Slugified item name, unique id. */
  slug: string;
  /** Item name as written inside the ```item fence (never truncated). */
  title: string;
  /** Note slug the item was stashed from, used to build the link back. */
  page: string;
  /** Anchor id of the item block on that page. */
  anchor: string;
  /** ISO timestamp of when the item was stashed. */
  addedAt: string;
  /** Fence language the item came from: "item", "event", "secret", … */
  category: ItemCategory;
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
    typeof entry.title === "string" &&
    typeof entry.addedAt === "string" &&
    typeof entry.page === "string" &&
    typeof entry.anchor === "string"
  );
}

/** Parse a stored payload, dropping malformed entries. Entries written before
 *  categories existed (or with an unknown one) fall back to the default. */
export function parseInventory(raw: string | null): InventoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isInventoryEntry)
      .map((entry) => ({
        ...entry,
        category: isItemCategory(entry.category) ? entry.category : DEFAULT_CATEGORY,
      }));
  } catch {
    return [];
  }
}

export function serializeInventory(entries: InventoryEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/** Newest entries first. */
export function sortInventory(entries: InventoryEntry[]): InventoryEntry[] {
  return [...entries].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
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
 * Kept dependency-free so the inline bundle stays self-contained.
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

/** Longest item name shown in full before it is elided. */
export const MAX_DISPLAY_TITLE = 20;

/**
 * Shorten an item name for display, e.g.
 *   "Lorem Ipsum ladada blablaba" -> "Lorem Ipsum ladada..."
 * Display only - the stored title is never truncated.
 */
export function truncateTitle(
  title: string | null | undefined,
  max: number = MAX_DISPLAY_TITLE,
): string {
  const text = (title ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}...`;
}
