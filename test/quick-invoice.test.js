import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { invoiceForm } from "../src/forms.js";
import { vatFromInclusive } from "../src/quick-invoice-model.js";
import { actionableDraftNames } from "../src/draft-activity.js";
import { totals, today } from "../src/format.js";
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
const fill = (name, value) => { const input = document.querySelector(`[name="${name}"]`); assert.ok(input, name); input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
const choose = async action => { const button = document.querySelector(`[data-quick-choice="${action}"]`); assert.ok(button, action); button.click(); await tick(); };
const submit = () => document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));


const title = () => document.querySelector(".quick-question h3")?.textContent;
const progress = () => document.querySelector(".quick-progress span")?.textContent;
const answerSupplier = async () => { fill("supplierName", "ספק בדיקה"); await choose("next"); };
// The five answers of an ordinary invoice, typed from the paper.
const typeInvoice = async ({ number = "7001", total = "118", vat = "18" } = {}) => {
  await answerSupplier();
  fill("documentNumber", number); await choose("next");
  fill("total", total); await choose("next");
  fill("vat", vat); await choose("vat-manual");
  await choose("next");
};

test("inclusive VAT uses exact agorot, configurable rates and never applies the rate to the gross again", () => {
  assert.deepEqual(vatFromInclusive(11800, 1800), { vatAgorot: 1800, subtotalAgorot: 10000 });
  assert.deepEqual(vatFromInclusive(-11700, 1700), { vatAgorot: 1700, subtotalAgorot: 10000 });
  assert.deepEqual(vatFromInclusive(535835, 0), { vatAgorot: 0, subtotalAgorot: 535835 });
  const v = vatFromInclusive(535835, 1800); assert.equal(v.vatAgorot + v.subtotalAgorot, 535835);
});
test("typed from the paper: five questions in a fixed order, then one deliberate save", async () => {
  const { ctx, writes, cache } = setup();
  await invoiceForm(ctx, null, ["a".repeat(64)], { quick: true });
  assert.equal(title(), "מי הספק?"); assert.equal(progress(), "שאלה 1 מתוך 5");
  assert.match(document.body.textContent, /פרטי החשבונית|מי הספק/);
  await answerSupplier();
  assert.equal(title(), "מה מספר החשבונית?"); assert.equal(progress(), "שאלה 2 מתוך 5");
  await choose("next");
  assert.equal(title(), "מה מספר החשבונית?", "an empty number does not pass");
  assert.equal(document.querySelector("[data-form-error]").hidden, false);
  fill("documentNumber", "7001"); await choose("next");
  assert.equal(title(), "מה הסכום כולל מע״מ?"); assert.equal(progress(), "שאלה 3 מתוך 5");
  fill("total", "118"); await choose("next");
  assert.equal(title(), "כמה מע״מ יש בחשבונית?"); assert.equal(progress(), "שאלה 4 מתוך 5");
  assert.ok(document.querySelector("[name=vat]"), "the VAT is a box to type into");
  assert.match(document.querySelector('[data-quick-choice="vat-rate"]').textContent, /18%[\s\S]*18\.00/, "the rate shortcut shows what it would give");
  fill("vat", "18"); submit(); await tick();
  assert.equal(title(), "מה תאריך החשבונית?", "Enter confirms the typed VAT"); assert.equal(progress(), "שאלה 5 מתוך 5");
  assert.equal(document.querySelector("[name=invoiceDate]").value, today(), "today is offered, not assumed");
  assert.match(document.querySelector(".quick-question").textContent, /מולא תאריך היום/);
  await choose("next");
  assert.equal(document.querySelector(".quick-question"), null, "then the summary");
  assert.ok(document.querySelector(".quick-summary-grid"));
  assert.equal(writes.length, 0);
  submit(); await tick();
  const saved = writes[0].body.data;
  assert.equal(saved.supplierId, "supplier-001"); assert.equal(saved.documentNumber, "7001");
  assert.equal(saved.invoiceDate, today()); assert.equal(saved.documentType, "invoice");
  assert.equal(saved.totalAgorot, 11800); assert.equal(saved.vatAgorot, 1800);
  assert.equal(saved.subtotalAgorot, 10000); assert.equal(saved.finalAgorot, 11800);
  assert.equal(saved.source, "manual"); assert.deepEqual(saved.attachmentIds, ["a".repeat(64)]);
  assert.equal("scanJobId" in saved, false, "nothing was read");
  assert.equal(cache.has("invoice"), false, "the draft is gone once the server confirmed");
});
test("typed VAT: the rate is one tap, a VAT above the total is refused, and zero is explicit", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  await answerSupplier(); fill("documentNumber", "7002"); await choose("next");
  fill("total", "118"); await choose("next");
  fill("vat", "200"); await choose("vat-manual");
  assert.equal(title(), "כמה מע״מ יש בחשבונית?");
  assert.match(document.querySelector("[data-form-error]").textContent, /גדול מהסכום הכולל/);
  await choose("vat-rate");
  assert.equal(title(), "מה תאריך החשבונית?");
  await choose("next"); submit(); await tick();
  assert.equal(writes[0].body.data.vatAgorot, 1800);
  assert.equal(writes[0].body.data.subtotalAgorot, 10000);
  const zero = setup();
  await invoiceForm(zero.ctx, null, [], { quick: true });
  await answerSupplier(); fill("documentNumber", "7003"); await choose("next");
  fill("total", "50"); await choose("next"); await choose("vat-zero"); await choose("next");
  submit(); await tick();
  assert.equal(zero.writes[0].body.data.vatAgorot, 0);
  assert.equal(zero.writes[0].body.data.subtotalAgorot, 5000);
});
test("a configured rate is offered by its own percentage", async () => {
  const { ctx, writes } = setup();
  ctx.data.settings = [{ id: "accounting", defaultVatBasisPoints: 1700 }];
  await invoiceForm(ctx, null, [], { quick: true });
  await answerSupplier(); fill("documentNumber", "7005"); await choose("next");
  fill("total", "117"); await choose("next");
  assert.match(document.querySelector('[data-quick-choice="vat-rate"]').textContent, /17%[\s\S]*17\.00/);
  await choose("vat-rate"); await choose("next"); submit(); await tick();
  assert.equal(writes[0].body.data.vatAgorot, 1700);
  assert.equal(writes[0].body.data.subtotalAgorot, 10000);
});
test("a typed draft resumes in its questions, not in the full form, and the type changes only from the summary", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  await answerSupplier(); fill("documentNumber", "7004"); await choose("next");
  await invoiceForm(ctx); // reopened the way a draft reminder does, without the option
  assert.equal(title(), "מה הסכום כולל מע״מ?", "resumes where it stopped");
  assert.equal(document.querySelector("[name=review]"), null, "not the full form");
  fill("total", "118"); await choose("next"); fill("vat", "18"); await choose("vat-manual"); await choose("next");
  assert.equal(document.querySelector(".quick-question"), null);
  document.querySelector('[data-edit-question="documentType"]').click(); await tick();
  assert.equal(title(), "איזו חשבונית זאת?");
  await choose("credit");
  assert.equal(document.querySelector(".quick-question"), null);
  submit(); await tick();
  assert.equal(writes[0].body.data.documentType, "credit");
  assert.ok(writes[0].body.data.totalAgorot < 0, "a credit note is stored negative");
});
test("the summary takes a payment reduction and a note that leave the invoice and its VAT intact", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  await typeInvoice();
  assert.equal(document.querySelector(".quick-question"), null);
  fill("paymentReduction", "100"); fill("notes", "חוסר שאושר מול הספק");
  submit(); await tick();
  const saved = writes[0].body.data;
  assert.equal(saved.finalAgorot, 1800); assert.equal(saved.totalAgorot, 11800); assert.equal(saved.vatAgorot, 1800);
  assert.equal(saved.deductions.length, 1); assert.equal(saved.deductions[0].includedInTotal, false);
  assert.equal(totals([saved]).vat, 1800); assert.equal(saved.notes, "חוסר שאושר מול הספק");
});
test("a new supplier is opened from the first question and created only with the invoice", async () => {
  const { ctx, writes, cache } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  fill("supplierName", "ספק חדש");
  document.querySelector('[data-supplier-action="create"]').click(); await tick();
  assert.equal(title(), "מה מספר החשבונית?", "opening the supplier answers the question");
  assert.equal(cache.get("invoice").newSupplier.name, "ספק חדש");
  fill("documentNumber", "7006"); await choose("next"); fill("total", "118"); await choose("next");
  await choose("vat-rate"); await choose("next");
  assert.equal(writes.length, 0);
  submit(); await tick();
  assert.deepEqual(writes[0].body.data.newSupplier, { name: "ספק חדש", taxIds: [] });
});
test("lost approval response retries the exact mutation after reload without another deduction", async () => {
  const { ctx, writes } = setup();
  ctx.api.save = async p => { writes.push(structuredClone(p)); if (writes.length === 1) throw new ApiError("ניתוק", "NETWORK", 0); return { record: { id: p.path.split("/")[1], ...p.body.data } }; };
  await invoiceForm(ctx, null, [], { quick: true });
  await typeInvoice();
  fill("paymentReduction", "10"); submit(); await tick();
  await invoiceForm(ctx);
  assert.equal(document.querySelector('[name="paymentReduction"]').disabled, true);
  submit(); await tick();
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[1].body.data.finalAgorot, 10800);
});
test("empty forms make no banners; a photo linked to its invoice makes one, and discard clears both", async () => {
  const { ctx, cache } = setup();
  await invoiceForm(ctx); await tick();
  cache.set("scan", { files: [], attachmentIds: [] });
  assert.deepEqual(await actionableDraftNames(ctx.drafts, ctx.data), []);
  const pages = ["a".repeat(64)];
  cache.set("scan", { files: [], attachmentIds: pages });
  await invoiceForm(ctx, null, pages, { quick: true }); await tick();
  assert.deepEqual(await actionableDraftNames(ctx.drafts, ctx.data), ["invoice"], "one reminder for one invoice");
  document.querySelector("[data-discard-draft]").click(); await tick();
  assert.deepEqual(await actionableDraftNames(ctx.drafts, ctx.data), []);
});
