/**
 * Pure, dependency-free Rucksack model.
 *
 * A Rucksack holds *anything that lives in a fenced code block*: items, events,
 * secrets, spell text, dialogue, recipes, config snippets - whatever the site
 * fences. Nothing here knows about "items" specifically, so the same plugin is
 * useful outside of any particular site.
 *
 * Persistence lives in `./db.ts` (Dexie / IndexedDB); everything here is plain
 * data plus small helpers, so it stays testable and importable on its own.
 */

export interface RucksackEntry {
  /** Unique id: `page#anchor` of the block the entry was stashed from. */
  slug: string;
  /** Name of the entry, as written inside the fence (never truncated). */
  name: string;
  /**
   * Fence language the entry came from: "item", "event", "secret", "yaml", …
   * Empty for a fence with no language. Free-form by design: the plugin never
   * restricts which languages can be stashed.
   */
  category: string;
  /** How many of this entry are carried. Always >= 1. */
  quantity: number;
  /** Where the entry was found, e.g. "Cellar, shelf 2". May be empty. */
  location: string;
  /** ISO timestamp of when the entry was first stashed. */
  timestamp: string;
  /** Note slug the entry was first stashed from, kept for provenance. */
  page: string;
  /** Anchor id of the block on that page. */
  anchor: string;
  /**
   * Every `page#anchor` block folded into this row. Normally just the entry's
   * own `slug`; a second block with the same name found on another page merges
   * into this row rather than making a new one, and this is how that block
   * still knows it is stashed (and can be unstashed again).
   */
  sources?: string[];
}

export const DEFAULT_STORAGE_KEY = "quartz:rucksack";

/**
 * Category given to records that predate the free-form category (i.e. a legacy
 * inventory written before the plugin was generalised). A fence with no language
 * is stored as `UNCATEGORIZED` instead - it is a different thing.
 */
export const DEFAULT_CATEGORY = "item";

/** Category of a fence that carries no language at all. */
export const UNCATEGORIZED = "";

/** Shown in place of the empty category, so a plain fence is still labelled. */
export const UNCATEGORIZED_LABEL = "block";

export function isCategory(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Normalize a fence language into a category: trimmed, lower-cased, and empty
 * for anything that is not a usable language name.
 */
export function normalizeCategory(value: unknown): string {
  if (typeof value !== "string") return UNCATEGORIZED;
  return value.trim().toLowerCase();
}

/** Category as it should be shown in the UI. */
export function displayCategory(category: string): string {
  return category.length > 0 ? category : UNCATEGORIZED_LABEL;
}

/**
 * Selector matching every stashable block.
 *
 * With `languages: "*"` (the default) Rucksack stashes *everything* that is in a
 * fenced block, so the selector is just the rendered `<pre>`. With an explicit
 * list it narrows to those fence languages. An exclusion list cannot be
 * expressed in CSS ("any language but these"), so it is left to
 * `isLanguageStashable`, which filters the result.
 *
 * rehype-pretty-code renders a fence as
 * `<figure data-rehype-pretty-code-figure><pre data-language="item">…</pre></figure>`,
 * putting `data-language` on the `<pre>` and the nested `<code>`; the `<pre>` is
 * the outermost element, so matching it once covers both.
 */
export function blockSelector(
  languages: string[] | "*" = "*",
  exclude: string[] = [],
): string {
  // `"*"` means "every language", with or without exclusions.
  if (languages === "*") return "pre";

  const excluded = new Set(exclude.map(normalizeCategory).filter(Boolean));
  return languages
    .map(normalizeCategory)
    .filter((lang) => lang && !excluded.has(lang))
    .map((lang) => `[data-language="${lang}"]`)
    .join(",");
}

/** Is this fence language stashable under the given selector languages? */
export function isLanguageStashable(
  language: string | null | undefined,
  languages: string[] | "*" = "*",
  exclude: string[] = [],
): boolean {
  const lang = normalizeCategory(language ?? UNCATEGORIZED);
  const excluded = exclude.map(normalizeCategory);
  if (lang && excluded.includes(lang)) return false;
  if (languages === "*") return true;
  return languages.map(normalizeCategory).includes(lang);
}

export function isRucksackEntry(value: unknown): value is RucksackEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<RucksackEntry>;
  return (
    typeof entry.slug === "string" &&
    entry.slug.length > 0 &&
    typeof entry.name === "string" &&
    typeof entry.timestamp === "string" &&
    typeof entry.page === "string" &&
    typeof entry.anchor === "string"
  );
}

