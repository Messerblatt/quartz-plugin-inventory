/**
 * Browser persistence for the rucksack, backed by IndexedDB via Dexie.
 *
 * IndexedDB (instead of localStorage) buys us a real store that survives
 * eviction better, is not capped at ~5 MB, and can grow later (locations,
 * quantities, categories) without re-serialising everything on every write.
 *
 * We also ask the browser for *persistent* storage, so the reader's rucksack is
 * not silently purged when the site data is cleaned up.
 */

import Dexie, { type Table } from "dexie";
import {
  DEFAULT_STORAGE_KEY,
  findSameName,
  normalizeCategory,
  normalizeEntry,
  parseRucksack,
  type RucksackEntry,
} from "./rucksack.ts";

export interface MetaRecord {
  key: string;
  value: unknown;
}

/** Table + database names are derived from the storage key, so several
 *  rucksacks can live side by side on one origin. */
export function databaseName(storageKey: string = DEFAULT_STORAGE_KEY): string {
  return `${storageKey}:db`;
}

export class RucksackDb extends Dexie {
  entries!: Table<RucksackEntry, string>;
  meta!: Table<MetaRecord, string>;

  constructor(storageKey: string = DEFAULT_STORAGE_KEY) {
    super(databaseName(storageKey));
    // slug (`page#anchor`) is the primary key, so every block on every page is
    // its own entry; timestamp/category are indexed for sorting and filtering.
    this.version(1).stores({
      entries: "slug, timestamp, category",
      meta: "key",
    });
    // v2 added (and v3 drops) a merge-key index; nothing to migrate, the extra
    // index was only ever written by the unreleased merge implementation.
    this.version(2).stores({
      entries: "slug, timestamp, category",
      meta: "key",
    });
    // v4 renames the `items` table to `entries`: the rows are copied across
    // first, and only v5 drops the old store. Declaring the drop in the same
    // version would delete the table before the copy could read it.
    this.version(4)
      .stores({ entries: "slug, timestamp, category", meta: "key" })
      .upgrade(async (tx) => {
        try {
          const rows = await tx.table<RucksackEntry>("items").toArray();
          // Fence languages are free-form now: keep whatever language the fence
          // said, and drop a category that was never a string.
          await tx
            .table<RucksackEntry>("entries")
            .bulkPut(
              rows.map((row) => ({ ...row, category: normalizeCategory(row.category) })),
            );
        } catch {
          // A fresh database never had the old table - nothing to carry over.
        }
      });
    this.version(5).stores({
      entries: "slug, timestamp, category",
      meta: "key",
      items: null,
    });
  }
}

export interface RucksackStore {
  /** All entries, newest first. */
  all(): Promise<RucksackEntry[]>;
  get(slug: string): Promise<RucksackEntry | undefined>;
  /** The carried entry with the same name, if any. */
  getByName(name: string): Promise<RucksackEntry | undefined>;
  /** Insert or update a single entry. */
  put(entry: RucksackEntry): Promise<void>;
  remove(slug: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

/** localStorage key holding a pre-IndexedDB rucksack, to migrate once. */
const LEGACY_MIGRATION_KEY = "migrated";

export class DexieRucksackStore implements RucksackStore {
  constructor(
    private readonly db: RucksackDb,
    private readonly storageKey: string,
  ) {}

  async all(): Promise<RucksackEntry[]> {
    const rows = await this.db.entries.toArray();
    const entries = rows
      .map(normalizeEntry)
      .filter((entry): entry is RucksackEntry => entry !== null);
    return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async get(slug: string): Promise<RucksackEntry | undefined> {
    const row = await this.db.entries.get(slug);
    return row ? (normalizeEntry(row) ?? undefined) : undefined;
  }

  /** Name equivalence, checked against the carried entries. */
  async getByName(name: string): Promise<RucksackEntry | undefined> {
    const entries = await this.all();
    return findSameName(entries, name);
  }

  async put(entry: RucksackEntry): Promise<void> {
    await this.db.entries.put(normalizeEntry(entry) ?? entry);
  }

  async remove(slug: string): Promise<void> {
    await this.db.entries.delete(slug);
  }

  async clear(): Promise<void> {
    await this.db.entries.clear();
  }

  close(): void {
    this.db.close();
  }

  /**
   * One-shot migration from the old localStorage rucksack, so upgrading
   * readers keep their stashed entries. Missing/legacy-only fields are filled in
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

    const legacy = parseRucksack(raw);
    if (legacy.length > 0) {
      await this.db.entries.bulkPut(legacy);
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
 * Ask the browser to mark this origin's storage as persistent, so the rucksack
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
export async function openRucksackStore(
  storageKey: string = DEFAULT_STORAGE_KEY,
): Promise<DexieRucksackStore> {
  const db = new RucksackDb(storageKey);
  await db.open();
  const store = new DexieRucksackStore(db, storageKey);
  await store.migrateLegacy();
  return store;
}