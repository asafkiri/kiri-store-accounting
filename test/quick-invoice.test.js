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
const answerSupplier = async () => { fill("supplierName", "ספק בדיקה"); document.querySelector('[data-supplier-action="confirm"]').click(); await tick(); };
// The four answers of an ordinary invoice. Its number remains blank.
const typeInvoice = async ({ total = "118", vat = "18" } = {}) => {
  await answerSupplier();
  fill("total", total); await choose("next");
  fill("vat", vat); await choose("vat-manual");
  await choose("next");
};

test("supplier list filters while typing, keeps partial-name creation available and advances only on choice", async () => {
  const { ctx, cache, writes } = setup();
  ctx.data.suppliers = [
    { id: "supplier-tnuva", name: "תנובה", active: true, version: 1 },
    { id: "supplier-marina", name: "מרינה בע״מ", active: true, version: 1 },
    { id: "supplier-other", name: "תנורי העיר", active: true, version: 1 },
    { id: "supplier-inactive", name: "ספק לא פעיל", active: false, version: 3 },
    { id: "supplier-deleted", name: "ספק שנמחק", active: false, deletedAt: 1, version: 2 },
  ];
  const rows = () => [...document.querySelectorAll('.supplier-result strong')].map(el => el.textContent);
  const create = () => document.querySelector('[data-supplier-action="create"]');
  await invoiceForm(ctx, null, [], { quick: true });
  assert.equal(rows().length, 4);
  assert.equal(document.querySelector('[data-supplier-picker] details'), null);
  assert.equal(document.querySelector('[data-quick-choice="next"]'), null);
  fill("supplierName", "תנו");
  assert.deepEqual(rows(), ["תנובה", "תנורי העיר"]);
  assert.ok(create());
  assert.equal(cache.get("invoice").fields.supplierId, "");
  assert.equal(title(), "מי הספק?");
  fill("supplierName", "תנוב");
  assert.deepEqual(rows(), ["תנובה"]);
  assert.ok(create(), "a partial match does not prevent creating a distinct name");
  fill("supplierName", "תנובה");
  assert.equal(create(), null);
  fill("supplierName", " מרינה בע\"מ ");
  assert.deepEqual(rows(), ['מרינה בע״מ']);
  assert.equal(create(), null, "the server's normalized duplicate rule is also enforced locally");
  fill("supplierName", "ספק שאין");
  assert.equal(rows().length, 0); assert.ok(create());
  fill("supplierName", "");
  assert.equal(rows().length, 4);
  fill("supplierName", "תנוב");
  await invoiceForm(ctx, null, [], { quick: true });
  assert.deepEqual(rows(), ["תנובה"], "an unfinished search resumes with its results");
  document.querySelector('[data-supplier-action="confirm"]').click(); await tick();
  assert.equal(title(), "מה הסכום כולל מע״מ?");
  assert.equal(cache.get("invoice").fields.supplierId, "supplier-tnuva");
  assert.equal(cache.get("invoice").fields.supplierName, "תנובה");
  assert.equal(cache.get("invoice").newSupplier, undefined);
  assert.equal(cache.get("invoice").fields.documentNumber, "");
  assert.equal(writes.length, 0);
});

test("creating beside a partial match retains a separate supplier until invoice approval", async () => {
  const { ctx, cache, writes } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  fill("supplierName", "ספק");
  assert.equal(document.querySelectorAll('.supplier-result').length, 1);
  document.querySelector('[data-supplier-action="create"]').click(); await tick();
  const pending = cache.get("invoice").newSupplier;
  assert.equal(pending.name, "ספק");
  assert.notEqual(pending.id, ctx.data.suppliers[0].id);
  assert.equal(writes.length, 0);
  await ctx.modalBack(); await tick();
  document.querySelector('[data-supplier-action="keep-new"]').click(); await tick();
  assert.equal(title(), "מה הסכום כולל מע״מ?");
  assert.deepEqual(cache.get("invoice").newSupplier, pending);
  await ctx.modalBack(); await tick();
  fill("supplierName", "ספק בדיקה");
  document.querySelector('[data-supplier-action="confirm"]').click(); await tick();
  assert.equal(cache.get("invoice").newSupplier, undefined);
  assert.equal(cache.get("invoice").fields.supplierId, ctx.data.suppliers[0].id);
  assert.equal(writes.length, 0);
});

