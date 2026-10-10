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
  findSameItem,
  normalizeEntry,
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
    // slug is the primary key; timestamp/category are indexed for sorting and
    // the category filters planned for ```event / ```secret. Identical items
    // are recognised by name, so there is no key to manage for that.
    this.version(1).stores({
      items: "slug, timestamp, category",
      meta: "key",
    });
    // v2 added (and v3 drops) a merge-key index; nothing to migrate, the extra
    // index was only ever written by the unreleased merge implementation.
    this.version(2).stores({
      items: "slug, timestamp, category",
      meta: "key",
    });
    this.version(3).stores({
      items: "slug, timestamp, category",
      meta: "key",
    });
  }
}

export interface InventoryStore {
  /** All entries, newest first. */
  all(): Promise<InventoryEntry[]>;
  get(slug: string): Promise<InventoryEntry | undefined>;
  /** The carried item with the same name, if any. */
  getByName(name: string): Promise<InventoryEntry | undefined>;
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
    const entries = rows
      .map(normalizeEntry)
      .filter((entry): entry is InventoryEntry => entry !== null);
    return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async get(slug: string): Promise<InventoryEntry | undefined> {
    const row = await this.db.items.get(slug);
    return row ? (normalizeEntry(row) ?? undefined) : undefined;
  }

  /** Name equivalence, checked against the carried items. */
  async getByName(name: string): Promise<InventoryEntry | undefined> {
    const entries = await this.all();
    return findSameItem(entries, name);
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