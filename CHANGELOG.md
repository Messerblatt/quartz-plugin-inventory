# Changelog

## 1.0.0 — Rucksack

The plugin was generalised and renamed. It used to be an item bag for one site;
it is now a stash for anything that lives in a fenced block.

### Renamed

- **Inventory → Rucksack.** The package is now `@quartz-community/plugin-rucksack`,
  the component is `Rucksack`, the CSS classes are `rucksack-*`, the `data-*`
  attributes are `data-rucksack-*`, and the sources are `rucksack.ts(x)` /
  `rucksack.inline.ts` / `rucksack.scss`.
- **Breaking:** the default `storageKey` is `quartz:rucksack`. Pass
  `storageKey: "quartz:inventory"` to keep using an existing rucksack.
- **Breaking:** renamed exports. `Inventory` → `Rucksack`, `InventoryOptions` →
  `RucksackOptions`, `InventoryEntry` → `RucksackEntry`, `InventoryStore` →
  `RucksackStore`, `DexieInventoryStore` → `DexieRucksackStore`, `InventoryDb` →
  `RucksackDb`, `openInventoryStore` → `openRucksackStore`, and the model
  helpers now speak of entries and names rather than items
  (`findSameName`, `sameName`, `nameFromBlock`, `detailsFromBlock`,
  `addStashedEntry`, `removeStashedEntry`, `parseRucksack`, `serializeRucksack`,
  `sortEntries`, `truncateName`, `normalizeCategory`).
- **Breaking (storage):** the IndexedDB table `items` is now `entries`. Existing
  databases are migrated in place by a schema upgrade.

### Generalized

- **Every fenced block is stowable.** With the new default `languages: "*"` the
  plugin no longer looks for a fixed list of fence languages (`item`, `event`,
  `secret`); anything in a fence can be stashed, and the fence language is stored
  with the entry and shown as a tag. A fence with no language is stored without
  a category and labelled `block`.
- `languages` restricts stashing to a list of languages, and `excludeLanguages`
  skips some — for a site that wants everything except its code snippets.
- `nameAttribute` names an entry from an attribute instead of the block's first
  line, for fences that have no meaningful first line.
- `parseDetails: false` stops `x3` / `Location: …` lines from being read as
  quantity and location, for sites where a bare number is just a number.

### Options

All of these are new, and can be set in code, in the plugin manifest's
`defaultOptions`, or as `data-*` attributes on the panel (which win):

- `removeFromDom` — whether stashing removes the block from the page. `true`
  (default) removes fence, figure and button, and unstashing puts them back
  exactly where they were. `false` leaves the block in place, marked as stashed
  (dimmed, with an accent rule) and toggled in place.
- `merge` — whether same-named blocks stashed on another page merge into one
  row. Defaults to the previous behaviour.
- `languages`, `excludeLanguages`, `nameAttribute`, `parseDetails` — see above.
- `icon`, `className`, `title`, `storageKey`, `maxNameLength`, `sound`,
  `stashLabel`, `stashedLabel` — the panel is now fully customizable.
- `resolveConfig`, `DEFAULT_CONFIG`, `configAttributes`, `configFromAttributes`,
  `CONFIG_ATTRIBUTES` and `serializeConfig` are exported, so a config can be
  resolved and rendered the same way the plugin does it.

### Notes

- Anchors are now capped at 64 characters, so a long first line cannot produce a
  monster slug.
- Stashable blocks are mounted on pages with no panel as before; such a page runs
  with the inlined config, since it has no `data-*` attributes to override it.
- Item metadata stays **immutable**: quantity and location are read-only in the
  UI and come from the fence only.
- Identical names still **merge** by equivalence (case/punctuation/spacing
  ignored) unless `merge: false`.
- The "Show all" modal is wider, renders one entry per line, and sits at
  `z-index: 99999` so Quartz's left sidebar can never overlap it.

## 0.1.0

- Initial release: Quartz v5 Inventory component with `localStorage` persistence.