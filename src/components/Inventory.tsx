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
              data-inventory-show-all
              hidden
            >
              Show all
            </button>
          </div>
        </div>

        <div class="inventory-modal" data-inventory-modal hidden>
          <div class="inventory-modal-backdrop" data-inventory-modal-backdrop></div>

          <div
            class="inventory-modal-content"
            role="dialog"
            aria-modal="true"
            aria-label={`${title} — all items`}
          >
            <div class="inventory-modal-header">
              <span class="inventory-modal-title">{title}</span>
              <button
                type="button"
                class="inventory-modal-close"
                data-inventory-modal-close
                aria-label="Close"
              >
                &#10005;
              </button>
            </div>

            <p class="inventory-modal-hint">
              Adjust quantity and where each item was found; changes are saved
              automatically.
            </p>

            <ul class="inventory-list inventory-modal-list" data-inventory-modal-items></ul>

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
        </div>
      </aside>
    );
  };

  Inventory.css = style;
  Inventory.afterDOMLoaded = script;

  return Inventory;
}) satisfies QuartzComponentConstructor;
