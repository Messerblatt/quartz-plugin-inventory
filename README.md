# @quartz-community/plugin-rucksack

**Rucksack** is a [Quartz v5](https://quartz.jzhao.xyz) component that lets readers
**stash anything inside a fenced code block** into a persistent, IndexedDB-backed
pack.

It started life as an item-bag for one particular site, where notes were written
in Obsidian and items were written as ` ```item `, ` ```event ` and ` ```secret `
fences. It no longer cares. By default **every fenced block on the page is
stowable** — YAML config, spell text, dialogue, a recipe, a secret, a snippet —
and the fence's language is recorded with the entry and shown as a tag.

> Renamed from `@quartz-community/plugin-inventory`. See [CHANGELOG.md](CHANGELOG.md)
> for the breaking changes.

## Features

- A **"+ Stash" / "✓ Stashed"** button on every stashable fenced block.
- **Everything in a fence is stowable.** With the default `languages: "*"` the
  plugin does not care what language a fence has, or whether it has one at all.
  Narrow it to a list of languages, or exclude some, when a site wants that.
- **`removeFromDom`** decides what stashing does to the page: the block leaves it
  entirely (the default — the page reads as if you picked the thing up), or it
  stays exactly where it is, marked as stashed. Both are first-class; see
  [Options](#options).
- Every entry records its **name**, **category** (the fence language),
  **quantity**, **location** and a **timestamp**. Quantity and location come
  from the fence and are **read-only** in the UI:

  ````markdown
  ```item
  Diesel
  x3
  Location: Cellar, shelf 2
  ```
  ````

  Turn that parsing off with `parseDetails: false` if a bare `3` in a snippet is
  a number in the snippet and not a quantity.

- Identical names merge: names are compared by equivalence (case, punctuation and
  spacing ignored), so stashing a second `health` raises the quantity of the
  carried `health` instead of adding a duplicate row. Set `merge: false` to keep
  every block as its own row.
- Two blocks with the same name on **one page** stay two entries, and are tracked
  by anchor, so stashing one never disturbs the other.
- Storage is **IndexedDB via [Dexie](https://dexie.org)**, not localStorage, so
  the rucksack is not capped at a few megabytes and can grow.
- The plugin asks the browser for **persistent storage**
  (`navigator.storage.persist()`), so the rucksack survives "clear site data".
- A collapsible **panel** (right sidebar by default) with a count badge, and a
  **"Show all"** button that opens a modal with the full contents — themed via
  Quartz CSS variables, closes on backdrop click, `Esc` or the × button.
- Entries live in the reader's browser only, never on the server.
- Successful stash and unstash actions emit document-level custom events for
  site-specific front-end behavior.
- Pure CSS, driven by Quartz CSS variables, so it follows the theme.

## Install

```bash
npm install @quartz-community/plugin-rucksack
```

Then register the component in your Quartz `quartz.config.ts` (or the v5 plugin
manifest, which picks it up automatically):

```ts
import { Rucksack } from "@quartz-community/plugin-rucksack";

export default {
  plugins: {
    components: {
      right: [Rucksack],
    },
  },
};
```

The component takes its options inline:

```ts
import { Rucksack } from "@quartz-community/plugin-rucksack";

Rucksack({
  title: "Satchel",
  removeFromDom: false,
  excludeLanguages: ["ts", "json"],
});
```

## Options

Every option has a default, and every one of them can be set three ways — in
code (below), in the v5 plugin manifest's `defaultOptions`, or at runtime by
setting the matching `data-*` attribute on the panel element (see
[Runtime configuration](#runtime-configuration)).

### What gets stashed

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `languages` | `string[] \| "*"` | `"*"` | Fence languages that can be stashed. `"*"` stashes **every** fenced block; an array restricts it, e.g. `["item", "event"]`. |
| `excludeLanguages` | `string[]` | `[]` | Fence languages to skip on top of `languages`. `["ts", "js"]` keeps code snippets out of a site that stashes everything else. |
| `nameAttribute` | `string \| null` | `null` | Read the name from this attribute (on the block or its `<figure>`) instead of the block's first line — for fences that have no meaningful first line, e.g. a command block named `data-title="Deploy to staging"`. |
| `parseDetails` | `boolean` | `true` | Read `x3` / `Location: …` hints from the lines after the name. |

### What stashing does to the page

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `removeFromDom` | `boolean` | `true` | `true`: the stashed block leaves the page (fence, figure and button) and comes back, in its original position, when unstashed. `false`: the block stays put and is marked as stashed — dimmed, with an accent rule down its side and a filled-in button. |
| `merge` | `boolean` | `true` | Merge blocks with the same name stashed from *another* page into one row with a higher quantity. |

`removeFromDom: true` is the right default for a game or story: a picked-up
`kompass` should not still be lying on the page. `false` is the right choice for
a tutorial or a reference page, where the prose refers to the snippets around
them and the page must not change shape under the reader.

### The panel

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `storageKey` | `string` | `"quartz:rucksack"` | Database name and localStorage namespace. Blocks are stashed into the first panel's store, so use one key per rucksack. |
| `title` | `string` | `"Rucksack"` | Label on the toggle button. |
| `icon` | `string` | `"🎒"` | Glyph shown next to the title. |
| `className` | `string` | `"rucksack"` | Wrapper class of the panel. |
| `maxNameLength` | `number` | `20` | Name length shown in full before the UI elides it. The stored name is never truncated. |
| `sound` | `boolean` | `true` | Play a sound when something is stashed or unstashed. |
| `logEvents` | `boolean` | `true` | Log emitted stash events to the browser console. |
| `stashLabel` | `string` | `"+ Stash"` | Label on a block's button while it is not stashed. |
| `stashedLabel` | `string` | `"✓ Stashed"` | Label on a block's button while it is stashed. |

### Worked examples

Keep every snippet on the page, but not ordinary code:

```ts
Rucksack({
  removeFromDom: false,
  excludeLanguages: ["ts", "tsx", "js", "json", "css", "html"],
  title: "Collected",
});
```

A game world, where picked-up things should disappear from the page:

```ts
Rucksack({
  languages: ["item", "event", "secret"],
  icon: "🎒",
  title: "Inventory",
  storageKey: "wolke7000:inventory",
});
```

A reference site that stashes examples but names them with an attribute:

```ts
Rucksack({
  removeFromDom: false,
  nameAttribute: "data-title",
  parseDetails: false,
});
```

### Runtime configuration

The resolved config is written onto the panel as `data-*` attributes
(`data-rucksack-remove="false"`, `data-rucksack-languages="item,event"`, …) and
inlined into the page. **The attributes win**, so a single panel can override a
setting without a rebuild. The full mapping lives in `CONFIG_ATTRIBUTES`:

```ts
import { CONFIG_ATTRIBUTES, resolveConfig } from "@quartz-community/plugin-rucksack";

CONFIG_ATTRIBUTES.removeFromDom; // "data-rucksack-remove"
```

Stashable blocks are discovered on every page, including pages that render no
panel at all — but a page with no panel also has no `data-*` attributes, so it
runs with the inlined config. Renders the panel in the sidebar if you want every
option to apply everywhere.

## Events

After a successful action, Rucksack dispatches a custom event on `document`:

| Event | Emitted when |
| --- | --- |
| `rucksack:stashed` | A block is stashed. |
| `rucksack:unstashed` | A block or stored row is unstashed, including entries removed with `Clear`. |

The event's `detail` contains an entry snapshot, the storage key, and the
source of the action (`"block"`, `"panel"`, or `"clear"`):

```ts
import type { RucksackEventDetail } from "@quartz-community/plugin-rucksack";

document.addEventListener("rucksack:stashed", (event) => {
  const { entry } = (event as CustomEvent<RucksackEventDetail>).detail;

  if (entry.name.toLowerCase() === "health potion") {
    document.body.classList.add("has-health-potion");
  }
});
```

The corresponding event name for removal is `rucksack:unstashed`. The
`entry` is a plain snapshot, so listeners may safely inspect it without
altering Rucksack's stored state. The exported `RUCKSACK_EVENTS` constant and
`RucksackEventDetail` type are also available from the package root.

Set `logEvents: true` while developing to have Rucksack log each emitted event
and its payload automatically:

```ts
Rucksack({ logEvents: true });
```

For temporary console-only debugging, logging can also be changed without a
rebuild or reload:

```js
__RUCKSACK__.setEventLogging(true);  // enable
__RUCKSACK__.setEventLogging(false); // disable
__RUCKSACK__.getEventLogging();      // inspect the current setting
```

This override applies immediately to future events and lasts for the current
page session. A full reload returns to the configured `logEvents` value.

## How a block becomes an entry

1. **Name** — the first non-empty rendered line of the fence, or the
   `nameAttribute` value when one is configured.
2. **Category** — the fence's language, or empty for a fence with none. Shown as
   a tag; a fence with no language shows as `block`.
3. **Quantity and location** — read from the lines after the name (`x3`,
   `Location: …`), if `parseDetails` is on.
4. **Anchor** — the slugified name, truncated, with a slot number appended when
   a page repeats the name. The entry's `slug` is `page#anchor`, so two blocks
   with the same name on one page are two entries, and unstashing puts each block
   back where it was.

## Storage format

IndexedDB database `"<storageKey>:db"` (default `quartz:rucksack:db`), table
`entries` keyed by `slug`:

```json
{
  "slug": "notes/gear/#diesel",
  "name": "Diesel",
  "category": "item",
  "quantity": 3,
  "location": "Cellar, shelf 2",
  "timestamp": "2026-10-09T19:10:20.029Z",
  "page": "notes/gear/",
  "anchor": "diesel"
}
```

`page` is the page path as the browser sees it (no leading slash). `category` is
the fence language, or `""` for a fence without one.

There is no merge key to maintain: when a block is stashed, its name is compared
against the carried entries (`sameName`) and an equivalent name grows that row's
quantity instead of inserting a new one.

| Store | Purpose |
| --- | --- |
| IndexedDB `quartz:rucksack:db` → `entries` | the stashed entries |
| IndexedDB `quartz:rucksack:db` → `meta` | one-shot migration flag |
| `localStorage` `quartz:rucksack:open` | panel open/closed state |
| `localStorage` `quartz:rucksack` | legacy rucksack, migrated once |

### Migrating from `@quartz-community/plugin-inventory`

The package was renamed, and with it the default storage key. To keep an
existing inventory, pass the old key once:

```ts
Rucksack({ storageKey: "quartz:inventory" });
```

That reuses the existing `<key>:db` database as-is. The `items` → `entries`
table rename inside it is handled by a schema upgrade, so existing rows survive.
Note that the category of an old record stays whatever language its fence had
(`item`, `event`, `secret`); the plugin no longer requires those names.

## Programmatic use

Pure helpers for the model live in `src/lib/rucksack.ts` and `src/lib/config.ts`,
and the store in `src/lib/db.ts`. All are exported:

```ts
import {
  addStashedEntry,
  blockSelector,
  detailsFromBlock,
  findSameName,
  normalizeQuantity,
  openRucksackStore,
  parseRucksack,
  removeStashedEntry,
  requestPersistentStorage,
  resolveConfig,
  sameName,
  sortEntries,
  truncateName,
} from "@quartz-community/plugin-rucksack";
```

```ts
const store = await openRucksackStore("quartz:rucksack");
const entries = await store.all();      // newest first
await store.put({
  slug: "gear#diesel",
  name: "Diesel",
  category: "item",
  quantity: 3,
  location: "Cellar",
  timestamp: new Date().toISOString(),
  page: "gear",
  anchor: "diesel",
});
```

## Styling

The component ships pure CSS keyed on `rucksack-*` classes, all driven by Quartz
CSS variables (`--light`, `--dark`, `--secondary`, `--linkColor`). Override the
variables on `.rucksack` to theme it, or restyle `.rucksack-entry` and
`.rucksack-block-toggle` directly.

`prefers-reduced-motion: reduce` drops the stash blink animation and keeps the
colour cue instead.

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
├── lib/rucksack.ts                       # data model + pure helpers
├── lib/config.ts                         # options, defaults, normalization
├── lib/db.ts                             # Dexie/IndexedDB store + persistence
└── components/
    ├── Rucksack.tsx                      # QuartzComponent
    ├── scripts/rucksack.inline.ts        # browser runtime (transpiled to a JS string)
    └── styles/rucksack.scss              # compiled to a CSS string
```

`tsup.config.ts` contains an `inline-script-loader` esbuild plugin mirroring
Quartz v5: `.scss` is compiled by `sass` and loaded as text, `.inline.ts` is
transpiled and bundled for the browser and loaded as text. The component then
wires them up with `Component.css = style` and
`Component.afterDOMLoaded = [config, script]` — the config object first, then the
runtime that reads it back.

## License

MIT
