# @quartz-community/plugin-inventory

Inventory ("Rucksack") component for [Quartz v5](https://quartz.jzhao.xyz).
Notes written in Obsidian, published with Quartz — this plugin lets readers stash
items into a persistent, IndexedDB-backed backpack.

## Features

- Per-note **"+ Stash" / "✓ Stashed"** button injected into the article body.
  Stashing blanks the item's text, so the source page stays clean.
- Any fenced block whose language is a known category is stowable: ` ```item `
  (default), plus ` ```event ` and ` ```secret `. The category is stored with the
  entry and shown as a tag next to it.
- Every stashed item records its **name**, **quantity**, **location** and a
  **timestamp**. Quantity and location come from the fence and are **read-only**
  in the UI — item metadata is never edited by the reader:

  ````markdown
  ```item
  Diesel
  x3
  Location: Cellar, shelf 2
  ```
  ````

- Identical items merge: stashing a second `health` raises the quantity of the
  existing `health` row instead of adding a duplicate. Stashing the same item
  again from another page adds its fenced quantity to the same row.
- Storage is **IndexedDB via [Dexie](https://dexie.org)**, not localStorage, so
  the inventory is not capped at a few megabytes and can grow.
- The plugin asks the browser for **persistent storage**
  (`navigator.storage.persist()`), so the inventory survives "clear site data".
- A collapsible **Inventory** panel (right sidebar by default) with a count badge.
- A **"Show all"** button that opens a modal with the full inventory — themed via
  Quartz CSS variables, closes on backdrop click, `Esc` or the × button. Every
  item occupies exactly one line (long values are ellipsised, never wrapped).
- Entries persist across pages, reloads and builds — they live in the reader's
  browser only, never on the server.
- Remove single entries, or clear the whole inventory from the modal.
- Entries render as plain text (no links); names longer than 20 characters are
  shown as the first 20 characters plus `…`, with the full name in the `title`
  tooltip. The stored name is never truncated.
- Pure CSS, respects `prefers-color-scheme` via Quartz CSS variables.

## Install

```bash
npm install @quartz-community/plugin-inventory
```

Then register the component in your Quartz `quartz.config.ts` (or the v5 plugin
manifest, which picks it up automatically):

```ts
import { Inventory } from "@quartz-community/plugin-inventory";

export default {
  plugins: {
    components: {
      right: [Inventory],
    },
  },
};
```

### Options

```ts
Inventory({
  storageKey: "quartz:inventory", // localStorage key
  title: "Inventory", // label on the toggle button
  className: "inventory", // wrapper class
});
```

## Storage format

IndexedDB database `"<storageKey>:db"` (default `quartz:inventory:db`), table
`items` keyed by `slug`:

```json
{
  "slug": "notes/gear/#diesel",
  "mergeKey": "item:diesel",
  "name": "Diesel",
  "category": "item",
  "quantity": 3,
  "location": "Cellar, shelf 2",
  "timestamp": "2026-10-09T19:10:20.029Z",
  "origins": ["notes/gear/#diesel", "shop/gear/#diesel"],
  "page": "notes/gear/",
  "anchor": "diesel"
}
```

`page` is the page path as the browser sees it (no leading slash).
`category` is the fence language (`item`, `event`, `secret`).
`mergeKey` (`category:slugified name`) is what de-duplicates items; `origins`
lists every block that contributed to the row, so unstashing a block only takes
back what that block added.

A pre-IndexedDB inventory in `localStorage["quartz:inventory"]` is migrated
once, on first open, and the old key is removed afterwards. Records without a
category/quantity/location are upgraded with `item` / `1` / `""`, and records
without a `mergeKey` get one on read (leftover duplicates then collapse into a
single row with a summed quantity).

The panel's open/closed flag stays in `localStorage` (`quartz:inventory:open`),
since it must be readable synchronously while the page renders.

### Categories

`ITEM_CATEGORIES` lists the stowable fence languages; add one there to make a
new kind of block stashable, and it is stored and rendered automatically.

Pure helpers for this format live in `src/lib/inventory.ts` (model) and
`src/lib/db.ts` (Dexie/IndexedDB), and both are exported:

```ts
import {
  addStashedItem,
  itemDetailsFromBlock,
  mergeKeyFor,
  normalizeQuantity,
  openInventoryStore,
  parseInventory,
  removeStashedItem,
  requestPersistentStorage,
  sortInventory,
  truncateTitle,
} from "@quartz-community/plugin-inventory";
```

```ts
const store = await openInventoryStore("quartz:inventory");
const items = await store.all();          // newest first, duplicates merged
await store.put({ slug: "gear#diesel", mergeKey: mergeKeyFor("Diesel", "item"),
                  name: "Diesel", category: "item", quantity: 3, location: "Cellar",
                  timestamp: new Date().toISOString(), origins: ["gear#diesel"],
                  page: "gear", anchor: "diesel" });
```

## Storage

| Store | Purpose |
| --- | --- |
| IndexedDB `quartz:inventory:db` → `items` | the stashed items |
| IndexedDB `quartz:inventory:db` → `meta` | one-shot migration flag |
| `localStorage` `quartz:inventory:open` | panel open/closed state |
| `localStorage` `quartz:inventory` | legacy inventory, migrated once |

## Development

```bash
npm install
npm run dev        # watch build
npm run typecheck
npm run build
npm run check      # typecheck + build + browser runtime tests
```

### Project layout

```text
src/
├── index.ts
├── lib/inventory.ts                       # data model + pure helpers
├── lib/db.ts                              # Dexie/IndexedDB store + persistence
└── components/
    ├── Inventory.tsx                      # QuartzComponent
    ├── scripts/inventory.inline.ts        # browser runtime (transpiled to a JS string)
    └── styles/inventory.scss              # compiled to a CSS string
```

`tsup.config.ts` contains an `inline-script-loader` esbuild plugin mirroring
Quartz v5: `.scss` is compiled by `sass` and loaded as text, `.inline.ts` is
transpiled and bundled for the browser and loaded as text. The component then
wires them up with `Component.css = style` and
`Component.afterDOMLoaded = script`.

## License

MIT
