/**
 * Browser runtime for the Inventory component.
 *
 * Runs after DOMContentLoaded inside a <script> tag (bundled to a plain string by
 * the inline-script-loader), so it must be dependency-free and side-effect driven.
 *
 * Storage layout (localStorage):
 *   quartz:inventory -> InventoryEntry[] = { slug, title, addedAt, tags?, excerpt? }
 *   quartz:inventory:open -> "1" | "0"  (panel open/closed state)
 */

const STORAGE_KEY_FALLBACK = "quartz:inventory";
const OPEN_KEY_SUFFIX = ":open";

interface Entry {
  slug: string;
  title: string;
  addedAt: string;
  tags?: string[];
  excerpt?: string;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled (private mode / quota) - fail silently */
  }
}

function parse(raw: string | null): Entry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Entry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as Entry).slug === "string" &&
        typeof (e as Entry).title === "string" &&
        typeof (e as Entry).addedAt === "string",
    );
  } catch {
    return [];
  }
}

function newestFirst(entries: Entry[]): Entry[] {
  return entries.slice().sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/** Derive the note slug from the current location, without leading/trailing slash. */
function currentSlug(): string {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "index";
  // Quartz slugifies non-ASCII, so decode to get the original filename back
  return decodeURIComponent(parts[parts.length - 1] ?? "index");
}

function pageTitle(slug: string): string {
  const el = document.querySelector("h1");
  const text = el?.textContent?.trim();
  if (text) return text;
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => (w[0] ?? "").toUpperCase() + w.slice(1))
    .join(" ");
}

function pageTags(): string[] | undefined {
  const tags = Array.from(
    document.querySelectorAll<HTMLElement>(".page-tags .tag, .tags a.tag"),
  )
    .map((el) => el.textContent?.trim() ?? "")
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function pageExcerpt(): string | undefined {
  const el = document.querySelector<HTMLElement>(".page-content p, article p");
  const text = el?.textContent?.trim();
  if (!text) return undefined;
  return text.length > 180 ? text.slice(0, 180) + "\u2026" : text;
}

function setBadge(root: HTMLElement, count: number): void {
  const badge = root.querySelector<HTMLElement>("[data-inventory-count]");
  if (badge) badge.textContent = String(count);
}

function render(root: HTMLElement, entries: Entry[]): void {
  const list = root.querySelector<HTMLElement>("[data-inventory-items]");
  const empty = root.querySelector<HTMLElement>("[data-inventory-empty]");
  const clear = root.querySelector<HTMLElement>("[data-inventory-clear]");
  const toggle = root.querySelector<HTMLElement>("[data-inventory-toggle]");
  const panel = root.querySelector<HTMLElement>("[data-inventory-panel]");

  setBadge(root, entries.length);

  if (toggle) {
    toggle.setAttribute("aria-expanded", String(panel ? !panel.hasAttribute("hidden") : false));
  }

  if (empty) empty.toggleAttribute("hidden", entries.length > 0);
  if (clear) clear.toggleAttribute("hidden", entries.length === 0);
  if (!list) return;

  list.textContent = "";

  const slug = currentSlug();
  for (const entry of newestFirst(entries)) {
    const li = document.createElement("li");
    li.className = "inventory-item";
    li.setAttribute("data-inventory-slug", entry.slug);
    if (entry.slug === slug) li.classList.add("is-current");

    const link = document.createElement("a");
    link.className = "inventory-link";
    link.href = entry.slug === "index" ? "/" : `/${entry.slug}`;
    link.textContent = entry.title;

    const meta = document.createElement("span");
    meta.className = "inventory-meta";
    meta.textContent = new Date(entry.addedAt).toLocaleDateString();

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "inventory-remove";
    remove.setAttribute("data-inventory-remove", entry.slug);
    remove.setAttribute("aria-label", `Remove ${entry.title} from inventory`);
    remove.textContent = "\u00d7";

    li.append(link, meta, remove);
    list.append(li);
  }
}

/** Inject a stash button into the article header of the current note. */
function mountStashButton(root: HTMLElement, storageKey: string): void {
  const slug = currentSlug();
  const content = document.querySelector<HTMLElement>(".page-content, article");
  if (!content) return;
  if (document.querySelector("[data-inventory-stash]")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "inventory-stash";
  button.setAttribute("data-inventory-stash", slug);

  const syncLabel = (entries: Entry[]) => {
    const stashed = entries.some((e) => e.slug === slug);
    button.textContent = stashed ? "\u2713 Stashed" : "+ Stash";
    button.setAttribute("aria-pressed", String(stashed));
    button.classList.toggle("is-stashed", stashed);
  };

  syncLabel(parse(read(storageKey)));

  button.addEventListener("click", () => {
    const entries = parse(read(storageKey));
    const tags = pageTags();
    const excerpt = pageExcerpt();
    const entry: Entry = {
      slug,
      title: pageTitle(slug),
      addedAt: new Date().toISOString(),
    };
    if (tags) entry.tags = tags;
    if (excerpt) entry.excerpt = excerpt;

    const stashed = entries.some((e) => e.slug === slug);
    const next = stashed
      ? entries.filter((e) => e.slug !== slug)
      : newestFirst([entry, ...entries.filter((e) => e.slug !== slug)]);

    write(storageKey, JSON.stringify(next, null, 2));
    syncLabel(next);
    render(root, next);
  });

  content.prepend(button);
}

function init(): void {
  const roots = document.querySelectorAll<HTMLElement>("[data-inventory]");
  for (const root of roots) {
    const storageKey = root.getAttribute("data-inventory-key") ?? STORAGE_KEY_FALLBACK;
    const openKey = storageKey + OPEN_KEY_SUFFIX;

    let entries = parse(read(storageKey));
    const panel = root.querySelector<HTMLElement>("[data-inventory-panel]");

    const setOpen = (open: boolean) => {
      if (panel) panel.toggleAttribute("hidden", !open);
      const toggle = root.querySelector<HTMLElement>("[data-inventory-toggle]");
      toggle?.setAttribute("aria-expanded", String(open));
      write(openKey, open ? "1" : "0");
    };

    root
      .querySelector<HTMLElement>("[data-inventory-toggle]")
      ?.addEventListener("click", () => {
        setOpen(panel ? panel.hasAttribute("hidden") : true);
      });

    root
      .querySelector<HTMLElement>("[data-inventory-clear]")
      ?.addEventListener("click", () => {
        entries = [];
        write(storageKey, JSON.stringify(entries));
        render(root, entries);
      });

    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const slug = target?.getAttribute?.("data-inventory-remove");
      if (!slug) return;
      event.preventDefault();
      entries = entries.filter((e) => e.slug !== slug);
      write(storageKey, JSON.stringify(entries, null, 2));
      render(root, entries);
    });

    if (read(openKey) === "1") setOpen(true);

    render(root, entries);
    mountStashButton(root, storageKey);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
