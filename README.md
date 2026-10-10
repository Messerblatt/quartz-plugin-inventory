# @quartz-community/plugin-inventory

Inventory ("Rucksack") component for [Quartz v5](https://quartz.jzhao.xyz).
Notes written in Obsidian, published with Quartz — this plugin lets readers stash
notes into a persistent, `localStorage`-backed backpack.

## Features

- Per-note **"+ Stash" / "✓ Stashed"** button injected into the article body.
  Stashing blanks the item's text, so the source page stays clean.
- A collapsible **Inventory** panel (right sidebar by default) with a count badge.
- A **"Show all"** button that opens a modal with the full inventory — themed via
  Quartz CSS variables, closes on backdrop click, `Esc` or the × button.
- Entries persist across pages, reloads and builds — they live in the reader's
  browser only, never on the server.
- Remove single entries, or clear the whole inventory from the modal.
- Item links reproduce the exact page URL they were stashed from, so they keep
  working with nested paths (`/notes/gear/`) and trailing slashes.
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

`localStorage["quartz:inventory"]` (configurable):

```json
[
  {
    "slug": "notes/gear/#diesel",
    "title": "Diesel",
    "page": "notes/gear/",
    "anchor": "diesel",
    "addedAt": "2026-10-09T19:10:20.029Z"
  }
]
```

`page` is the page path as the browser sees it (no leading slash), so
`/${page}#${anchor}` rebuilds a working link.

Pure helpers for this format live in `src/lib/inventory.ts` and are exported:

```ts
import {
  addEntry,
  parseInventory,
  removeEntry,
  serializeInventory,
  sortInventory,
  toggleEntry,
} from "@quartz-community/plugin-inventory";
```

## Storage keys

| Key | Purpose |
| --- | --- |
| `quartz:inventory` | the entries array |
| `quartz:inventory:open` | panel open/closed state |

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
├── lib/inventory.ts                       # storage model + pure helpers
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