/** Clamp to a whole number of entries, at least one. */
export function normalizeQuantity(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(999, Math.round(parsed)));
}

/**
 * Are these two names the same entry?
 *
 * The rucksack compares names by equivalence (case, punctuation and spacing
 * ignored), so `Health`, `health` and `HEALTH!` are one entry: stashing another
 * one adds to its quantity instead of creating a duplicate row.
 */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = slugify(a ?? "");
  const right = slugify(b ?? "");
  return left.length > 0 && left === right;
}

/** The entry in `entries` that is the same as `entry`, if any. */
export function findSameName(entries: RucksackEntry[], name: string): RucksackEntry | undefined {
  return entries.find((e) => sameName(e.name, name));
}

/** All `page#anchor` blocks folded into this row, its own slug included. */
export function entrySources(entry: RucksackEntry): string[] {
  return [...new Set([entry.slug, ...(entry.sources ?? [])])];
}

/** The entry stashed from this exact block, if any. Blocks are identified by
 *  their anchor, so two `kompass` blocks on one page are two separate entries. */
export function findSameBlock(
  entries: RucksackEntry[],
  slug: string,
): RucksackEntry | undefined {
  return entries.find((e) => entrySources(e).includes(slug));
}

/**
 * The carried entry this block should merge into: the same name, but stashed from
 * a *different* page. Merging is deliberate across pages (a `kompass` found in
 * the cellar is the same kompass found in the shed) and deliberately not within
 * one page, where repeated names are distinct blocks.
 */
export function findMergeTarget(
  entries: RucksackEntry[],
  page: string,
  name: string,
): RucksackEntry | undefined {
  return entries.find((e) => e.page !== page && sameName(e.name, name));
}

/**
 * Is this block (identified by its `page#anchor` slug) the one in the bag?
 *
 * Strictly by anchor. Carrying a `kompass` stashed on another page says nothing
 * about *this* block, and letting it leak across would light up every repeated
 * name on the page - the bug this replaced. Merging across pages happens in the
 * entry (see `findMergeTarget`), not in the block's own state.
 */
export function isBlockCarried(entries: RucksackEntry[], slug: string): boolean {
  return findSameBlock(entries, slug) !== undefined;
}

/**
 * Total number of blocks folded into these entries, counting each merged block
 * once. Used to keep the panel badge honest when a row covers several blocks.
 */
export function countStashedBlocks(entries: RucksackEntry[]): number {
  return new Set(entries.flatMap(entrySources)).size;
}

/** Fill in defaults for anything a stored record (or legacy payload) lacks. */
export function normalizeEntry(value: unknown): RucksackEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Partial<RucksackEntry> & { title?: string; addedAt?: string };

  const name = typeof entry.name === "string" ? entry.name : entry.title;
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  const timestamp =
    typeof entry.timestamp === "string"
      ? entry.timestamp
      : typeof entry.addedAt === "string"
        ? entry.addedAt
        : "";

  if (!name || !slug || !timestamp) return null;

  return {
    slug,
    name,
    // A record written before categories were free-form has no `category` at
    // all; those are legacy `item` entries. A record that *has* one keeps it.
    category:
      entry.category === undefined || entry.category === null
        ? DEFAULT_CATEGORY
        : normalizeCategory(entry.category),
    quantity: normalizeQuantity(entry.quantity),
    location: typeof entry.location === "string" ? entry.location : "",
    timestamp,
    page: typeof entry.page === "string" ? entry.page : "",
    anchor: typeof entry.anchor === "string" ? entry.anchor : "",
    sources: Array.isArray(entry.sources)
      ? entry.sources.filter((s): s is string => typeof s === "string" && s.length > 0)
      : undefined,
  };
}

/**
 * Add a freshly stashed entry. If the same entry is already carried, its
 * quantity grows instead of a second row appearing, and the new block is
 * recorded in `sources` so it still reads as stashed - and can be unstashed - on
 * its own.
 */
export function addStashedEntry(
  entry: RucksackEntry,
  current: RucksackEntry[],
): RucksackEntry[] {
  const existing = findSameName(current, entry.name);
  if (!existing) return [{ ...entry, sources: entrySources(entry) }, ...current];

  const merged: RucksackEntry = {
    ...existing,
    quantity: normalizeQuantity(existing.quantity + entry.quantity),
    sources: [...new Set([...entrySources(existing), ...entrySources(entry)])],
  };

  return [merged, ...current.filter((e) => e !== existing)];
}

