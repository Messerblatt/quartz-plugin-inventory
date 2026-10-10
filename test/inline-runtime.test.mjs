/**
 * Smoke test for the browser runtime, using the real rehype-pretty-code markup
 * (```item fence -> figure > pre[data-language=item] > code[data-language=item]).
 *
 * Runs the built inline bundle inside jsdom, against fake-indexeddb (the runtime
 * persists with Dexie) and jsdom's localStorage shim.
 */
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

// Import the built plugin and take the exact strings the component registers
// as `css` / `afterDOMLoaded` - i.e. what Quartz itself would inject.
const { Inventory } = await import("../dist/components/index.js");
const Component = Inventory({});
const code = Component.afterDOMLoaded;

const itemFigure = (name, lang = "item") => `
  <figure data-rehype-pretty-code-figure="">
    <pre tabindex="0" data-language="${lang}" data-theme="github-light github-dark">
      <button class="clipboard-button" type="button" aria-label="Copy source">x</button>
      <code data-language="${lang}" data-theme="github-light github-dark" style="display:grid;">
        <span data-line=""> </span>
        ${name
          .split("\n")
          .map((line) => `<span data-line=""><span>${line}</span></span>`)
          .join("\n        ")}
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

const panel = `<aside class="inventory" data-inventory data-inventory-key="quartz:inventory">
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
  </aside>`;

const pageFor = (figures) =>
  `<!doctype html><html><body>
  <div class="page-content">
    ${figures}
  </div>
  ${panel}
