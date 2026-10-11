/**
 * One simple smoke test for the inventory runtime and storage layer.
 *
 * Boots the built inline bundle in jsdom against fake-indexeddb and checks the
 * things that matter: buttons mount, stashing stores the item in IndexedDB,
 * repeated names on one page stay separate items while the same name merges
 * across pages, and the panel renders read-only metadata.
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
check("the stashed block is hidden", doc.querySelectorAll(".inventory-item-block.is-stashed-item").length === 1, `${doc.querySelectorAll(".inventory-item-block.is-stashed-item").length}`);
check("the stashed button reads as stashed", buttons[0].textContent === "\u2713 Stashed" && buttons[0].getAttribute("aria-pressed") === "true", buttons[0].textContent);
check(
  "stashing one block leaves the identically named sibling unstashed",
  doc.querySelectorAll(".inventory-item-block.is-stashed-item").length === 1,
  `${doc.querySelectorAll(".inventory-item-block.is-stashed-item").length}`,
);
check(
  "the sibling's button still offers to stash",
  buttons[1].textContent === "+ Stash" && buttons[1].getAttribute("aria-pressed") === "false",
  buttons[1].textContent,
);
check("the sibling's block is still readable", doc.querySelectorAll(".is-stashed-item").length === 1, `${doc.querySelectorAll(".is-stashed-item").length}`);

click(buttons[1]);
await settle(() => rows().length === 2);
check("stashing the sibling adds a second row", rows().length === 2, `got ${rows().length}`);
check("both blocks are now hidden", doc.querySelectorAll(".inventory-item-block.is-stashed-item").length === 2, `${doc.querySelectorAll(".inventory-item-block.is-stashed-item").length}`);

const db = await stored();
check("one record per block is stored in IndexedDB", db.length === 2, `${db.length}`);
check(
  "the two records share a name but not an anchor",
  db[0]?.name === "health" && db[1]?.name === "health" && db[0]?.anchor !== db[1]?.anchor,
  JSON.stringify(db.map((e) => [e.name, e.anchor, e.slug])),
);
check("each record keeps quantity, location and timestamp", db.every((e) => e.quantity === 1 && e.location === "" && typeof e.timestamp === "string"), JSON.stringify(db));
check("metadata is read-only", doc.querySelectorAll("[data-inventory-items] input, [data-inventory-items] textarea").length === 0);
check("the count badge counts rows, not items", doc.querySelector("[data-inventory-count]").textContent === "2");

// Cross-page merging is a pure rule in the model, so check it there.
const { findMergeTarget, isBlockCarried } = await import("../dist/index.js");

const elsewhere = db.map((e) => ({ ...e, page: "locations" }));
check(
  "the same item carried from another page is a merge target",
  findMergeTarget(elsewhere, "characters", "health") !== undefined,
);
check(
  "a block on the carrying page is not its own merge target",
  findMergeTarget(elsewhere, "locations", "health") === undefined,
);
check(
  "each stashed block reads as carried",
  elsewhere.every((e) => isBlockCarried(elsewhere, e.slug)),
);
check(
  "a third, identical block on the same page is not carried",
  isBlockCarried(elsewhere, "characters#health-2") === false,
);
const onAnotherPage = [{ ...db[0], page: "locations", slug: "locations#health", anchor: "health" }];
check(
  "carrying the same item on another page does not light up this page's blocks",
  isBlockCarried(onAnotherPage, "characters#health") === false &&
    isBlockCarried(onAnotherPage, "characters#health-1") === false,
);
check("the modal sits above the Quartz sidebar", /z-index:\s*9{3,}/.test(Component.css));

console.log(checks.join("\n"));
process.exit(checks.some((c) => c.startsWith("FAIL")) ? 1 : 0);