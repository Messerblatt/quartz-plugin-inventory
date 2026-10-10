/**
 * Browser persistence for the inventory, backed by IndexedDB via Dexie.
 *
 * IndexedDB (instead of localStorage) buys us a real store that survives
 * eviction better, is not capped at ~5 MB, and can grow later (locations,
 * quantities, categories) without re-serialising everything on every write.
 *
 * We also ask the browser for *persistent* storage, so the user's inventory is
 * not silently purged when the site data is cleaned up.
 */

import Dexie, { type Table } from "dexie";
import {
  DEFAULT_STORAGE_KEY,
  normalizeEntry,
  normalizeQuantity,
  parseInventory,
  type InventoryEntry,
} from "./inventory.ts";

export interface MetaRecord {
  key: string;
  value: unknown;
}

/** Table + database names are derived from the storage key, so several
 *  inventories can live side by side on one origin. */
export function databaseName(storageKey: string = DEFAULT_STORAGE_KEY): string {
  return `${storageKey}:db`;
}

export class InventoryDb extends Dexie {
  items!: Table<InventoryEntry, string>;
  meta!: Table<MetaRecord, string>;

  constructor(storageKey: string = DEFAULT_STORAGE_KEY) {
    super(databaseName(storageKey));
    // slug is the primary key; mergeKey resolves identical items to a single
    // row, timestamp/category are indexed for sorting and the category filters
    // planned for ```event / ```secret.
    this.version(1).stores({
      items: "slug, timestamp, category",
      meta: "key",
    });
    this.version(2).stores({
      items: "slug, timestamp, category, mergeKey",
      meta: "key",
    });
  }
}

export interface InventoryStore {
  /** All entries, newest first, duplicates already merged. */
  all(): Promise<InventoryEntry[]>;
  get(slug: string): Promise<InventoryEntry | undefined>;
  /** The row a given item identity maps to, if the item is in the inventory. */
  getByMergeKey(mergeKey: string): Promise<InventoryEntry | undefined>;
  /** Insert or update a single entry. */
  put(entry: InventoryEntry): Promise<void>;
  remove(slug: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

/** localStorage key holding a pre-IndexedDB inventory, to migrate once. */
const LEGACY_MIGRATION_KEY = "migrated";

export class DexieInventoryStore implements InventoryStore {
  constructor(
    private readonly db: InventoryDb,
    private readonly storageKey: string,
  ) {}

  async all(): Promise<InventoryEntry[]> {
    const rows = await this.db.items.toArray();
    // Records written before merging existed get their identity filled in, and
    // any leftover duplicates (same mergeKey) collapse into the newest row.
    const entries = rows
      .map(normalizeEntry)
      .filter((entry): entry is InventoryEntry => entry !== null);

    const byMergeKey = new Map<string, InventoryEntry>();
    for (const entry of entries) {
      const seen = byMergeKey.get(entry.mergeKey);
      if (!seen) {
        byMergeKey.set(entry.mergeKey, entry);
        continue;
      }
      const [newer, older] =
        entry.timestamp.localeCompare(seen.timestamp) >= 0 ? [entry, seen] : [seen, entry];
      byMergeKey.set(entry.mergeKey, {
        ...newer,
        quantity: normalizeQuantity(newer.quantity + older.quantity),
        origins: [...new Set([...newer.origins, ...older.origins])],
      });
    }

    return [...byMergeKey.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async get(slug: string): Promise<InventoryEntry | undefined> {
    const row = await this.db.items.get(slug);
    return row ? (normalizeEntry(row) ?? undefined) : undefined;
  }

  async getByMergeKey(mergeKey: string): Promise<InventoryEntry | undefined> {
    const row = await this.db.items.where("mergeKey").equals(mergeKey).first();
    return row ? (normalizeEntry(row) ?? undefined) : undefined;
  }

  async put(entry: InventoryEntry): Promise<void> {
    await this.db.items.put(normalizeEntry(entry) ?? entry);
  }

  async remove(slug: string): Promise<void> {
    await this.db.items.delete(slug);
  }

  async clear(): Promise<void> {
    await this.db.items.clear();
  }

  close(): void {
    this.db.close();
  }

  /**
   * One-shot migration from the old localStorage inventory, so upgrading
   * readers keep their stashed items. Missing/legacy-only fields are filled in
   * by `normalizeEntry` (category "item", quantity 1, no location).
   */
  async migrateLegacy(): Promise<number> {
    const already = await this.db.meta.get(LEGACY_MIGRATION_KEY);
    if (already) return 0;

    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.storageKey);
    } catch {
      raw = null;
    }

    const legacy = parseInventory(raw);
    if (legacy.length > 0) {
      await this.db.items.bulkPut(legacy);
      try {
        localStorage.removeItem(this.storageKey);
      } catch {
        /* storage disabled - nothing to clean up */
      }
    }

    await this.db.meta.put({ key: LEGACY_MIGRATION_KEY, value: legacy.length });
    return legacy.length;
  }
}

/**
 * Ask the browser to mark this origin's storage as persistent, so the inventory
 * is not thrown away when the user clears site data. Browsers grant it
 * silently when the site is bookmarked or installed; otherwise the user may be
 * asked. Safe to call on every load - it is a no-op once granted.
 *
 * @returns whether the data is now persistent (`null` where unsupported).
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage) return null;

  try {
    if (storage.persisted) {
      const already = await storage.persisted();
      if (already) return true;
    }
    if (typeof storage.persist === "function") {
      return await storage.persist();
    }
  } catch {
    /* unsupported or blocked - fall through */
  }
  return null;
}

/** Open (and migrate) the store for a storage key. */
export async function openInventoryStore(
  storageKey: string = DEFAULT_STORAGE_KEY,
): Promise<DexieInventoryStore> {
  const db = new InventoryDb(storageKey);
  await db.open();
  const store = new DexieInventoryStore(db, storageKey);
  await store.migrateLegacy();
  return store;
}