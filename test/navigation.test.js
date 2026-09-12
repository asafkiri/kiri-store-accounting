import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createNavigation } from "../src/navigation.js";
const tick = () => new Promise(resolve => setTimeout(resolve, 40));

test("Back and Forward restore folders, filters and scroll without putting invoice data in browser history", async t => {
  const dom = new JSDOM("", { url: "https://navigation.example" }); t.after(() => dom.window.close());
  let state = { route: "home", filters: {}, folderPath: {}, scrollY: 0 };
  const nav = createNavigation({ window: dom.window, snapshot: () => state, restore: value => { state = value; }, blocked: () => false, dismissOverlay: () => false });
  nav.reset();
  nav.visit(() => { state = { route: "invoices", filters: { status: "paid", q: "invoice-private-query" }, folderPath: {}, scrollY: 420 }; });
  nav.visit(() => { state = { ...state, folderPath: { month: "2026-09" }, scrollY: 180 }; });
  nav.visit(() => { state = { ...state, folderPath: { month: "2026-09", supplierId: "supplier-private-id" }, scrollY: 35 }; });
  assert.doesNotMatch(JSON.stringify(dom.window.history.state), /supplier-private|invoice-private|2026-09/);
  nav.back(); await tick();
  assert.deepEqual(state.folderPath, { month: "2026-09" }); assert.equal(state.scrollY, 180);
  dom.window.history.back(); await tick();
  assert.deepEqual(state.folderPath, {}); assert.equal(state.scrollY, 420);
  assert.equal(state.filters.q, "invoice-private-query"); assert.equal(state.filters.status, "paid");
  dom.window.history.forward(); await tick();
  assert.deepEqual(state.folderPath, { month: "2026-09" });
});

test("native Back closes the open dialog before leaving its folder and cannot interrupt a pending write", async t => {
  const dom = new JSDOM("", { url: "https://navigation.example" }); t.after(() => dom.window.close());
  let state = { route: "home" }, overlay = false, busy = false;
  const nav = createNavigation({ window: dom.window, snapshot: () => state, restore: value => { state = value; }, blocked: () => busy,
    dismissOverlay: () => { if (!overlay) return false; overlay = false; return true; } });
  nav.reset(); nav.visit(() => { state = { route: "invoices", folderPath: { month: "2026-09" } }; });
  const marker = structuredClone(dom.window.history.state);
  overlay = true;
  dom.window.history.back(); await tick();
  assert.equal(overlay, false); assert.equal(state.route, "invoices"); assert.deepEqual(dom.window.history.state, marker);
  overlay = true; busy = true;
  dom.window.history.back(); await tick();
  assert.equal(overlay, true); assert.equal(state.route, "invoices"); assert.deepEqual(dom.window.history.state, marker);
  busy = false; nav.back(); assert.equal(overlay, false);
  nav.back(); await tick(); assert.equal(state.route, "home");
});