</body></html>`;

const page = pageFor(`${itemFigure("Brille")}\n${itemFigure("Taschenlampe")}`);

/** Boot a fresh page: own jsdom window, own IndexedDB, own localStorage. */
function boot(html = page, url = "https://example.com/gear", seed) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const { window } = dom;
  window.indexedDB = new IDBFactory();
  window.IDBKeyRange = IDBKeyRange;
  seed?.(window);
  window.eval(code);
  return dom;
}

// The runtime is async (Dexie) and boots on DOMContentLoaded, which jsdom
// fires asynchronously - give it a few turns to settle.
const settle = async (ms = 60) => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, ms / 5));
};

const dom = boot();
const { window } = dom;
await settle();
const doc = window.document;

const results = [];
const check = (name, cond, extra = "") =>
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);

const click = (el, type = "click") => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true }));
const nameOf = (scope, i = 0) => scope.querySelectorAll(".inventory-name")[i]?.textContent;

// --- Discovery -------------------------------------------------------------

const toggles = doc.querySelectorAll("[data-inventory-item-toggle]");
check("one toggle per item block (no double-count from nested code)", toggles.length === 2, `got ${toggles.length}`);
check("toggle labels carry the item name", [...toggles].every((b) => /\+ Stash/.test(b.textContent)));
check("button injected into the figure", [...toggles].every((b) => b.closest("figure") !== null));
check(
  "item block tagged with anchor",
  [...doc.querySelectorAll("[data-inventory-item]")].map((e) => e.getAttribute("data-inventory-item")).join(",") === "brille,taschenlampe",
);
check("block tagged with its category", doc.querySelector('[data-inventory-item="brille"]').getAttribute("data-inventory-category") === "item");

// --- Stashing --------------------------------------------------------------

click(toggles[0]);
await settle();
check("count badge updated", doc.querySelector("[data-inventory-count]").textContent === "1");
check("toggle flips to stashed", /\u2713 Stashed/.test(toggles[0].textContent));
check("entry rendered in panel", doc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 1);
check("entry text is the item name", nameOf(doc.querySelector("[data-inventory-items]")) === "Brille");
check("entries are plain text, not links", doc.querySelectorAll("[data-inventory-items] a").length === 0);
check("empty hint hidden", doc.querySelector("[data-inventory-empty]").hasAttribute("hidden") === true);
check("default quantity shown", doc.querySelector("[data-inventory-items] .inventory-quantity").textContent === "\u00d71");
check("stashed block hidden", doc.querySelector('[data-inventory-item="brille"]').classList.contains("is-stashed-item"));

// The data must be in IndexedDB now, not localStorage.
const stored = await new Promise((resolve, reject) => {
  const req = window.indexedDB.open("quartz:inventory:db");
  req.onsuccess = () => {
    const getAll = req.result.transaction("items").objectStore("items").getAll();
    getAll.onsuccess = () => resolve(getAll.result);
    getAll.onerror = () => reject(getAll.error);
  };
  req.onerror = () => reject(req.error);
});
check("entry stored in IndexedDB", stored.length === 1, JSON.stringify(stored));
check("stored record has name/quantity/location/timestamp",
  stored[0]?.name === "Brille" && stored[0]?.quantity === 1 && stored[0]?.location === "" && typeof stored[0]?.timestamp === "string",
  JSON.stringify(stored[0]));
check("nothing left in localStorage", window.localStorage.getItem("quartz:inventory") === null);

click(toggles[0]);
await settle();
check("unstash removes entry", doc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 0);
check("badge back to 0", doc.querySelector("[data-inventory-count]").textContent === "0");

// --- Panel open state ------------------------------------------------------

click(doc.querySelector("[data-inventory-toggle]"));
await settle();
check("panel opens", doc.querySelector("[data-inventory-panel]").hasAttribute("hidden") === false);
check("open state persisted", window.localStorage.getItem("quartz:inventory:open") === "1");

// --- Stashed text and CSS --------------------------------------------------

click(doc.querySelectorAll("[data-inventory-item-toggle]")[0]);
await settle();
const stashedBlock = doc.querySelector('[data-inventory-item="brille"]');
check("stashed block marked", stashedBlock.classList.contains("is-stashed-item") === true);
check("stashed block keeps its name for remounts", stashedBlock.getAttribute("data-inventory-item-title") === "Brille");
check("css hides the text of a stashed block", /\.is-stashed-item[^{]*span\[data-line\][^{]*\{[^}]*display:\s*none/.test(Component.css));
check("css drops only blank lines (keeps a one-liner name)", /\.is-blank-line[^{]*\{[^}]*display:\s*none/.test(Component.css) && !/span\[data-line\]:last-child[^{]*\{\s*display:\s*none/.test(Component.css));

// --- Client-side navigation ------------------------------------------------

doc.querySelector(".page-content").innerHTML = itemFigureOneLiner("Diesel");
window.dispatchEvent(new window.Event("popstate"));
await settle();
const remounted = doc.querySelectorAll("[data-inventory-item-toggle]");
check("button remounted after navigation", remounted.length === 1, `got ${remounted.length}`);
check("one-liner title parsed", remounted[0]?.getAttribute("data-inventory-item-toggle") === "gear#diesel");
check("one-liner name line is not blank", !doc.querySelector('[data-inventory-item="diesel"] span[data-line]').classList.contains("is-blank-line"));

window.dispatchEvent(new window.Event("popstate"));
await settle();
check("no duplicate buttons after re-init", doc.querySelectorAll("[data-inventory-item-toggle]").length === 1);

// Stashed entries stay stashed across a re-render.
check("previous stash survives re-init", doc.querySelector("[data-inventory-count]").textContent === "1", doc.querySelector("[data-inventory-count]").textContent);
check("button for the other item is unstashed", /\+ Stash/.test(remounted[0].textContent));

// --- "Show all" modal ------------------------------------------------------

const modal = doc.querySelector("[data-inventory-modal]");
const showAll = doc.querySelector("[data-inventory-show-all]");
check("panel has no clear button", doc.querySelector("[data-inventory-panel] [data-inventory-clear]") === null);
check("'Show all' visible with entries", showAll.hasAttribute("hidden") === false);
check("modal starts closed", modal.hasAttribute("hidden") === true);

click(showAll);
await settle();
check("modal opens", modal.hasAttribute("hidden") === false);
check("scroll locked", doc.documentElement.classList.contains("inventory-modal-open") === true);
check("modal lists all entries", doc.querySelectorAll("[data-inventory-modal-items] .inventory-entry").length === 1);

click(doc.querySelector("[data-inventory-modal-close]"));
check("modal closes via close button", modal.hasAttribute("hidden") === true);
check("scroll unlocked", doc.documentElement.classList.contains("inventory-modal-open") === false);

click(showAll);
await settle();
click(doc.querySelector("[data-inventory-modal-backdrop]"));
check("modal closes via backdrop", modal.hasAttribute("hidden") === true);

click(showAll);
await settle();
click(doc.querySelector(".inventory-modal-content"));
check("modal stays open on inner click", modal.hasAttribute("hidden") === false);
doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("modal closes via Escape", modal.hasAttribute("hidden") === true);

// --- Quantity & location are read-only ------------------------------------

click(remounted[0]); // stash Diesel
await settle();
click(showAll);
await settle();
const dieselRow = () =>
  doc.querySelector('[data-inventory-modal-items] [data-inventory-slug="gear#diesel"]');
check("quantity is read-only text", dieselRow().querySelector(".inventory-quantity").tagName === "SPAN");
check("location is read-only text", dieselRow().querySelector(".inventory-location").tagName === "SPAN");
check("no editable fields anywhere in the modal", doc.querySelectorAll("[data-inventory-modal] input, [data-inventory-modal] textarea").length === 0);
check("no editable fields in the panel", doc.querySelectorAll("[data-inventory-items] input, [data-inventory-items] textarea").length === 0);

const readStored = () =>
  new Promise((resolve, reject) => {
    const req = window.indexedDB.open("quartz:inventory:db");
    req.onsuccess = () => {
      const get = req.result.transaction("items").objectStore("items").get("gear#diesel");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    };
    req.onerror = () => reject(req.error);
  });
const diesel = await readStored();
check("quantity persisted to IndexedDB", diesel?.quantity === 1, JSON.stringify(diesel));
check("location persisted to IndexedDB", diesel?.location === "");
check("entry records its origin block", JSON.stringify(diesel?.origins) === JSON.stringify(["gear#diesel"]), JSON.stringify(diesel?.origins));

// Unstashing drops the record; re-stashing starts from the fence hints again.
click(doc.querySelector('[data-inventory-item-toggle="gear#diesel"]'));
await settle();
check("unstashed record is deleted from IndexedDB", (await readStored()) === undefined);
click(doc.querySelector('[data-inventory-item-toggle="gear#diesel"]'));
await settle();
const restored = await readStored();
check("re-stashing falls back to the fence defaults", restored?.quantity === 1 && restored?.location === "", JSON.stringify(restored));
check("re-stashing records a fresh timestamp", typeof restored?.timestamp === "string" && restored.timestamp !== "");

// --- Identical items merge into one row -----------------------------------

const dupDom = boot(pageFor(`${itemFigure("health")}\n${itemFigure("health")}`), "https://example.com/gear");
await settle();
const dDoc = dupDom.window.document;
const dupToggles = dDoc.querySelectorAll("[data-inventory-item-toggle]");
check("both 'health' blocks get a button", dupToggles.length === 2, `${dupToggles.length}`);
click(dupToggles[0]);
await settle();
check("first stash adds one row", dDoc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 1);
click(dupToggles[1]);
await settle();
check("second identical stash does not add a row", dDoc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 1, `${dDoc.querySelectorAll("[data-inventory-items] .inventory-entry").length}`);
check("identical stash raises the quantity", dDoc.querySelector("[data-inventory-items] .inventory-quantity").textContent === "\u00d72", dDoc.querySelector("[data-inventory-items] .inventory-quantity").textContent);
check("both blocks are marked as stashed", [...dupToggles].every((b) => /\u2713 Stashed/.test(b.textContent)));
check("both blocks hide their text", dDoc.querySelectorAll(".inventory-item-block.is-stashed-item").length === 2);

const dupRows = await new Promise((resolve, reject) => {
  const req = dupDom.window.indexedDB.open("quartz:inventory:db");
  req.onsuccess = () => {
    const get = req.result.transaction("items").objectStore("items").getAll();
    get.onsuccess = () => resolve(get.result);
    get.onerror = () => reject(get.error);
  };
  req.onerror = () => reject(req.error);
});
check("only one record is stored", dupRows.length === 1, `${dupRows.length}`);
check("merged record keeps both origins", JSON.stringify(dupRows[0].origins) === JSON.stringify(["gear#health", "gear#health-1"]), JSON.stringify(dupRows[0].origins));

// Taking one of them back out only removes what it contributed.
click(dupToggles[1]);
await settle();
check("unstashing one copy keeps the row", dDoc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 1);
check("unstashing one copy lowers the quantity", dDoc.querySelector("[data-inventory-items] .inventory-quantity").textContent === "\u00d71", dDoc.querySelector("[data-inventory-items] .inventory-quantity").textContent);
check("the other block stays stashed", /\u2713 Stashed/.test(dupToggles[0].textContent));
click(dupToggles[0]);
await settle();
check("unstashing the last copy removes the row", dDoc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 0);

// Fenced quantities add up when identical items merge.
const mergeDom = boot(pageFor(`${itemFigure("rope\nx3")}\n${itemFigure("rope\nx2")}`), "https://example.com/gear");
await settle();
const mDoc = mergeDom.window.document;
[...mDoc.querySelectorAll("[data-inventory-item-toggle]")].forEach((b) => click(b));
await settle();
check("fenced quantities are summed on merge", mDoc.querySelector("[data-inventory-items] .inventory-quantity").textContent === "\u00d75", mDoc.querySelector("[data-inventory-items] .inventory-quantity").textContent);
check("merged rows keep a single line", mDoc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 1);

// --- Quantity/location hints in the fence ----------------------------------

const hintsDom = boot(
  pageFor(`${itemFigure("Diesel\nx3\nLocation: Cellar, shelf 2")}\n${itemFigure("Big Ben", "secret")}`),
  "https://example.com/gear",
);
await settle();
const hDoc = hintsDom.window.document;
check("every category gets a button", hDoc.querySelectorAll("[data-inventory-item-toggle]").length === 2);
[...hDoc.querySelectorAll("[data-inventory-item-toggle]")].forEach((b) => click(b));
await settle();
const rows = [...hDoc.querySelectorAll("[data-inventory-items] .inventory-entry")];
const dieselEntry = rows.find((r) => r.getAttribute("data-inventory-slug") === "gear#diesel");
const benRow = rows.find((r) => r.getAttribute("data-inventory-slug") === "gear#big-ben");
check("quantity read from the fence", dieselEntry.querySelector(".inventory-quantity").textContent === "\u00d73", dieselEntry.querySelector(".inventory-quantity").textContent);
check("location read from the fence", dieselEntry.querySelector(".inventory-location").textContent === "Cellar, shelf 2");
check("item without hints falls back to x1", benRow.querySelector(".inventory-quantity").textContent === "\u00d71");
check("entries show their category", rows.map((r) => r.querySelector(".inventory-tag").textContent).sort().join(",") === "item,secret");

// --- Long names ------------------------------------------------------------

const LONG =
  "Lorem Ipsum ladada blablaba domi con fore concordia london big ben dollar michaelangelo";
const longDom = boot(pageFor(itemFigure(LONG)), "https://example.com/gear");
await settle();
const lDoc = longDom.window.document;
click(lDoc.querySelector("[data-inventory-item-toggle]"));
await settle();
const lName = lDoc.querySelector("[data-inventory-items] .inventory-name");
check("long title is elided in the preview (20 chars + ...)", lName.textContent === "Lorem Ipsum ladada b...", lName.textContent);
check("full title kept on hover/assistive tech", lName.getAttribute("title") === LONG);
const longStored = await new Promise((resolve, reject) => {
  const req = longDom.window.indexedDB.open("quartz:inventory:db");
  req.onsuccess = () => {
    const get = req.result.transaction("items").objectStore("items").getAll();
    get.onsuccess = () => resolve(get.result[0]);
    get.onerror = () => reject(get.error);
  };
  req.onerror = () => reject(req.error);
});
check("full title stored, not truncated", longStored?.name === LONG);

// --- Nested / trailing-slash page paths -----------------------------------

const pathDom = boot(page, "https://example.com/notes/gear/");
await settle();
click(pathDom.window.document.querySelector("[data-inventory-item-toggle]"));
await settle();
const pathEntry = await new Promise((resolve, reject) => {
  const req = pathDom.window.indexedDB.open("quartz:inventory:db");
  req.onsuccess = () => {
    const get = req.result.transaction("items").objectStore("items").getAll();
    get.onsuccess = () => resolve(get.result[0]);
    get.onerror = () => reject(get.error);
  };
  req.onerror = () => reject(req.error);
});
check("nested/trailing-slash page recorded verbatim", pathEntry?.page === "notes/gear/", pathEntry?.page);
check("slug includes the full page path", pathEntry?.slug === "notes/gear/#brille", pathEntry?.slug);

const idxDom = boot(page, "https://example.com/");
await settle();
click(idxDom.window.document.querySelector("[data-inventory-item-toggle]"));
await settle();
const idxEntry = await new Promise((resolve, reject) => {
  const req = idxDom.window.indexedDB.open("quartz:inventory:db");
  req.onsuccess = () => {
    const get = req.result.transaction("items").objectStore("items").getAll();
    get.onsuccess = () => resolve(get.result[0]);
    get.onerror = () => reject(get.error);
  };
  req.onerror = () => reject(req.error);
});
check("index page recorded as index", idxEntry?.page === "index", idxEntry?.page);

// --- Persistence request ---------------------------------------------------

check("persistent storage requested", doc.documentElement.getAttribute("data-inventory-persisted") !== null, doc.documentElement.getAttribute("data-inventory-persisted"));

// --- Removing / clearing ---------------------------------------------------

click(doc.querySelector('[data-inventory-items] [data-inventory-slug="gear#brille"] .inventory-remove'));
await settle();
check("remove syncs panel list", doc.querySelectorAll("[data-inventory-items] .inventory-entry").length === 1);
check("badge follows removal", doc.querySelector("[data-inventory-count]").textContent === "1");

click(doc.querySelector("[data-inventory-show-all]"));
await settle();
click(doc.querySelector("[data-inventory-modal] [data-inventory-clear]"));
await settle();
const remaining = await new Promise((resolve, reject) => {
  const req = window.indexedDB.open("quartz:inventory:db");
  req.onsuccess = () => {
    const get = req.result.transaction("items").objectStore("items").getAll();
    get.onsuccess = () => resolve(get.result.length);
    get.onerror = () => reject(get.error);
  };
  req.onerror = () => reject(req.error);
});
check("clear empties IndexedDB", remaining === 0, `${remaining}`);
check("clear closes the modal", modal.hasAttribute("hidden") === true);
check("'Show all' hidden when empty", showAll.hasAttribute("hidden") === true);

// --- Legacy migration ------------------------------------------------------

const LEGACY_PAYLOAD = JSON.stringify([
  { slug: "gear#old", title: "Old Item", addedAt: "2018-02-02T00:00:00.000Z", page: "gear", anchor: "old" },
]);
const legacyDom = boot(page, "https://example.com/gear", (window) => {
  // A pre-IndexedDB inventory, present before the runtime boots.
  window.localStorage.setItem("quartz:inventory", LEGACY_PAYLOAD);
});
await settle(120);
const legacyRows = legacyDom.window.document.querySelectorAll("[data-inventory-items] .inventory-entry");
check("legacy localStorage inventory is migrated on load", legacyRows.length === 1, `${legacyRows.length}`);
check("migrated entry is normalised", nameOf(legacyDom.window.document.querySelector("[data-inventory-items]")) === "Old Item" && legacyDom.window.document.querySelector("[data-inventory-items] .inventory-quantity").textContent === "\u00d71");
check("legacy localStorage key is removed", legacyDom.window.localStorage.getItem("quartz:inventory") === null);

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);