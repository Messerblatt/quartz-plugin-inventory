/**
 * Smoke tests for the Rucksack runtime and storage layer.
 *
 * Boots the built inline bundle in jsdom against fake-indexeddb and checks the
 * things that matter: buttons mount on every fenced block, stashing stores the
 * entry in IndexedDB, repeated names on one page stay separate entries while the
 * same name merges across pages, the panel renders read-only metadata, and
 * `removeFromDom` decides between "block leaves the page" and "block stays put".
 */
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

const { Rucksack } = await import("../dist/components/index.js");

const figure = (name, lang = "item") => `
  <figure data-rehype-pretty-code-figure="">
    <pre${lang === null ? "" : ` data-language="${lang}"`}>
      <code${lang === null ? "" : ` data-language="${lang}"`}>
        <span data-line=""><span>${name}</span></span>
      </code>
    </pre>
  </figure>`;

const panel = (attrs = "") => `
  <aside class="rucksack" data-rucksack ${attrs}>
    <button data-rucksack-toggle><span data-rucksack-count>0</span></button>
    <div data-rucksack-panel>
      <p data-rucksack-empty></p>
      <ul data-rucksack-entries></ul>
      <button data-rucksack-show-all>Show all</button>
    </div>
    <div class="rucksack-modal" data-rucksack-modal hidden>
      <div class="rucksack-modal-content">
        <ul class="rucksack-list" data-rucksack-modal-entries></ul>
    </div>
  </aside>`;

const checks = [];
const check = (name, cond, extra = "") =>
  checks.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);

/**
 * Boot the plugin in a fresh jsdom with the given options and page content.
 * Each scenario gets its own `IDBFactory` so the stores do not leak between them.
 */
