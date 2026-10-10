/**
 * Smoke test for the browser runtime, using the real rehype-pretty-code markup
 * (```item fence -> figure > pre[data-language=item] > code[data-language=item]).
 *
 * Runs the built inline bundle inside jsdom against a localStorage shim.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
// Import the built plugin and take the exact strings the component registers
// as `css` / `afterDOMLoaded` - i.e. what Quartz itself would inject.
const { Inventory } = await import("../dist/components/index.js");
const Component = Inventory({});
const code = Component.afterDOMLoaded;

const itemFigure = (name) => `
  <figure data-rehype-pretty-code-figure="">
    <pre tabindex="0" data-language="item" data-theme="github-light github-dark">
      <button class="clipboard-button" type="button" aria-label="Copy source">x</button>
      <code data-language="item" data-theme="github-light github-dark" style="display:grid;">
        <span data-line=""> </span>
        <span data-line=""><span>${name}</span></span>
        <span data-line=""> </span>
      </code>
    </pre>
  </figure>`;

// A fence written without a trailing newline: rehype-pretty-code emits a
// single `span[data-line]`, which a naive `:last-child` rule would hide.
const itemFigureOneLiner = (name) => `
  <figure data-rehype-pretty-code-figure="">
    <pre tabindex="0" data-language="item">
      <code data-language="item" style="display:grid;">
        <span data-line=""><span>${name}</span></span>
      </code>
    </pre>
  </figure>`;

const page = `<!doctype html><html><body>
  <div class="page-content">
    ${itemFigure("Brille")}
    ${itemFigure("Taschenlampe")}
  </div>
  <aside class="inventory" data-inventory data-inventory-key="quartz:inventory">
    <button type="button" data-inventory-toggle><span data-inventory-count>0</span></button>
    <div data-inventory-panel hidden>
      <p data-inventory-empty>empty</p>
      <ul data-inventory-items></ul>
      <button type="button" data-inventory-show-all hidden>Show all</button>
    </div>
    <div class="inventory-modal" data-inventory-modal hidden>
      <div data-inventory-modal-backdrop></div>
      <div class="inventory-modal-content" role="dialog" aria-modal="true" tabindex="-1">
        <button type="button" data-inventory-modal-close>x</button>
        <ul data-inventory-modal-items></ul>
        <button type="button" data-inventory-clear hidden>Clear</button>
      </div>
    </div>
  </aside>
</body></html>`;

const dom = new JSDOM(page, { url: "https://example.com/gear", runScripts: "outside-only" });
const { window } = dom;
const store = window.localStorage;

window.eval(code);
// jsdom keeps readyState "loading" while the script runs; let it fire
// DOMContentLoaded so the runtime's bootstrap runs.
await new Promise((r) => setTimeout(r, 0));

const doc = window.document;
const results = [];
const check = (name, cond, extra = "") =>
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);

// Nested <code> must not be double-counted: 2 figures -> 2 toggles.
const toggles = doc.querySelectorAll("[data-inventory-item-toggle]");
check("one toggle per item block (no double-count from nested code)", toggles.length === 2, `got ${toggles.length}`);
check("toggle labels carry the item name", [...toggles].every((b) => /\+ Stash/.test(b.textContent)), [...toggles].map((b) => b.textContent).join(","));
check("button injected into the figure", [...toggles].every((b) => b.closest("figure") !== null));
check("item block tagged with anchor", [...doc.querySelectorAll('[data-inventory-item]')].map((e) => e.getAttribute("data-inventory-item")).join(",") === "brille,taschenlampe", [...doc.querySelectorAll('[data-inventory-item]')].map((e) => e.getAttribute("data-inventory-item")).join(","));

// Stash the first item.
toggles[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const stored = JSON.parse(store.getItem("quartz:inventory") ?? "[]");
check("stashed one entry", stored.length === 1, JSON.stringify(stored));
check("entry slug is page#anchor", stored[0]?.slug === "gear#brille", stored[0]?.slug);
check("entry title parsed from fence text", stored[0]?.title === "Brille", stored[0]?.title);
check("entry page recorded", stored[0]?.page === "gear", stored[0]?.page);
check("count badge updated", doc.querySelector("[data-inventory-count]").textContent === "1", doc.querySelector("[data-inventory-count]").textContent);
check("toggle flips to stashed", /\u2713 Stashed/.test(doc.querySelectorAll("[data-inventory-item-toggle]")[0].textContent));
check("entry rendered in panel", doc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 1, `${doc.querySelectorAll("[data-inventory-items] .inventory-entry").length}`);
check("entry text is the item name", doc.querySelector("[data-inventory-items] .inventory-name").textContent === "Brille", doc.querySelector("[data-inventory-items] .inventory-name").textContent);
check("empty hint hidden", doc.querySelector("[data-inventory-empty]").hasAttribute("hidden") === true);

// Toggle the same item again -> unstash.
doc.querySelectorAll("[data-inventory-item-toggle]")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("unstash removes entry", JSON.parse(store.getItem("quartz:inventory")).length === 0);
check("badge back to 0", doc.querySelector("[data-inventory-count]").textContent === "0");

// Panel toggle persists open state.
doc.querySelector("[data-inventory-toggle]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("panel opens", doc.querySelector("[data-inventory-panel]").hasAttribute("hidden") === false);
check("open state persisted", store.getItem("quartz:inventory:open") === "1");

// Stashing hides the item text but keeps the block (and its anchor).
doc.querySelectorAll("[data-inventory-item-toggle]")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const stashedBlock = doc.querySelector('[data-inventory-item="brille"]');
check("stashed block marked", stashedBlock.classList.contains("is-stashed-item") === true);
check(
  "css hides the text of a stashed block",
  /\.is-stashed-item[^{]*span\[data-line\][^{]*\{[^}]*display:\s*none/.test(Component.css),
);
check(
  "css drops only blank lines (keeps a one-liner name)",
  /\.is-blank-line[^{]*\{[^}]*display:\s*none/.test(Component.css) &&
    !/span\[data-line\]:last-child[^{]*\{\s*display:\s*none/.test(Component.css),
);
check("stashed block keeps its title attribute for remounts", stashedBlock.getAttribute("data-inventory-item-title") === "Brille");

// Client-side navigation swaps the content: buttons must come back on their own.
const content = doc.querySelector(".page-content");
content.innerHTML = itemFigureOneLiner("Diesel");
window.dispatchEvent(new window.Event("popstate"));
await new Promise((r) => setTimeout(r, 20));
const remounted = doc.querySelectorAll("[data-inventory-item-toggle]");
check("button remounted after navigation", remounted.length === 1, `got ${remounted.length}`);
check("one-liner title parsed", remounted[0]?.getAttribute("data-inventory-item-toggle") === "gear#diesel", remounted[0]?.getAttribute("data-inventory-item-toggle"));
const oneLiner = doc.querySelector('[data-inventory-item="diesel"]');
check("one-liner name line is not blank", !oneLiner.querySelector("span[data-line]").classList.contains("is-blank-line"));

// Re-running init must not duplicate buttons or double-bind handlers.
window.dispatchEvent(new window.Event("popstate"));
await new Promise((r) => setTimeout(r, 20));
check("no duplicate buttons after re-init", doc.querySelectorAll("[data-inventory-item-toggle]").length === 1);
remounted[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("single toggle adds exactly one entry", JSON.parse(store.getItem("quartz:inventory")).length === 2, JSON.stringify(JSON.parse(store.getItem("quartz:inventory"))));

// --- "Show all" modal -----------------------------------------------------
const modal = doc.querySelector("[data-inventory-modal]");
const showAll = doc.querySelector("[data-inventory-show-all]");
check("panel has no clear button", doc.querySelector("[data-inventory-panel] [data-inventory-clear]") === null);
check("'Show all' visible with entries", showAll.hasAttribute("hidden") === false);
check("modal starts closed", modal.hasAttribute("hidden") === true);

showAll.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("modal opens", modal.hasAttribute("hidden") === false);
check("scroll locked", doc.documentElement.classList.contains("inventory-modal-open") === true);
check("modal lists all entries", doc.querySelectorAll("[data-inventory-modal-items] .inventory-entry").length === 2, `${doc.querySelectorAll("[data-inventory-modal-items] .inventory-entry").length}`);

doc.querySelector("[data-inventory-modal-close]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("modal closes via close button", modal.hasAttribute("hidden") === true);
check("scroll unlocked", doc.documentElement.classList.contains("inventory-modal-open") === false);

showAll.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
doc.querySelector("[data-inventory-modal-backdrop]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("modal closes via backdrop", modal.hasAttribute("hidden") === true);

showAll.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
doc.querySelector(".inventory-modal-content").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("modal stays open on inner click", modal.hasAttribute("hidden") === false);
doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("modal closes via Escape", modal.hasAttribute("hidden") === true);

// Removing from the modal updates both lists.
showAll.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
doc.querySelector("[data-inventory-modal-items] .inventory-remove").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("remove in modal syncs panel list", doc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 1);
check("badge follows removal", doc.querySelector("[data-inventory-count]").textContent === "1");
check("'Show all' hidden again when the last entry goes", JSON.parse(store.getItem("quartz:inventory")).length === 1);

// Clearing from inside the modal empties everything and closes it.
doc.querySelector("[data-inventory-modal] [data-inventory-clear]").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("clear empties the inventory", JSON.parse(store.getItem("quartz:inventory")).length === 0);
check("clear closes the modal", modal.hasAttribute("hidden") === true);
check("'Show all' hidden when empty", doc.querySelector("[data-inventory-show-all]").hasAttribute("hidden") === true);

// --- Page paths -----------------------------------------------------------
// Quartz serves both `gear` and `notes/gear/` style URLs; the page must be
// recorded verbatim so the stored slug round-trips.
const urlDom = new JSDOM(page, { url: "https://example.com/notes/gear/", runScripts: "outside-only" });
urlDom.window.eval(code);
await new Promise((r) => setTimeout(r, 0));
const uDoc = urlDom.window.document;
uDoc.querySelectorAll("[data-inventory-item-toggle]")[0].dispatchEvent(new urlDom.window.MouseEvent("click", { bubbles: true }));
check(
  "nested/trailing-slash page recorded verbatim",
  JSON.parse(urlDom.window.localStorage.getItem("quartz:inventory"))[0]?.page === "notes/gear/",
  JSON.parse(urlDom.window.localStorage.getItem("quartz:inventory"))[0]?.page,
);

const idxDom = new JSDOM(page, { url: "https://example.com/", runScripts: "outside-only" });
idxDom.window.eval(code);
await new Promise((r) => setTimeout(r, 0));
idxDom.window.document.querySelectorAll("[data-inventory-item-toggle]")[0].dispatchEvent(new idxDom.window.MouseEvent("click", { bubbles: true }));
check(
  "index page recorded as index",
  JSON.parse(idxDom.window.localStorage.getItem("quartz:inventory"))[0]?.page === "index",
  JSON.parse(idxDom.window.localStorage.getItem("quartz:inventory"))[0]?.page,
);

// --- Plain text entries ---------------------------------------------------
check("entries are plain text, not links", doc.querySelectorAll("[data-inventory-items] a").length === 0);

// --- Categories -----------------------------------------------------------
const longName = "Lorem Ipsum ladada blablaba domi con fore concordia london big ben dollar";
const catDom = new JSDOM(
  page
    .replace(/<figure[\s\S]*?<\/figure>/g, "")
    .replace(
      '<div class="page-content">',
      `<div class="page-content">
        <figure><pre data-language="item"><code data-language="item"><span data-line><span>${longName}</span></span></code></pre></figure>
        <figure><pre data-language="secret"><code data-language="secret"><span data-line><span>Hidden Vault</span></span></code></pre></figure>`,
    ),
  { url: "https://example.com/gear", runScripts: "outside-only" },
);
catDom.window.eval(code);
await new Promise((r) => setTimeout(r, 0));
const cDoc = catDom.window.document;
const catToggles = cDoc.querySelectorAll("[data-inventory-item-toggle]");
check("blocks of every known category get a button", catToggles.length === 2, `${catToggles.length}`);
[...catToggles].forEach((b) => b.dispatchEvent(new catDom.window.MouseEvent("click", { bubbles: true })));
const catEntries = JSON.parse(catDom.window.localStorage.getItem("quartz:inventory"));
check("item fence stored as category 'item'", catEntries.find((e) => e.title === longName)?.category === "item", JSON.stringify(catEntries.map((e) => [e.title, e.category])));
check("secret fence stored as category 'secret'", catEntries.find((e) => e.title === "Hidden Vault")?.category === "secret", JSON.stringify(catEntries.map((e) => [e.title, e.category])));
check("full title stored, not truncated", catEntries.find((e) => e.title === longName)?.title === longName);
const cNames = [...cDoc.querySelectorAll("[data-inventory-items] .inventory-name")];
const cLong = cNames.find((n) => n.getAttribute("title") === longName);
check("long title is elided in the preview (20 chars + ...)", cLong?.textContent === "Lorem Ipsum ladada b...", cLong?.textContent);
check("short titles are not elided", [...cDoc.querySelectorAll("[data-inventory-items] .inventory-name")].some((n) => n.textContent === "Hidden Vault"));
check("entries show their category", [...cDoc.querySelectorAll("[data-inventory-items] .inventory-tag")].map((t) => t.textContent).sort().join(",") === "item,secret");
check("legacy entries without a category load as 'item'", await (async () => {
  const legacy = new JSDOM(page, { url: "https://example.com/gear", runScripts: "outside-only" });
  legacy.window.localStorage.setItem("quartz:inventory", JSON.stringify([
    { slug: "gear#old", title: "Old Entry", page: "gear", anchor: "old", addedAt: "2020-01-01T00:00:00.000Z" },
  ]));
  legacy.window.eval(code);
  await new Promise((r) => setTimeout(r, 0));
  return legacy.window.document.querySelector(".inventory-tag")?.textContent === "item";
})());

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
