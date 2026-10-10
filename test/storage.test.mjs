/**
 * Tests for the IndexedDB (Dexie) persistence layer.
 *
 * Runs against `fake-indexeddb`, so it exercises the real Dexie code paths
 * (schema, primary key, bulkPut, migration) without a browser.
 */
import "fake-indexeddb/auto";

const {
  DEFAULT_STORAGE_KEY,
  addStashedItem,
  databaseName,
  itemDetailsFromBlock,
  mergeKeyFor,
  normalizeEntry,
  normalizeQuantity,
  openInventoryStore,
  removeStashedItem,
  requestPersistentStorage,
} = await import("../dist/index.js");

const results = [];
const check = (name, cond, extra = "") =>
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);

const entry = (overrides = {}) => ({
  slug: "gear#diesel",
  mergeKey: mergeKeyFor("Diesel", "item"),
  name: "Diesel",
  category: "item",
  quantity: 1,
  location: "",
  timestamp: "2026-10-10T10:00:00.000Z",
  origins: ["gear#diesel"],
  page: "gear",
  anchor: "diesel",
  ...overrides,
});

// --- Pure helpers ----------------------------------------------------------

check("quantity defaults to 1", normalizeQuantity(undefined) === 1);
check("quantity is parsed from text", normalizeQuantity("4") === 4);
check("quantity never drops below 1", normalizeQuantity(0) === 1);
check("quantity is capped", normalizeQuantity(100000) === 999);
check("quantity of garbage falls back to 1", normalizeQuantity("abc") === 1);

check(
  "fence hints: quantity and location",
  JSON.stringify(itemDetailsFromBlock("Diesel\nx3\nLocation: Cellar, shelf 2")) ===
    JSON.stringify({ quantity: 3, location: "Cellar, shelf 2" }),
  JSON.stringify(itemDetailsFromBlock("Diesel\nx3\nLocation: Cellar, shelf 2")),
);
check(
  "fence hints: bare number and 'found in'",
  JSON.stringify(itemDetailsFromBlock("Diesel\n12\nFound in: shed")) ===
    JSON.stringify({ quantity: 12, location: "shed" }),
);
check(
  "fence hints: name only -> defaults",
  JSON.stringify(itemDetailsFromBlock("Diesel")) === JSON.stringify({ quantity: 1, location: "" }),
);
check(
  "fence hints: prose lines are ignored",
  JSON.stringify(itemDetailsFromBlock("Diesel\nsome description")) ===
    JSON.stringify({ quantity: 1, location: "" }),
);

const legacy = normalizeEntry({
  slug: "gear#brille",
  title: "Brille",
  addedAt: "2020-01-01T00:00:00.000Z",
  page: "gear",
  anchor: "brille",
});
check(
  "legacy record upgrades cleanly",
  legacy?.name === "Brille" && legacy?.quantity === 1 && legacy?.location === "" && legacy?.category === "item",
  JSON.stringify(legacy),
);
check("record without an id is rejected", normalizeEntry({ name: "x", timestamp: "t" }) === null);

// --- Merging identical items -----------------------------------------------

const health = entry({
  slug: "gear#health",
  mergeKey: mergeKeyFor("health", "item"),
  name: "health",
  anchor: "health",
  origins: ["gear#health"],
});

check("merge key ignores case and punctuation", mergeKeyFor("Health!", "item") === mergeKeyFor("health", "item"));
check("merge key separates categories", mergeKeyFor("health", "item") !== mergeKeyFor("health", "secret"));

let merged = addStashedItem(
  entry({
    slug: "notes/gear#health",
    mergeKey: health.mergeKey,
    name: "health",
    timestamp: "2026-10-12T10:00:00.000Z",
    origins: ["notes/gear#health"],
    page: "notes/gear",
    anchor: "health",
  }),
  [health],
);
check("identical item merges into one row", merged.length === 1, `${merged.length}`);
check("merge adds the quantities", merged[0].quantity === 2, JSON.stringify(merged[0]));
check("merge records both origins", JSON.stringify(merged[0].origins) === JSON.stringify(["gear#health", "notes/gear#health"]));
check("merge keeps the first timestamp", merged[0].timestamp === health.timestamp);

const differentCategory = addStashedItem(
  entry({ slug: "gear#health-secret", mergeKey: mergeKeyFor("health", "secret"), name: "health", category: "secret", origins: ["gear#health-secret"] }),
  [health],
);
check("same name, different category stays separate", differentCategory.length === 2, `${differentCategory.length}`);

merged = removeStashedItem({ slug: "notes/gear#health", mergeKey: health.mergeKey, quantity: 1 }, [merged[0]]);
check("removing one origin keeps the row", merged.length === 1);
check("removing one origin lowers the quantity", merged[0].quantity === 1);
check("removing one origin drops it from origins", JSON.stringify(merged[0].origins) === JSON.stringify(["gear#health"]));

