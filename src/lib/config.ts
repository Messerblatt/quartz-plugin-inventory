/**
 * Rucksack's configuration: the options a site can set, their defaults, and the
 * normalization that turns whatever the author passed into a complete config.
 *
 * This module is the single source of truth shared by the component (which
 * renders the panel and inlines the resolved config into the page) and the
 * browser runtime (which reads it back). It is deliberately DOM-free and
 * dependency-free so both sides can import it.
 */

/** Fence languages to stash. `"*"` means every fenced block. */
export type Languages = "*" | string[];

export interface RucksackOptions {
  /**
   * Database name / localStorage namespace for this rucksack. Blocks are
   * stashed into the store of the first panel on the page, so use one key per
   * rucksack rather than per panel.
   * @default "quartz:rucksack"
   */
  storageKey?: string;
  /** Label on the toggle button. @default "Rucksack" */
  title?: string;
  /** Glyph shown next to the title. @default "🎒" */
  icon?: string;
  /** Wrapper class of the panel. @default "rucksack" */
  className?: string;
  /**
   * Which fenced blocks can be stashed. `"*"` (the default) stashes
   * *everything* in a fence - items, events, secrets, YAML, dialogue, whatever
   * the site fences. Pass an array to restrict it, e.g. `["item", "event"]`.
   * @default "*"
   */
  languages?: Languages;
  /**
   * Fence languages to skip, applied on top of `languages`. Handy to keep
   * ordinary code snippets out of the rucksack: `["ts", "js", "json"]`.
   * @default []
   */
  excludeLanguages?: string[];
  /**
   * What happens to a block when it is stashed:
   *
   *  - `true`  - the block leaves the page entirely (fence, figure and button),
   *              the way a picked-up item does, and comes back when unstashed.
   *  - `false` - the block stays exactly where it is, marked as stashed.
   *
   * Use `false` when the page's prose only makes sense with the block still in
   * it (a tutorial whose steps are the fenced blocks, say).
   * @default true
   */
  removeFromDom?: boolean;
  /**
   * Merge blocks with the same name stashed from *another* page into one row
   * with a higher quantity. @default true
   */
  merge?: boolean;
  /**
   * Read `x3` / `Location: …` hints from the lines after the name.
   * @default true
   */
  parseDetails?: boolean;
  /**
   * Read the entry's name from this attribute (on the block or its `<figure>`)
   * instead of the block's first line. Fences without a name line - code
   * snippets, for instance - can then name themselves, e.g. `"data-title"`.
   * @default null
   */
  nameAttribute?: string | null;
  /** Name length shown in full before the UI elides it. @default 20 */
  maxNameLength?: number;
  /** Play a sound when something is stashed / unstashed. @default true */
  sound?: boolean;
  /** Log emitted stash events to the browser console. @default true */
  logEvents?: boolean;
  /** Label on a block's button while it is not stashed. @default "+ Stash" */
  stashLabel?: string;
  /** Label on a block's button while it is stashed. @default "✓ Stashed" */
  stashedLabel?: string;
}

/** A complete config: every option resolved, nothing left `undefined`. */
export interface ResolvedRucksackConfig {
  storageKey: string;
  title: string;
  icon: string;
  className: string;
  languages: Languages;
  excludeLanguages: string[];
  removeFromDom: boolean;
  merge: boolean;
  parseDetails: boolean;
  nameAttribute: string | null;
  maxNameLength: number;
  sound: boolean;
  logEvents: boolean;
  stashLabel: string;
  stashedLabel: string;
}

export const DEFAULT_CONFIG: ResolvedRucksackConfig = {
  storageKey: "quartz:rucksack",
  title: "Rucksack",
  icon: "🎒",
  className: "rucksack",
  languages: "*",
  excludeLanguages: [],
  removeFromDom: true,
  merge: true,
  parseDetails: true,
  nameAttribute: null,
  maxNameLength: 20,
  sound: true,
  logEvents: true,
  stashLabel: "+ Stash",
  stashedLabel: "✓ Stashed",
};

function list(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
  }
  return [];
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|1|yes|on)$/i.test(value.trim())) return true;
    if (/^(false|0|no|off)$/i.test(value.trim())) return false;
  }
  return fallback;
}

/**
 * Fill in a complete config from whatever the author passed. Unknown keys are
 * ignored, so a serialized config can always be re-normalized safely.
 */
export function resolveConfig(
  options?: Partial<RucksackOptions> | null,
): ResolvedRucksackConfig {
  const opts = options ?? {};
  const languages: Languages =
    opts.languages === undefined || opts.languages === "*"
      ? "*"
      : list(opts.languages);

  const maxNameLength = Number(opts.maxNameLength);
  const nameAttribute = opts.nameAttribute;

  return {
    storageKey: text(opts.storageKey, DEFAULT_CONFIG.storageKey).trim(),
    title: text(opts.title, DEFAULT_CONFIG.title),
    icon: text(opts.icon, DEFAULT_CONFIG.icon),
    className: text(opts.className, DEFAULT_CONFIG.className),
    languages,
    excludeLanguages: list(opts.excludeLanguages),
    removeFromDom: bool(opts.removeFromDom, DEFAULT_CONFIG.removeFromDom),
    merge: bool(opts.merge, DEFAULT_CONFIG.merge),
    parseDetails: bool(opts.parseDetails, DEFAULT_CONFIG.parseDetails),
    nameAttribute:
      typeof nameAttribute === "string" && nameAttribute.trim().length > 0
        ? nameAttribute.trim()
        : null,
    maxNameLength: Number.isFinite(maxNameLength)
      ? Math.max(4, Math.round(maxNameLength))
      : DEFAULT_CONFIG.maxNameLength,
    sound: bool(opts.sound, DEFAULT_CONFIG.sound),
    logEvents: bool(opts.logEvents, DEFAULT_CONFIG.logEvents),
    stashLabel: text(opts.stashLabel, DEFAULT_CONFIG.stashLabel),
    stashedLabel: text(opts.stashedLabel, DEFAULT_CONFIG.stashedLabel),
  };
}

