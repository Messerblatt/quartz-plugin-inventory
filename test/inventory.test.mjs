/**
 * One simple smoke test for the inventory runtime and storage layer.
 *
 * Boots the built inline bundle in jsdom against fake-indexeddb and checks the
 * things that matter: buttons mount, stashing stores the item in IndexedDB,
 * identical item names merge, and the panel renders read-only metadata.
 */
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

const { Inventory } = await import("../dist/components/index.js");
const Component = Inventory({});
const code = Component.afterDOMLoaded;

const figure = (name, lang = "item") => `
  <figure data-rehype-pretty-code-figure="">
    <pre data-language="${lang}">
      <code data-language="${lang}">
        <span data-line=""><span>${name}</span></span>
      </code>
    </pre>
  </figure>`;

const html = `<!doctype html><html><body>
  <div class="page-content">${figure("health")}${figure("health")}</div>
  <aside class="inventory" data-inventory data-inventory-key="quartz:inventory">
    <button data-inventory-toggle><span data-inventory-count>0</span></button>
    <div data-inventory-panel>
      <p data-inventory-empty></p>
      <ul data-inventory-items></ul>
      <button data-inventory-show-all>Show all</button>
    </div>
  </aside>
</body></html>`;

const dom = new JSDOM(html, { url: "https://wolke7000.com/characters", runScripts: "outside-only" });
const { window } = dom;
window.indexedDB = new IDBFactory();
window.IDBKeyRange = IDBKeyRange;
window.eval(code);

// The runtime boots on DOMContentLoaded and talks to IndexedDB, so give it a
// few turns rather than a fixed sleep.
const settle = async (predicate = () => true) => {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};
const doc = window.document;
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const rows = () => doc.querySelectorAll("[data-inventory-items] .inventory-entry");
const stored = () =>
  new Promise((resolve, reject) => {
    const req = window.indexedDB.open("quartz:inventory:db");
    req.onsuccess = () => {
      const all = req.result.transaction("items").objectStore("items").getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  });

await settle(() => doc.querySelectorAll("[data-inventory-item-toggle]").length === 2);

const checks = [];
const check = (name, cond, extra = "") => checks.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);

const buttons = doc.querySelectorAll("[data-inventory-item-toggle]");
check("a stash button is mounted for every item block", buttons.length === 2, `got ${buttons.length}`);

click(buttons[0]);
await settle(() => rows().length === 1);
check("stashing adds one row with its metadata", rows().length === 1 && rows()[0].querySelector(".inventory-quantity").textContent === "\u00d71");
check("blocks showing a carried item are hidden", doc.querySelectorAll(".inventory-item-block.is-stashed-item").length === 2, `${doc.querySelectorAll(".inventory-item-block.is-stashed-item").length}`);

click(buttons[1]);
await settle(() => rows()[0]?.querySelector(".inventory-quantity").textContent === "\u00d72");
check("the same item name merges into the existing row", rows().length === 1, `got ${rows().length}`);
check("merging raises the quantity", rows()[0].querySelector(".inventory-quantity").textContent === "\u00d72", rows()[0]?.querySelector(".inventory-quantity").textContent);

const db = await stored();
check("one record is stored in IndexedDB", db.length === 1, `${db.length}`);
check("the record keeps name, quantity, location and timestamp", db[0]?.name === "health" && db[0]?.quantity === 2 && db[0]?.location === "" && typeof db[0]?.timestamp === "string", JSON.stringify(db[0]));
check("metadata is read-only", doc.querySelectorAll("[data-inventory-items] input, [data-inventory-items] textarea").length === 0);
check("the count badge counts rows, not items", doc.querySelector("[data-inventory-count]").textContent === "1");
check("the modal sits above the Quartz sidebar", /z-index:\s*9{3,}/.test(Component.css));

console.log(checks.join("\n"));
process.exit(checks.some((c) => c.startsWith("FAIL")) ? 1 : 0);