merged = removeStashedItem({ slug: "gear#health", mergeKey: health.mergeKey, quantity: 1 }, [merged[0]]);
check("removing the last origin removes the row", merged.length === 0);

// Leftover duplicates from before merging existed collapse on read.
const legacyDupes = await openInventoryStore("merge:inventory");
await legacyDupes.put(entry({ slug: "gear#rope", mergeKey: "item:rope", name: "rope", origins: ["gear#rope"], quantity: 1 }));
await legacyDupes.put(entry({ slug: "shop#rope", mergeKey: "item:rope", name: "rope", origins: ["shop#rope"], quantity: 2, timestamp: "2026-10-13T10:00:00.000Z" }));
const deduped = await legacyDupes.all();
check("duplicates collapse on read", deduped.length === 1, `${deduped.length}`);
check("collapsed duplicates sum their quantities", deduped[0].quantity === 3, JSON.stringify(deduped[0]));
check("collapsed duplicates keep every origin", deduped[0].origins.length === 2, JSON.stringify(deduped[0].origins));
check("records without a merge key get one on read", (await legacyDupes.getByMergeKey(mergeKeyFor("rope", "item")))?.name === "rope");
legacyDupes.close();

// --- Store -----------------------------------------------------------------

check("database name derives from the storage key", databaseName("gear:inventory") === "gear:inventory:db");
check("default database name", databaseName() === `${DEFAULT_STORAGE_KEY}:db`);

const store = await openInventoryStore("test:inventory");
check("starts empty", (await store.all()).length === 0);

await store.put(entry({ slug: "gear#diesel", name: "Diesel" }));
await store.put(
  entry({
    slug: "gear#rope",
    name: "Rope",
    quantity: 4,
    location: "Cellar",
    category: "secret",
    timestamp: "2026-10-11T10:00:00.000Z",
  }),
);

const all = await store.all();
check("stored items come back", all.length === 2, `${all.length}`);
check("newest entry first", all[0].name === "Rope", all[0]?.name);
check(
  "quantity, location and category round-trip",
  all[0].quantity === 4 && all[0].location === "Cellar" && all[0].category === "secret",
  JSON.stringify(all[0]),
);

await store.put(entry({ slug: "gear#diesel", name: "Diesel", quantity: 7 }));
check("put updates in place", (await store.all()).length === 2);
check("put keeps the update", (await store.get("gear#diesel"))?.quantity === 7);

await store.remove("gear#diesel");
check("remove deletes one", (await store.all()).length === 1);
check("removed entry is gone", (await store.get("gear#diesel")) === undefined);

await store.clear();
check("clear empties the store", (await store.all()).length === 0);
store.close();

// --- Migration from localStorage -------------------------------------------

globalThis.localStorage = {
  _data: new Map(),
  getItem(k) {
    return this._data.has(k) ? this._data.get(k) : null;
  },
  setItem(k, v) {
    this._data.set(k, String(v));
  },
  removeItem(k) {
    this._data.delete(k);
  },
};

globalThis.localStorage.setItem(
  "legacy:inventory",
  JSON.stringify([
    { slug: "gear#lamp", title: "Lampe", addedAt: "2019-05-05T00:00:00.000Z", page: "gear", anchor: "lamp" },
  ]),
);

const migrated = await openInventoryStore("legacy:inventory");
const migratedEntries = await migrated.all();
check("legacy localStorage inventory is migrated", migratedEntries.length === 1, `${migratedEntries.length}`);
check(
  "migrated entry is normalised",
  migratedEntries[0]?.name === "Lampe" && migratedEntries[0]?.quantity === 1 && migratedEntries[0]?.category === "item",
  JSON.stringify(migratedEntries[0]),
);
check("legacy localStorage key is cleaned up", globalThis.localStorage.getItem("legacy:inventory") === null);

await migrated.clear();
check("migration does not run twice", (await (await openInventoryStore("legacy:inventory")).all()).length === 0);
migrated.close();

// --- Persistent storage ----------------------------------------------------

let persistCalls = 0;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    storage: {
      persisted: async () => false,
      persist: async () => {
        persistCalls += 1;
        return true;
      },
    },
  },
});
check("persistent storage is requested and granted", (await requestPersistentStorage()) === true);
check("request is made exactly once", persistCalls === 1);

let persistedValue = true;
globalThis.navigator.storage.persisted = async () => persistedValue;
persistedValue = true;
check("already-persistent storage is not re-requested", (await requestPersistentStorage()) === true && persistCalls === 1);

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);