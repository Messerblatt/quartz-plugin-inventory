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
      <button type="button" data-inventory-clear hidden>Clear</button>
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
check("entry rendered in panel", doc.querySelectorAll("[data-inventory-entry], .inventory-entry").length === 1);
check("link points back to anchor", doc.querySelector(".inventory-link").getAttribute("href") === "/gear#brille", doc.querySelector(".inventory-link")?.getAttribute("href"));
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

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
