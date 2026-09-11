import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { invoiceForm } from "../src/forms.js";
import { vatFromInclusive } from "../src/quick-invoice-model.js";
import { actionableDraftNames } from "../src/draft-activity.js";
import { totals } from "../src/format.js";
import { ApiError } from "../src/api.js";
const tick = () => new Promise(r => setTimeout(r, 25));
function setup() {
  const dom = new JSDOM('<body><div id="modal"></div><div id="toast"></div>', { url: "https://unit.example" });
  for (const key of ["window", "document", "Event", "FormData"]) globalThis[key] = dom.window[key];
  globalThis.confirm = () => true;
  const cache = new Map(), writes = [];
  const ctx = {
    data: { suppliers: [{ id: "supplier-001", name: "ספק בדיקה", active: true, version: 1 }], invoices: [], settings: [] },
    drafts: { load: async key => structuredClone(cache.get(key) || null), save: async (key, value) => cache.set(key, structuredClone(value)), remove: async key => cache.delete(key), names: async () => [...cache.keys()] },
    dialog: (_title, body) => { document.getElementById("modal").innerHTML = body; return document.getElementById("modal"); },
    api: { save: async p => { writes.push(structuredClone(p)); return { record: { ...p.body.data, id: p.path.split("/")[1], version: 1 } }; } },
    setModalBusy() {}, closeModal() {}, render() {}, refresh() {}, mergeRecord() {},
  };
  return { ctx, cache, writes };
}
const scan = overrides => ({ id: "scan-quick-001", status: "completed", attachmentIds: ["a".repeat(64)], result: {
  supplierName: "ספק בדיקה", documentNumber: "INV-123", invoiceDate: "2026-09-10", documentType: "invoice",
  subtotalAgorot: 10000, vatAgorot: 1800, totalAgorot: 11800, finalAgorot: 11800, deductions: [],
  uncertainFields: [], needsReview: false, warnings: [], ...overrides,
} });
const fill = (name, value) => { const input = document.querySelector(`[name="${name}"]`); assert.ok(input, name); input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
const choose = async action => { const button = document.querySelector(`[data-quick-choice="${action}"]`); assert.ok(button, action); button.click(); await tick(); };
const submit = () => document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

test("inclusive VAT uses exact agorot, configurable rates and never applies the rate to the gross again", () => {
  assert.deepEqual(vatFromInclusive(11800, 1800), { vatAgorot: 1800, subtotalAgorot: 10000 });
  assert.deepEqual(vatFromInclusive(-11700, 1700), { vatAgorot: 1700, subtotalAgorot: 10000 });
  assert.deepEqual(vatFromInclusive(535835, 0), { vatAgorot: 0, subtotalAgorot: 535835 });
  const v = vatFromInclusive(535835, 1800); assert.equal(v.vatAgorot + v.subtotalAgorot, 535835);
});
test("complete scan goes straight to summary; payment reduction and notes leave monthly VAT intact", async () => {
  const { ctx, writes } = setup(); const original = scan();
  await invoiceForm(ctx, null, original);
  assert.equal(document.querySelector(".quick-question"), null);
  assert.match(document.body.textContent, /INV-123/);
  assert.equal(writes.length, 0);
  fill("paymentReduction", "100"); fill("notes", "חוסר שאושר מול הספק");
  submit(); await tick();
  const saved = writes[0].body.data;
  assert.equal(saved.finalAgorot, 1800); assert.equal(saved.totalAgorot, 11800); assert.equal(saved.vatAgorot, 1800);
  assert.equal(saved.deductions.length, 1); assert.equal(saved.deductions[0].includedInTotal, false);
  assert.equal(totals([saved]).vat, 1800); assert.equal(saved.notes, "חוסר שאושר מול הספק");
  assert.equal(original.result.finalAgorot, 11800);
});
test("missing document type and VAT are sequential tap answers; no invented or repeated values on resume", async () => {
  const { ctx, cache, writes } = setup();
  const original = scan({ documentType: null, subtotalAgorot: null, vatAgorot: null, uncertainFields: ["documentType", "vatAgorot", "subtotalAgorot"] });
  await invoiceForm(ctx, null, original);
  assert.match(document.querySelector("h3").textContent, /איזו חשבונית/);
  assert.equal(document.querySelector('[data-quick-choice="vat-rate"]'), null);
  await choose("invoice");
  assert.match(document.querySelector('[data-quick-choice="vat-rate"]').textContent, /18%/);
  assert.equal(cache.get("invoice").fields.vat, "");
  await choose("vat-rate");
  assert.equal(document.querySelector(".quick-question"), null);
  assert.equal(cache.get("invoice").fields.vat, "18.00");
  await invoiceForm(ctx);
  assert.equal(document.querySelector(".quick-question"), null);
  assert.equal(writes.length, 0);
  submit(); await tick(); assert.equal(writes[0].body.data.subtotalAgorot, 10000);
});
test("new supplier is confirmed in one question and only created with the invoice approval", async () => {
  const { ctx, writes, cache } = setup();
  await invoiceForm(ctx, null, scan({ supplierName: "ספק חדש" }));
  document.querySelector('[data-supplier-action="create"]').click(); await tick();
  assert.equal(document.querySelector(".quick-question"), null);
  assert.equal(writes.length, 0);
  assert.equal(cache.get("invoice").newSupplier.name, "ספק חדש");
  submit(); await tick(); assert.deepEqual(writes[0].body.data.newSupplier, { name: "ספק חדש" });
});
test("unknown VAT stays unknown and selecting zero VAT is explicit", async () => {
  for (const [action, expected] of [["vat-unknown", null], ["vat-zero", 0]]) {
    const { ctx, writes } = setup();
    await invoiceForm(ctx, null, scan({ vatAgorot: null, subtotalAgorot: null }));
    await choose(action); submit(); await tick();
    assert.equal(writes[0].body.data.vatAgorot, expected);
  }
});
test("a configured rate is offered; conflicting printed subtotal is retained for an explicit decision", async () => {
  const { ctx, cache } = setup();
  ctx.data.settings = [{ id: "accounting", defaultVatBasisPoints: 1700 }];
  await invoiceForm(ctx, null, scan({ vatAgorot: null, subtotalAgorot: 11700, totalAgorot: 11700, finalAgorot: 11700 }));
  assert.match(document.querySelector('[data-quick-choice="vat-rate"]').textContent, /17%/);
  await choose("vat-rate");
  assert.equal(cache.get("invoice").fields.subtotal, "117.00");
  assert.match(document.querySelector("h3").textContent, /אינם מסתכמים/);
  await choose("arithmetic-keep"); assert.equal(document.querySelector(".quick-question"), null);
});
test("lost approval response retries the exact mutation after reload without another deduction", async () => {
  const { ctx, writes } = setup();
  ctx.api.save = async p => { writes.push(structuredClone(p)); if (writes.length === 1) throw new ApiError("ניתוק", "NETWORK", 0); return { record: { id: p.path.split("/")[1], ...p.body.data } }; };
  await invoiceForm(ctx, null, scan());
  fill("paymentReduction", "10"); submit(); await tick();
  await invoiceForm(ctx);
  assert.equal(document.querySelector('[name="paymentReduction"]').disabled, true);
  submit(); await tick();
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[1].body.data.finalAgorot, 10800);
});
test("empty forms and legacy empty scans make no banners; linked scan/review makes one and discard clears both", async () => {
  const { ctx, cache } = setup();
  await invoiceForm(ctx); await tick();
  cache.set("scan", { files: [], attachmentIds: [], jobId: null });
  assert.deepEqual(await actionableDraftNames(ctx.drafts, ctx.data), []);
  const original = scan();
  cache.set("scan", { files: [], jobId: original.id, attachmentIds: original.attachmentIds, result: original });
  await invoiceForm(ctx, null, original); await tick();
  assert.deepEqual(await actionableDraftNames(ctx.drafts, ctx.data), ["invoice"]);
  document.querySelector("[data-discard-draft]").click(); await tick();
  assert.deepEqual(await actionableDraftNames(ctx.drafts, ctx.data), []);
});

test("a separately recorded included rounding line does not create a false VAT question", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, scan({ subtotalAgorot: 338550, vatAgorot: 60941, totalAgorot: 399500, finalAgorot: 399500,
    deductions: [{ label: "הפרש עיגול", amountAgorot: 9, includedInTotal: true }] }));
  assert.equal(document.querySelector(".quick-question"), null);
  assert.equal(writes.length, 0);
  submit(); await tick();
  assert.equal(writes[0].body.data.vatAgorot, 60941);
  assert.equal(writes[0].body.data.finalAgorot, 399500);
});
