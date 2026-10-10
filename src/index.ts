export { default as Inventory } from "./components/Inventory";
export type { InventoryOptions } from "./components/Inventory";

export {
  DEFAULT_CATEGORY,
  DEFAULT_STORAGE_KEY,
  ITEM_CATEGORIES,
  ITEM_SELECTOR,
  MAX_DISPLAY_TITLE,
  addEntry,
  addStashedItem,
  isInventoryEntry,
  isItemCategory,
  itemDetailsFromBlock,
  itemNameFromBlock,
  mergeKeyFor,
  normalizeEntry,
  normalizeQuantity,
  parseInventory,
  removeEntry,
  removeStashedItem,
  serializeInventory,
  slugify,
  sortInventory,
  toggleEntry,
  truncateTitle,
} from "./lib/inventory";
export type { InventoryEntry, ItemCategory, ItemDetails } from "./lib/inventory";

export {
  DexieInventoryStore,
  InventoryDb,
  databaseName,
  openInventoryStore,
  requestPersistentStorage,
} from "./lib/db";
export type { InventoryStore, MetaRecord } from "./lib/db";

export type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types";
