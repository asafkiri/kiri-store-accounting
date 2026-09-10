import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
test("filter disclosure and checkbox labels offer at least 44px touch targets", async () => {
  const css = await readFile(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(
    `<style>${css}</style><details class="filter-panel"><summary>סינון</summary></details><label class="checkbox"><input type="checkbox">בדקתי</label>`,
  );
  for (const element of dom.window.document.querySelectorAll(
    "summary,.checkbox",
  ))
    assert.ok(parseFloat(dom.window.getComputedStyle(element).minHeight) >= 44);
  dom.window.close();
});
