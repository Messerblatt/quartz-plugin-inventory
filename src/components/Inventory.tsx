import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types";
import { DEFAULT_STORAGE_KEY } from "../lib/inventory";
import style from "./styles/inventory.scss";
// @ts-expect-error - inline script import handled by the Quartz/esbuild inline-script-loader
import script from "./scripts/inventory.inline.ts";

export interface InventoryOptions {
  /** localStorage key used to persist the inventory. */
  storageKey?: string;
  /** Label shown on the toggle button. */
  title?: string;
  className?: string;
}

export default ((opts?: InventoryOptions) => {
  const {
    storageKey = DEFAULT_STORAGE_KEY,
    title = "Inventory",
    className = "inventory",
  } = opts ?? {};

  const Inventory: QuartzComponent = (_props: QuartzComponentProps) => {
    return (
      <aside class={className} data-inventory data-inventory-key={storageKey}>
        <button type="button" class="inventory-toggle" data-inventory-toggle>
          <span class="inventory-icon" aria-hidden="true">
            &#127890;
          </span>
          <span class="inventory-label">{title}</span>
          <span class="inventory-count" data-inventory-count>
            0
          </span>
        </button>

        <div class="inventory-panel" data-inventory-panel hidden>
          <p class="inventory-empty" data-inventory-empty>
            No items in your inventory yet. Use
            <code>+ Stash</code> on any item block.
          </p>

          <ul class="inventory-list" data-inventory-items></ul>

          <div class="inventory-actions">
            <button
              type="button"
              class="inventory-clear"
              data-inventory-clear
              hidden
            >
              Clear
            </button>
          </div>
        </div>
      </aside>
    );
  };

  Inventory.css = style;
  Inventory.afterDOMLoaded = script;

  return Inventory;
}) satisfies QuartzComponentConstructor;