function boot({ options = {}, blocks = "", panelAttrs = "", path = "/characters" } = {}) {
  const component = Rucksack(options);
  const scripts = [].concat(component.afterDOMLoaded);

  const html = `<!doctype html><html><body>
    <div class="page-content">${blocks}</div>
    ${panel(panelAttrs)}
  </body></html>`;

  const dom = new JSDOM(html, {
    url: `https://example.com${path}`,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.indexedDB = new IDBFactory();
  window.IDBKeyRange = IDBKeyRange;
  // In order: the inlined config, then the runtime that reads it.
  for (const script of scripts) window.eval(script);

  const doc = window.document;
  const settle = async (predicate = () => true) => {
    for (let i = 0; i < 40; i += 1) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const rows = () => doc.querySelectorAll("[data-rucksack-entries] .rucksack-entry");
  const stored = (key = "quartz:rucksack:db") =>
    new Promise((resolve, reject) => {
      const req = window.indexedDB.open(key);
      req.onsuccess = () => {
        const all = req.result.transaction("entries").objectStore("entries").getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      };
      req.onerror = () => reject(req.error);
    });

  return { component, window, doc, settle, click, rows, stored };
}

// --- Default configuration (removeFromDom: true) --------------------------
{
  const { component, doc, settle, click, rows, stored } = boot({
    blocks: figure("health") + figure("health") + figure("goblin", "event"),
  });

  await settle(() => doc.querySelectorAll("[data-rucksack-toggle-block]").length === 3);

  const buttons = doc.querySelectorAll("[data-rucksack-toggle-block]");
  check("a stash button is mounted for every fenced block", buttons.length === 3, `got ${buttons.length}`);
  check(
    "blocks of any language are stowable, not just `item`",
    doc.querySelectorAll('[data-rucksack-block][data-rucksack-category="event"]').length === 1,
  );
  check(
    "an unstashed block offers to stash",
    buttons[0].textContent === "+ Stash",
    buttons[0].textContent,
  );

  click(buttons[0]);
  await settle(() => rows().length === 1);
  check("stashing adds one row with its metadata", rows().length === 1 && rows()[0].querySelector(".rucksack-quantity").textContent === "\u00d71");
  check(
    "the stashed block leaves the DOM entirely",
    doc.querySelectorAll("figure [data-language]").length === 4,
    `${doc.querySelectorAll("figure [data-language]").length}`,
  );
  check(
    "the stashed block's '+ Stash' button is gone too",
    doc.querySelectorAll("[data-rucksack-toggle-block]").length === 2,
    `${doc.querySelectorAll("[data-rucksack-toggle-block]").length}`,
  );
  check(
    "the sibling is still readable",
    doc.querySelector("figure [data-rucksack-block]")?.textContent.includes("health") === true,
    doc.querySelector("figure [data-rucksack-block]")?.textContent,
  );
  check(
    "the sibling still offers to stash",
    buttons[1].textContent === "+ Stash" && buttons[1].getAttribute("aria-pressed") === "false",
    buttons[1].textContent,
  );
  check(
    "the panel blinks when something is stashed",
    doc.querySelector("[data-rucksack]").classList.contains("is-stashing"),
  );

  // Removing the stashed block must not renumber its sibling: `health-1` keeps
  // its anchor instead of collapsing into `health`.
  check(
    "the sibling keeps its own anchor after the first block was removed",
    doc.querySelector("figure [data-rucksack-block]").getAttribute("data-rucksack-block") === "health-1",
    doc.querySelector("figure [data-rucksack-block]").getAttribute("data-rucksack-block"),
  );

  click(buttons[1]);
  await settle(() => rows().length === 2);
  check("stashing the sibling adds a second row", rows().length === 2, `got ${rows().length}`);
  check(
    "both health blocks are gone from the page",
    doc.querySelectorAll('figure [data-language="item"]').length === 0,
    `${doc.querySelectorAll('figure [data-language="item"]').length}`,
  );

  const db = await stored();
  check("one record per block is stored in IndexedDB", db.length === 2, `${db.length}`);
  check(
    "the two records share a name but not an anchor",
    db[0]?.name === "health" && db[1]?.name === "health" && db[0]?.anchor !== db[1]?.anchor,
    JSON.stringify(db.map((e) => [e.name, e.anchor, e.slug])),
  );
  check(
    "each record keeps quantity, location and timestamp",
    db.every((e) => e.quantity === 1 && e.location === "" && typeof e.timestamp === "string"),
    JSON.stringify(db),
  );
  check(
    "the fence language is stored as the category",
    db.every((e) => e.category === "item"),
    JSON.stringify(db.map((e) => e.category)),
  );
  const panelRow = () => doc.querySelector("[data-rucksack-entries] .rucksack-entry");
  const modalRow = () => doc.querySelector("[data-rucksack-modal-entries] .rucksack-entry");
  check(
    "the sidebar row hides quantity and date",
    panelRow().querySelector(".rucksack-quantity").hidden === true &&
      panelRow().querySelector(".rucksack-meta").hidden === true,
  );
  check(
    "the modal row still shows quantity and date",
    modalRow().querySelector(".rucksack-quantity").hidden === false &&
      modalRow().querySelector(".rucksack-meta").hidden === false,
  );
  check(
    "the sidebar row keeps what it dropped in its tooltip",
    /\u00d7\d/.test(panelRow().getAttribute("title")),
    panelRow().getAttribute("title"),
  );
  check(
    "the sidebar row is tagged compact, the modal row is not",
    doc.querySelector("[data-rucksack-entries]").classList.contains("rucksack-list--compact") &&
      !doc.querySelector("[data-rucksack-modal-entries]").classList.contains("rucksack-list--compact"),
  );
  check(
    "each stored record lists the block it came from in `sources`",
    db.every((e) => Array.isArray(e.sources) && e.sources.includes(e.slug)),
    JSON.stringify(db.map((e) => e.sources)),
  );
  check("metadata is read-only", doc.querySelectorAll("[data-rucksack-entries] input, [data-rucksack-entries] textarea").length === 0);
  check("the count badge counts rows", doc.querySelector("[data-rucksack-count]").textContent === "2");

  // Removing a row from the panel must bring the block back where it was.
  const removeButtons = doc.querySelectorAll("[data-rucksack-entries] [data-rucksack-remove-entry]");
  check("the panel lists a remove button per row", removeButtons.length === 2, `${removeButtons.length}`);
  const newestRow = removeButtons[0];
  check(
    "the newest row is the block stashed last",
    newestRow.getAttribute("data-rucksack-remove-entry").endsWith("#health-1"),
    newestRow.getAttribute("data-rucksack-remove-entry"),
  );
  click(newestRow);
  await settle(() => doc.querySelectorAll('figure [data-language="item"]').length === 2);
  check(
    "unstashing from the panel puts the block back in the page",
    doc.querySelectorAll('figure [data-language="item"]').length === 2,
    `${doc.querySelectorAll('figure [data-language="item"]').length}`,
  );
  check(
    "the restored block regains its '+ Stash' button",
    doc.querySelectorAll("[data-rucksack-toggle-block]").length === 2,
    `${doc.querySelectorAll("[data-rucksack-toggle-block]").length}`,
  );
  check(
    "the restored block is readable again",
    doc.querySelector("figure [data-rucksack-block]")?.textContent.includes("health") === true,
  );
  check(
    "the restored block keeps its anchor",
    doc.querySelector("figure [data-rucksack-block]")?.getAttribute("data-rucksack-block") === "health-1",
    doc.querySelector("figure [data-rucksack-block]")?.getAttribute("data-rucksack-block"),
  );
  check("the modal sits above the Quartz sidebar", /z-index:\s*9{3,}/.test(component.css));
}

// --- removeFromDom: false -------------------------------------------------
// Stashing marks the block instead of taking it off the page.
{
  const { doc, settle, click, rows, stored } = boot({
    options: { removeFromDom: false },
    blocks: figure("lantern"),
  });

  await settle(() => doc.querySelectorAll("[data-rucksack-toggle-block]").length === 1);

  const button = doc.querySelector("[data-rucksack-toggle-block]");
  click(button);
  await settle(() => rows().length === 1);

  check("the stashed block stays in the DOM when removeFromDom is off",
    doc.querySelectorAll("figure [data-language]").length === 2,
    `${doc.querySelectorAll("figure [data-language]").length}`);
  check("the block is marked as stashed instead",
    doc.querySelector("[data-rucksack-block]").classList.contains("is-stashed") &&
      doc.querySelector("figure").classList.contains("is-stashed"));
  check("its button flips to the stashed label",
    button.textContent === "\u2713 Stashed" && button.getAttribute("aria-pressed") === "true",
    button.textContent);
  click(button);
  await settle(() => rows().length === 0);
  check("unstashing clears the marker",
    !doc.querySelector("[data-rucksack-block]").classList.contains("is-stashed") &&
      button.textContent === "+ Stash",
    button.textContent);
  check("the entry is gone from the store", (await stored()).length === 0);
}

// --- languages ------------------------------------------------------------
{
  const { doc, settle, click, rows, stored } = boot({
    options: { excludeLanguages: ["json"] },
    blocks: figure("a config", "json") + figure("a spell", "spell") + figure("plain", null),
  });

  await settle(() => doc.querySelectorAll("[data-rucksack-toggle-block]").length === 2);

  check("excluded languages get no stash button",
    doc.querySelectorAll('[data-rucksack-toggle-block]').length === 2,
    `${doc.querySelectorAll("[data-rucksack-toggle-block]").length}`);

  click(doc.querySelectorAll("[data-rucksack-toggle-block]")[0]);
  await settle(() => rows().length === 1);
  click(doc.querySelectorAll("[data-rucksack-toggle-block]")[0]);
  await settle(() => rows().length === 2);

  const db = await stored();
  check("a language with no `item`/`event` in it is stowed and stored as its category",
    db.some((e) => e.category === "spell"),
    JSON.stringify(db.map((e) => e.category)));
  check("a fence with no language is stored without a category",
    db.some((e) => e.category === ""),
    JSON.stringify(db.map((e) => e.category)));
  check("a plain fence is labelled in the UI", [...rows()].every((r) => r.querySelector(".rucksack-tag").textContent.length > 0));
}

// --- languages restricted to a list ---------------------------------------
{
  const { doc, settle } = boot({
    options: { languages: ["item", "event"] },
    blocks: figure("health", "item") + figure("goblin", "event") + figure("nope", "spell"),
  });

  await settle(() => doc.querySelectorAll("[data-rucksack-toggle-block]").length > 0);
  check("only the listed languages are stowable",
    doc.querySelectorAll("[data-rucksack-toggle-block]").length === 2,
    `${doc.querySelectorAll("[data-rucksack-toggle-block]").length}`);
}

// --- other options --------------------------------------------------------
{
  const { window, doc, settle, click, rows, stored } = boot({
    options: { title: "Satchel", stashLabel: "Pack it", stashedLabel: "Packed", maxNameLength: 8 },
    blocks: figure("a very long name indeed"),
  });

  await settle(() => doc.querySelectorAll("[data-rucksack-toggle-block]").length === 1);

  const button = doc.querySelector("[data-rucksack-toggle-block]");
  check("custom button labels are used", button.textContent === "Pack it", button.textContent);
  click(button);
  await settle(() => rows().length === 1);
  check("the custom stashed label is used", button.textContent === "Packed", button.textContent);
  check("maxNameLength shortens the preview but not the stored name",
    rows()[0].querySelector(".rucksack-name").textContent === "a very l..." &&
      rows()[0].querySelector(".rucksack-name").getAttribute("aria-label") === "a very long name indeed",
    rows()[0].querySelector(".rucksack-name").textContent);
  check("the full name is what gets stored",
    (await stored())[0].name === "a very long name indeed",
    (await stored())[0].name);
  check("the panel title is configurable", window.__RUCKSACK_CONFIG__.title === "Satchel");
}

{
  // A separate storage key is a separate rucksack.
  const { doc, settle, click, rows, stored } = boot({
    options: { storageKey: "site:bags" },
    blocks: figure("health"),
  });
  await settle(() => doc.querySelectorAll("[data-rucksack-toggle-block]").length === 1);
  click(doc.querySelector("[data-rucksack-toggle-block]"));
  await settle(() => rows().length === 1);
  check("a custom storageKey writes to its own database",
    (await stored("site:bags:db")).length === 1);
}

{
  // `nameAttribute` names an entry from an attribute, for fences whose first
  // line is code rather than a title.
  const { doc, settle, click, rows, stored } = boot({
    options: { nameAttribute: "data-title", parseDetails: false },
    blocks: `
      <figure data-title="Deploy to staging">
        <pre data-language="sh" data-title="Deploy to staging"><code><span data-line=""><span>npm run deploy</span></span></code></pre>
      </figure>`,
  });

  await settle(() => doc.querySelectorAll("[data-rucksack-toggle-block]").length === 1);
  click(doc.querySelector("[data-rucksack-toggle-block]"));
  await settle(() => rows().length === 1);

  const db = await stored();
  check("nameAttribute names the entry instead of the first line",
    db[0].name === "Deploy to staging",
    db[0].name);
  check("parseDetails: false leaves the snippet's own lines alone",
    db[0].quantity === 1 && db[0].location === "",
    JSON.stringify([db[0].quantity, db[0].location]));
}

// --- The rendered panel ---------------------------------------------------
{
  const { h, render } = await import("preact");

  const component = Rucksack({ title: "Satchel", removeFromDom: false, storageKey: "site:bag" });
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  // preact reaches for the ambient document when it renders.
  globalThis.document = window.document;
  const container = window.document.createElement("div");
  render(h(component, {}), container);

  const aside = container.querySelector("[data-rucksack]");
  check("the panel renders its wrapper with the configured class",
    aside?.className === "rucksack", aside?.className);
  check("the panel renders the configured title",
    container.querySelector(".rucksack-label")?.textContent === "Satchel");
  check("removeFromDom is published as a data attribute",
    aside?.getAttribute("data-rucksack-remove") === "false");
  check("storageKey is published as a data attribute",
    aside?.getAttribute("data-rucksack-key") === "site:bag");
  check("the panel ships its styles and both scripts",
    typeof component.css === "string" && component.afterDOMLoaded.length === 2 &&
      String(component.afterDOMLoaded[0]).startsWith("window.__RUCKSACK_CONFIG__ = "),
    String(component.afterDOMLoaded[0]).slice(0, 40));
  check("the inlined config cannot break out of the script tag",
    !String(Rucksack({ title: "</script><script>alert(1)</script>" }).afterDOMLoaded[0]).includes("</script"));
}

// --- Pure model rules -----------------------------------------------------
{
  const { findMergeTarget, isBlockCarried } = await import("../dist/index.js");

  const elsewhere = [
    { slug: "locations#health", name: "health", page: "locations", anchor: "health", sources: ["locations#health"] },
  ];
  check(
    "the same entry carried from another page is a merge target",
    findMergeTarget(elsewhere, "characters", "health") !== undefined,
  );
  check(
    "a block on the carrying page is not its own merge target",
    findMergeTarget(elsewhere, "locations", "health") === undefined,
  );
  check("each stashed block reads as carried", elsewhere.every((e) => isBlockCarried(elsewhere, e.slug)));
  check(
    "a second, identical block on the same page is not carried",
    isBlockCarried(elsewhere, "characters#health-2") === false,
  );
  check(
    "carrying the same entry on another page does not light up this page's blocks",
    isBlockCarried(elsewhere, "characters#health") === false &&
      isBlockCarried(elsewhere, "characters#health-1") === false,
  );

  const { blockSelector, isLanguageStashable, resolveConfig, normalizeCategory, anchorForName } =
    await import("../dist/index.js");
  check("`languages: \"*\"` selects every rendered fence", blockSelector("*") === "pre", blockSelector("*"));
  check("an explicit list selects those languages only",
    blockSelector(["item", "event"]) === '[data-language="item"],[data-language="event"]',
    blockSelector(["item", "event"]));
  check("a language is stashable when the config allows it",
    isLanguageStashable("Item", "*") === true && isLanguageStashable("ts", ["item"]) === false);
  check("an excluded language is never stashable",
    isLanguageStashable("ts", "*", ["ts"]) === false);
  check("fence languages are normalized", normalizeCategory(" Item ") === "item");
  check("long names produce a bounded anchor",
    anchorForName("x".repeat(200)).length <= 64,
    String(anchorForName("x".repeat(200)).length));
  check("repeated names get distinct anchors",
    anchorForName("health", 1) === "health-1" && anchorForName("health", 0) === "health");
  check("resolveConfig fills every option in",
    resolveConfig({}).removeFromDom === true && resolveConfig({ title: "" }).title === "Rucksack",
    JSON.stringify(resolveConfig({})));
  check(
    "a config survives a serialize/resolve round trip",
    resolveConfig(JSON.parse(JSON.stringify(resolveConfig({ title: "Bag" })))).title === "Bag",
  );
}

console.log(checks.join("\n"));
process.exit(checks.some((c) => c.startsWith("FAIL")) ? 1 : 0);