test("inclusive VAT uses exact agorot, configurable rates and never applies the rate to the gross again", () => {
  assert.deepEqual(vatFromInclusive(11800, 1800), { vatAgorot: 1800, subtotalAgorot: 10000 });
  assert.deepEqual(vatFromInclusive(-11700, 1700), { vatAgorot: 1700, subtotalAgorot: 10000 });
  assert.deepEqual(vatFromInclusive(535835, 0), { vatAgorot: 0, subtotalAgorot: 535835 });
  const v = vatFromInclusive(535835, 1800); assert.equal(v.vatAgorot + v.subtotalAgorot, 535835);
});
test("typed from the paper: four questions in a fixed order, then one deliberate save", async () => {
  const { ctx, writes, cache } = setup();
  await invoiceForm(ctx, null, ["a".repeat(64)], { quick: true });
  assert.equal(title(), "מי הספק?"); assert.equal(progress(), "שאלה 1 מתוך 4");
  assert.match(document.body.textContent, /פרטי החשבונית|מי הספק/);
  await answerSupplier();
  // The document number is never asked: it is the slowest thing to type and it
  // is already printed on the paper and on its photograph.
  assert.equal(title(), "מה הסכום כולל מע״מ?"); assert.equal(progress(), "שאלה 2 מתוך 4");
  fill("total", "118"); await choose("next");
  assert.equal(title(), "כמה מע״מ יש בחשבונית?"); assert.equal(progress(), "שאלה 3 מתוך 4");
  assert.ok(document.querySelector("[name=vat]"), "the VAT is a box to type into");
  assert.match(document.querySelector('[data-quick-choice="vat-rate"]').textContent, /18%[\s\S]*18\.00/, "the rate shortcut shows what it would give");
  fill("vat", "18"); submit(); await tick();
  assert.equal(title(), "מה תאריך החשבונית?", "Enter confirms the typed VAT"); assert.equal(progress(), "שאלה 4 מתוך 4");
  assert.equal(document.querySelector("[name=invoiceDate]").value, today(), "today is offered, not assumed");
  assert.match(document.querySelector(".quick-question").textContent, /מולא תאריך היום/);
  await choose("next");
  assert.equal(document.querySelector(".quick-question"), null, "then the summary");
  assert.ok(document.querySelector(".quick-summary-grid"));
  assert.doesNotMatch(document.querySelector(".quick-summary-grid").textContent, /מספר חשבונית|ללא מספר/);
  assert.equal(document.querySelector('[data-edit-question="documentNumber"],[name="documentNumber"]'), null);
  assert.equal(writes.length, 0);
  submit(); await tick();
  const saved = writes[0].body.data;
  assert.equal(saved.supplierId, "supplier-001"); assert.equal(saved.documentNumber, "", "an invoice saves without a number");
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
  await answerSupplier();
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
  await answerSupplier();
  fill("total", "50"); await choose("next"); await choose("vat-zero"); await choose("next");
  submit(); await tick();
  assert.equal(zero.writes[0].body.data.vatAgorot, 0);
  assert.equal(zero.writes[0].body.data.subtotalAgorot, 5000);
});
test("a configured rate is offered by its own percentage", async () => {
  const { ctx, writes } = setup();
  ctx.data.settings = [{ id: "accounting", defaultVatBasisPoints: 1700 }];
  await invoiceForm(ctx, null, [], { quick: true });
  await answerSupplier();
  fill("total", "117"); await choose("next");
  assert.match(document.querySelector('[data-quick-choice="vat-rate"]').textContent, /17%[\s\S]*17\.00/);
  await choose("vat-rate"); await choose("next"); submit(); await tick();
  assert.equal(writes[0].body.data.vatAgorot, 1700);
  assert.equal(writes[0].body.data.subtotalAgorot, 10000);
});
test("a typed draft resumes in its questions, not in the full form, and the type changes only from the summary", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  await answerSupplier();
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
  assert.equal(title(), "מה הסכום כולל מע״מ?", "opening the supplier answers the question");
  assert.equal(cache.get("invoice").newSupplier.name, "ספק חדש");
  fill("total", "118"); await choose("next");
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
  assert.equal(ctx.modalBack, null, "an unresolved write cannot return to editable questions");
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

test("Back walks through prior answers, retains an unfinished value on reload, and recalculates a derived subtotal", async () => {
  const { ctx, writes, cache } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  await typeInvoice();
  await ctx.modalBack(); await tick();
  assert.equal(title(), "מה תאריך החשבונית?");
  assert.equal(progress(), "שאלה 4 מתוך 4");
  fill("invoiceDate", "2026-09-02");
  await ctx.modalBack(); await tick();
  assert.equal(title(), "כמה מע״מ יש בחשבונית?");
  assert.equal(document.querySelector('[name="vat"]').value, "18.00");
  await ctx.modalBack(); await tick();
  assert.equal(progress(), "שאלה 2 מתוך 4");
  fill("total", "236");
  await invoiceForm(ctx);
  assert.equal(title(), "מה הסכום כולל מע״מ?");
  assert.equal(document.querySelector('[name="total"]').value, "236");
  assert.equal(cache.get("invoice").fields.invoiceDate, "2026-09-02");
  await choose("next");
  fill("vat", "36"); await choose("vat-manual");
  assert.equal(document.querySelector('[name="invoiceDate"]').value, "2026-09-02");
  await choose("next");
  assert.equal(title(), undefined);
  submit(); await tick();
  assert.equal(writes[0].body.data.documentNumber, "");
  assert.equal(writes[0].body.data.subtotalAgorot, 20000);
  assert.equal(writes[0].body.data.finalAgorot, 23600);
  assert.equal(writes[0].body.data.invoiceDate, "2026-09-02");
});

test("Back from a question returns to supplier selection without clearing later values or saving an invoice", async () => {
  const { ctx, writes } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  assert.equal(ctx.modalBack, null);
  await answerSupplier();
  fill("total", "118");
  await ctx.modalBack(); await tick();
  assert.equal(title(), "מי הספק?");
  assert.equal(progress(), "שאלה 1 מתוך 4");
  assert.equal(document.querySelector('[name="supplierName"]').value, "ספק בדיקה");
  assert.equal(ctx.modalBack, null, "the first question is the explicit exit point");
  document.querySelector('[data-supplier-action="confirm"]').click(); await tick();
  assert.equal(document.querySelector('[name="total"]').value, "118");
  assert.equal(writes.length, 0);
});

test("a deliberate subtotal correction is preserved and needs review after changing the VAT", async () => {
  const { ctx } = setup();
  await invoiceForm(ctx, null, [], { quick: true });
  await typeInvoice();
  document.querySelector('[data-edit-question="subtotalAgorot"]').click();
  fill("subtotal", "99"); await choose("next");
  await choose("arithmetic-keep");
  await ctx.modalBack(); await tick();
  await ctx.modalBack(); await tick();
  fill("vat", "17"); await choose("vat-manual"); await choose("next");
  assert.equal(title(), "הסכומים אינם מסתכמים");
  assert.match(document.querySelector('.quick-question').textContent, /99\.00/);
});

// The number is no longer typed during intake, so the invoice is recognised by
// what is: the supplier, the date, the total and the VAT.
const alreadySaved = (extra = {}) => ({
  id: "invoice-earlier", version: 1, supplierId: "supplier-001", documentNumber: "7009",
  documentType: "invoice", invoiceDate: today(), subtotalAgorot: 10000, vatAgorot: 1800,
  totalAgorot: 11800, finalAgorot: 11800, deductions: [], attachmentIds: [], status: "unpaid", ...extra,
});
test("an invoice already entered is named on the summary and is not saved again by accident", async () => {
  const { ctx, writes } = setup();
  ctx.data.invoices = [alreadySaved()];
  await invoiceForm(ctx, null, [], { quick: true });
  await typeInvoice();
  const notice = document.querySelector("[data-duplicate-notice]");
  assert.ok(notice, "the summary says the invoice is already here");
  assert.match(notice.textContent, /כנראה כבר קלטת/);
  assert.match(notice.textContent, /חשבונית 7009/, "and which invoice it is");
  assert.match(notice.textContent, /ספק בדיקה/);
  submit(); await tick();
  assert.equal(writes.length, 0, "saving is refused while it looks like the same invoice");
  assert.match(document.querySelector("[data-form-error]").textContent, /כבר קלטת/);
  // The same supplier on another day is another invoice, and nothing is said.
  document.querySelector('[data-edit-question="invoiceDate"]').click(); await tick();
  fill("invoiceDate", "2026-09-01"); await choose("next");
  assert.equal(document.querySelector("[data-duplicate-notice]"), null);
  submit(); await tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.data.invoiceDate, "2026-09-01");
  assert.equal("duplicateAllowed" in writes[0].body.data, false, "an invoice with no twin keeps its own guard");
});
test("two identical invoices in one day are saved once the person says they are two", async () => {
  const { ctx, writes } = setup();
  ctx.data.invoices = [alreadySaved()];
  await invoiceForm(ctx, null, [], { quick: true });
  await typeInvoice();
  document.querySelector("[data-confirm-duplicate]").click(); await tick();
  assert.match(document.querySelector("[data-duplicate-notice]").textContent, /חשבונית נפרדת/);
  submit(); await tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.data.duplicateAllowed, true);
});
test("a deleted invoice is not the twin of the one typed in its place", async () => {
  const { ctx, writes } = setup();
  ctx.data.invoices = [alreadySaved({ deletedAt: 1757700000000 })];
  await invoiceForm(ctx, null, [], { quick: true });
  await typeInvoice();
  assert.equal(document.querySelector("[data-duplicate-notice]"), null);
  submit(); await tick();
  assert.equal(writes.length, 1);
});
test("the store's own refusal offers the same choice, for an invoice this device has not synced", async () => {
  const { ctx, writes } = setup();
  ctx.api.save = async () => { throw new ApiError("כבר נשמרה חשבונית של הספק הזה", "DUPLICATE_INVOICE_DETAILS", 409, "request-1", { invoiceId: "invoice-elsewhere" }); };
  await invoiceForm(ctx, null, [], { quick: true });
  await typeInvoice();
  assert.equal(document.querySelector("[data-duplicate-notice]"), null, "nothing here says so yet");
  submit(); await tick();
  const notice = document.querySelector("[data-duplicate-notice]");
  assert.ok(notice, "the refusal is shown with the way out");
  assert.match(notice.textContent, /אותם פרטים בדיוק/);
  ctx.api.save = async p => { writes.push(structuredClone(p)); return { record: { ...p.body.data, id: p.path.split("/")[1], version: 1 } }; };
  document.querySelector("[data-confirm-duplicate]").click(); await tick();
  submit(); await tick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.data.duplicateAllowed, true);
});
