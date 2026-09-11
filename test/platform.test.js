import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { download } from "../src/export.js";

test("classic compatibility guard shows Hebrew before unsupported iOS can load the module", async () => {
  const script = await readFile(new URL("../public/compat.js", import.meta.url), "utf8");
  for (const version of [13, 15, 16, 26]) {
    const app = { innerHTML: "loading" };
    const context = { navigator: { userAgent: `iPhone OS ${version}_0 like Mac OS X` },
      window: { structuredClone() {}, crypto: { subtle: {}, randomUUID() {} }, indexedDB: {} },
      document: { getElementById: id => id === "app" ? app : { showModal() {} } } };
    vm.runInNewContext(script, context);
    assert.equal(context.window.ksaUnsupportedBrowser, version < 16);
    if (version < 16) assert.match(app.innerHTML, /נדרש עדכון לדפדפן/);
    else assert.equal(app.innerHTML, "loading");
  }
});

test("installed iOS export shares a file; cancellation stays cancelled and share failures offer download", async t => {
  const dom = new JSDOM("<body></body>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousDocument = globalThis.document;
  t.after(() => { Object.defineProperty(globalThis, "navigator", previous); globalThis.document = previousDocument; dom.window.close(); });
  globalThis.document = dom.window.document;
  let downloaded = 0, shared;
  dom.window.HTMLAnchorElement.prototype.click = () => { downloaded++; };
  t.mock.method(globalThis, "setTimeout", callback => { callback(); return 0; });
  const navigator = { standalone: true, canShare: () => true, share: async data => { shared = data; } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  await download("supplier,total\nfixture,123", "report.csv", "text/csv");
  assert.equal(shared.files[0].name, "report.csv");
  assert.match(await shared.files[0].text(), /fixture,123/);
  assert.equal(downloaded, 0);
  navigator.share = async () => { throw new DOMException("cancelled", "AbortError"); };
  await download("data", "report.csv", "text/csv");
  assert.equal(downloaded, 0);
  navigator.share = async () => { throw new DOMException("unavailable", "NotAllowedError"); };
  await download("data", "report.csv", "text/csv");
  assert.equal(downloaded, 1);
});
