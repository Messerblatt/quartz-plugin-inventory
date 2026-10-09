export interface InventoryEntry {
  /** Slugified item name, unique id. */
  slug: string;
  /** Item name as written inside the ```item fence. */
  title: string;
  /** Note slug the item was stashed from, used to build the link back. */
  page: string;
  /** Anchor id of the item block on that page. */
  anchor: string;
  /** ISO timestamp of when the item was stashed. */
  addedAt: string;
}

export const DEFAULT_STORAGE_KEY = "quartz:inventory";

/** Selector for item markers: rehype-pretty-code renders ```item fences as
 *  `<figure data-rehype-pretty-code-figure><pre data-language="item">...</pre></figure>`.
 *  Every element that carries `data-language="item"` (the <pre>, the nested
 *  <code>, and any future wrapper) is matched; the outermost one wins. */
export const ITEM_SELECTOR = '[data-language="item"]';

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

/** Parse a stored payload, dropping malformed entries. */
export function parseInventory(raw: string | null): InventoryEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isInventoryEntry);
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