/**
 * Take an entry back out: subtract the quantity that was carried in, dropping the
 * row entirely once nothing is left of it.
 */
export function removeStashedEntry(
  item: Pick<RucksackEntry, "name" | "quantity">,
  current: RucksackEntry[],
): RucksackEntry[] {
  const existing = findSameName(current, item.name);
  if (!existing) return current;

  const quantity = existing.quantity - item.quantity;
  if (quantity < 1) return current.filter((e) => e !== existing);

  return [{ ...existing, quantity }, ...current.filter((e) => e !== existing)];
}

/**
 * Parse a legacy `localStorage` payload, dropping malformed records. Pre-1.0
 * rucksacks only had `title`/`addedAt` and no category, quantity or location.
 */
export function parseRucksack(raw: string | null): RucksackEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeEntry)
      .filter((entry): entry is RucksackEntry => entry !== null);
  } catch {
    return [];
  }
}

export function serializeRucksack(entries: RucksackEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/** Newest entries first. */
export function sortEntries(entries: RucksackEntry[]): RucksackEntry[] {
  return [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function removeEntry(entries: RucksackEntry[], slug: string): RucksackEntry[] {
  return entries.filter((e) => e.slug !== slug);
}

export function addEntry(
  entries: RucksackEntry[],
  entry: RucksackEntry,
): RucksackEntry[] {
  const withoutDuplicate = entries.filter((e) => e.slug !== entry.slug);
  return sortEntries([entry, ...withoutDuplicate]);
}

export function toggleEntry(
  entries: RucksackEntry[],
  entry: RucksackEntry,
): RucksackEntry[] {
  const exists = entries.some((e) => e.slug === entry.slug);
  return exists ? removeEntry(entries, entry.slug) : addEntry(entries, entry);
}

/**
 * GitHub-style slug, matching what Quartz uses for heading anchors.
 * Kept dependency-free so it can be reused outside the browser bundle.
 */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** Longest anchor kept, so a long first line cannot produce a monster slug. */
export const MAX_ANCHOR_LENGTH = 64;

/**
 * Anchor for a block: the slugified name, truncated. Two blocks with the same
 * name on one page get distinct anchors by appending a slot number (see the
 * runtime), which is why the anchor is derived from the name and not from a
 * heading id.
 */
export function anchorForName(name: string, slot = 0): string {
  const base = slugify(name).slice(0, MAX_ANCHOR_LENGTH) || "block";
  return slot === 0 ? base : `${base}-${slot}`;
}

/**
 * Extract the entry name from a fenced block.
 * Takes the first non-empty trimmed line of the block's text.
 */
export function nameFromBlock(text: string | null | undefined): string {
  if (!text) return "";
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export interface EntryDetails {
  quantity: number;
  location: string;
}

/**
 * Read quantity/location hints from the remaining lines of a fence, so authors
 * can write:
 *
 *   ```item
 *   Diesel
 *   x3
 *   Location: Cellar, shelf 2
 *   ```
 *
 * Recognised forms: `x3` / `3x` / a bare number for quantity, and
 * `location: …` (also `found in …`, `where: …`). Anything else is ignored and
 * falls back to the defaults.
 *
 * Only used when `parseDetails` is on: for a site that stashes arbitrary code
 * fences, a bare `3` in the snippet is a number in the snippet, not a quantity.
 */
export function detailsFromBlock(text: string | null | undefined): EntryDetails {
  const details: EntryDetails = { quantity: 1, location: "" };
  if (!text) return details;

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    // Drop the name line (the first non-empty one).
    .filter((line) => line.length > 0)
    .slice(1);

  for (const line of lines) {
    const labeled = /^(?:location|found\s+in|where)\s*[:=]\s*(.+)$/i.exec(line);
    if (labeled) {
      details.location = labeled[1]?.trim() ?? "";
      continue;
    }
    const quantity = /^x\s*(\d+)$|^(\d+)\s*x$|^(\d+)$/i.exec(line);
    if (quantity) {
      details.quantity = normalizeQuantity(quantity[1] ?? quantity[2] ?? quantity[3]);
    }
  }

  return details;
}

/** Longest entry name shown in full before it is elided. */
export const MAX_DISPLAY_NAME = 20;

/**
 * Shorten an entry name for display, e.g.
 *   "Lorem Ipsum ladada blablaba" -> "Lorem Ipsum ladada..."
 * Display only - the stored name is never truncated.
 */
export function truncateName(
  name: string | null | undefined,
  max: number = MAX_DISPLAY_NAME,
): string {
  const text = (name ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}...`;
}