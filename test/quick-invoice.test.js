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
const scan = overrides => ({ id: "scan-quick-001", status: "completed", attachmentIds: ["a".repeat(64)], result: {
  supplierName: "ספק בדיקה", documentNumber: "INV-123", invoiceDate: "2026-09-10", documentType: "invoice",
  subtotalAgorot: 10000, vatAgorot: 1800, totalAgorot: 11800, finalAgorot: 11800, deductions: [],
  uncertainFields: [], needsReview: false, warnings: [], ...overrides,
} });
const fill = (name, value) => { const input = document.querySelector(`[name="${name}"]`); assert.ok(input, name); input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
const choose = async action => { const button = document.querySelector(`[data-quick-choice="${action}"]`); assert.ok(button, action); button.click(); await tick(); };
const submit = () => document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

test("a correction answers its note and continues to the next one before a final save", async () => {
  const { ctx, writes } = setup();
  const original = scan({ warnings: ["תאריך החשבונית אינו ברור: 10.09.2026 או 12/09/2026", "מספר החשבונית דורש בדיקה"] });
  await invoiceForm(ctx, null, original);
  assert.equal(document.querySelectorAll("[data-warning-edit]").length, 1);
  document.querySelector('[data-warning-edit="invoiceDate"]').click();
  assert.equal(document.querySelectorAll("[data-date-candidate]").length, 2);
  document.querySelector('[data-date-candidate="2026-09-12"]').click(); await tick();
  assert.equal(original.result.invoiceDate, "2026-09-10", "printed source remains unchanged");
  assert.match(document.querySelector(".review-position").textContent, /2 מתוך 2/, "the fix continues to the next note");
  assert.ok(document.querySelector('[data-warning-edit="documentNumber"]'));
  assert.equal(writes.length, 0);
  await choose("next"); assert.ok(document.querySelector(".quick-summary-grid"));
  submit(); await tick();
  assert.equal(writes.length, 1); assert.equal(writes[0].body.data.invoiceDate, "2026-09-12");
});

test("a note with nothing to fix is one confirmation and never lists every field as work", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, scan({ warnings: ["יש לאמת ידנית את שיוך מספרי הלקוח ואת כל המזהים הנוספים המודפסים במסמך."] }));
  assert.equal(document.querySelectorAll("[data-warning-edit]").length, 0, "no field is guessed from an unclassified note");
  assert.equal(document.querySelector("details.warning-other").open, false, "the field picker stays closed");
  await choose("next");
  assert.ok(document.querySelector(".quick-summary-grid"));
  assert.equal(writes.length, 0);
  submit(); await tick();
  assert.equal(writes.length, 1);
});

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
  submit(); await tick(); assert.deepEqual(writes[0].body.data.newSupplier, { name: "ספק חדש", taxIds: [] });
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

test("a warning-only ambiguous invoice number is corrected once, resumed and saved deliberately", async () => {
  const { ctx, writes, cache } = setup();
  const original = scan({ documentNumber: "59912_2", warnings: ["מספר החשבונית אינו חד משמעי: 59912_2 או 59912_21. נדרש אימות אנושי."] });
  await invoiceForm(ctx, null, original);
  document.querySelector('[data-warning-edit="documentNumber"]').click();
  assert.match(document.querySelector('.quick-question').textContent, /59912_21/);
  fill("documentNumber", "59912_21"); await choose("next");
  assert.equal(cache.get("invoice").fields.documentNumber, "59912_21");
  assert.ok(document.querySelector(".quick-summary-grid"), "the correction answers the note it came from");
  await invoiceForm(ctx);
  assert.ok(document.querySelector(".quick-summary-grid"), "the answered note does not return on resume");
  assert.equal(writes.length, 0);
  submit(); await tick();
  assert.equal(writes[0].body.data.documentNumber, "59912_21");
  assert.equal(original.result.documentNumber, "59912_2", "retain the original scan as evidence");
});

test("warning correction can change another field without bypassing the arithmetic review", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, scan({ warnings: ['בדוק את הסכום הכולל <script>bad()</script>'] }));
  assert.equal(document.querySelector('script'), null);
  document.querySelector('[data-warning-edit="totalAgorot"]').click();
  fill('total', '119.00'); await choose('next');
  assert.ok(document.querySelector('.quick-question'));
  assert.equal(document.querySelector('[type="submit"]').hidden, true);
  assert.equal(writes.length, 0);
});

// Typed from the paper: the same five questions in the same order, every time.
const title = () => document.querySelector(".quick-question h3")?.textContent;
const progress = () => document.querySelector(".quick-progress span")?.textContent;
const answerSupplier = async () => { fill("supplierName", "ספק בדיקה"); await choose("next"); };
test("typed from the paper: five questions in a fixed order, then one deliberate save", async () => {
  const { ctx, writes, cache } = setup();
  await invoiceForm(ctx, null, null, ["a".repeat(64)], { quick: true });
  assert.equal(title(), "מי הספק?"); assert.equal(progress(), "שאלה 1 מתוך 5");
  assert.equal(cache.get("invoice").scan, null, "nothing was read");
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
  assert.equal(document.querySelector('[data-quick-choice="vat-unknown"]'), null, "no unknown VAT when typing from the paper");
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
  assert.equal(saved.scanJobId, null);
});
test("typed VAT: the rate is one tap, a VAT above the total is refused, and zero is explicit", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, null, [], { quick: true });
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
  await invoiceForm(zero.ctx, null, null, [], { quick: true });
  await answerSupplier(); fill("documentNumber", "7003"); await choose("next");
  fill("total", "50"); await choose("next"); await choose("vat-zero"); await choose("next");
  submit(); await tick();
  assert.equal(zero.writes[0].body.data.vatAgorot, 0);
  assert.equal(zero.writes[0].body.data.subtotalAgorot, 5000);
});
test("a typed draft resumes in its questions, not in the full form, and the type changes only from the summary", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, null, [], { quick: true });
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
