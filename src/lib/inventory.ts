export interface InventoryEntry {
  /** Slug / href of the note, used as unique id. */
  slug: string;
  title: string;
  /** ISO timestamp of when the note was stashed. */
  addedAt: string;
  /** Optional free-form tags coming from the page frontmatter. */
  tags?: string[];
  /** Optional excerpt for context. */
  excerpt?: string;
}

export const DEFAULT_STORAGE_KEY = "quartz:inventory";

export function isInventoryEntry(value: unknown): value is InventoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<InventoryEntry>;
  return (
    typeof entry.slug === "string" &&
    entry.slug.length > 0 &&
    typeof entry.title === "string" &&
    typeof entry.addedAt === "string"
  );
}

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

export function addEntry(
  entries: InventoryEntry[],
  entry: InventoryEntry,
): InventoryEntry[] {
  const withoutDuplicate = entries.filter((e) => e.slug !== entry.slug);
  return sortInventory([entry, ...withoutDuplicate]);
}

export function removeEntry(entries: InventoryEntry[], slug: string): InventoryEntry[] {
  return entries.filter((e) => e.slug !== slug);
}

export function toggleEntry(
  entries: InventoryEntry[],
  entry: InventoryEntry,
): InventoryEntry[] {
  const exists = entries.some((e) => e.slug === entry.slug);
  return exists ? removeEntry(entries, entry.slug) : addEntry(entries, entry);
}