/**
 * Serialize a config for embedding in a `<script>` tag. `<` and the line
 * separators are escaped so a title can never terminate the tag.
 */
export function serializeConfig(config: ResolvedRucksackConfig): string {
  return JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Global the component's inline script picks its config up from.
 */
export const CONFIG_GLOBAL = "__RUCKSACK_CONFIG__";

export const CONFIG_SCRIPT_PREFIX = `window.${CONFIG_GLOBAL} = `;

/** Where each option is mirrored as a `data-*` attribute on the panel. */
export const CONFIG_ATTRIBUTES: Record<keyof RucksackOptions, string> = {
  storageKey: "data-rucksack-key",
  title: "data-rucksack-title",
  icon: "data-rucksack-icon",
  className: "data-rucksack-class",
  languages: "data-rucksack-languages",
  excludeLanguages: "data-rucksack-exclude-languages",
  removeFromDom: "data-rucksack-remove",
  merge: "data-rucksack-merge",
  parseDetails: "data-rucksack-details",
  nameAttribute: "data-rucksack-name-attribute",
  maxNameLength: "data-rucksack-max-name",
  sound: "data-rucksack-sound",
  logEvents: "data-rucksack-log-events",
  stashLabel: "data-rucksack-stash-label",
  stashedLabel: "data-rucksack-stashed-label",
};

/**
 * Render a resolved config as the `data-*` attributes the panel carries. The
 * component spreads these onto its root element and the runtime reads them back,
 * so a page can override any option without rebuilding the site.
 */
export function configAttributes(config: ResolvedRucksackConfig): Record<string, string> {
  const attrs: Record<string, string> = {
    [CONFIG_ATTRIBUTES.storageKey]: config.storageKey,
    [CONFIG_ATTRIBUTES.title]: config.title,
    [CONFIG_ATTRIBUTES.icon]: config.icon,
    [CONFIG_ATTRIBUTES.className]: config.className,
    [CONFIG_ATTRIBUTES.languages]:
      config.languages === "*" ? "*" : config.languages.join(","),
    [CONFIG_ATTRIBUTES.excludeLanguages]: config.excludeLanguages.join(","),
    [CONFIG_ATTRIBUTES.removeFromDom]: String(config.removeFromDom),
    [CONFIG_ATTRIBUTES.merge]: String(config.merge),
    [CONFIG_ATTRIBUTES.parseDetails]: String(config.parseDetails),
    [CONFIG_ATTRIBUTES.maxNameLength]: String(config.maxNameLength),
    [CONFIG_ATTRIBUTES.sound]: String(config.sound),
    [CONFIG_ATTRIBUTES.logEvents]: String(config.logEvents),
    [CONFIG_ATTRIBUTES.stashLabel]: config.stashLabel,
    [CONFIG_ATTRIBUTES.stashedLabel]: config.stashedLabel,
  };
  if (config.nameAttribute) {
    attrs[CONFIG_ATTRIBUTES.nameAttribute] = config.nameAttribute;
  }
  return attrs;
}

/**
 * Read a config out of `data-*` attributes. Anything absent is left `undefined`,
 * so the caller can layer this over a base config (attributes win).
 *
 * @param get reads an attribute's value, e.g. `el.getAttribute.bind(el)`.
 */
export function configFromAttributes(
  get: (attribute: string) => string | null | undefined,
): Partial<RucksackOptions> {
  const pick = (key: keyof RucksackOptions) => {
    const value = get(CONFIG_ATTRIBUTES[key]);
    return value === null || value === undefined ? undefined : value;
  };
  // A spread of `undefined` keys would clobber the config being layered over, so
  // absent attributes are left out of the result entirely.
  const present = <T extends object>(values: T): Partial<T> =>
    Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;
  const split = (key: keyof RucksackOptions) => {
    const value = pick(key);
    return value === undefined ? undefined : value.split(",");
  };
  // Attributes are strings; parse the flags here so the caller gets the same
  // types it would have got from `Rucksack({...})`.
  const flag = (key: keyof RucksackOptions) => {
    const value = pick(key);
    if (value === undefined) return undefined;
    return value.trim().toLowerCase() !== "false" && value.trim() !== "0";
  };

  const languages = pick("languages");
  const maxNameLength = pick("maxNameLength");

  return present({
    storageKey: pick("storageKey"),
    title: pick("title"),
    icon: pick("icon"),
    className: pick("className"),
    languages:
      languages === undefined
        ? undefined
        : languages.trim() === "*"
          ? "*"
          : languages.split(","),
    excludeLanguages: split("excludeLanguages"),
    removeFromDom: flag("removeFromDom"),
    merge: flag("merge"),
    parseDetails: flag("parseDetails"),
    nameAttribute: pick("nameAttribute"),
    maxNameLength: maxNameLength === undefined ? undefined : Number(maxNameLength),
    sound: flag("sound"),
    logEvents: flag("logEvents"),
    stashLabel: pick("stashLabel"),
    stashedLabel: pick("stashedLabel"),
  });
}
