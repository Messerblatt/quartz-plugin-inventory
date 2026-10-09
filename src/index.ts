export { default as Inventory } from "./components/Inventory";
export type { InventoryOptions } from "./components/Inventory";

export {
  DEFAULT_STORAGE_KEY,
  ITEM_SELECTOR,
  addEntry,
  isInventoryEntry,
  itemNameFromBlock,
  parseInventory,
  removeEntry,
  serializeInventory,
  slugify,
  sortInventory,
  toggleEntry,
} from "./lib/inventory";
export type { InventoryEntry } from "./lib/inventory";

export type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types";
