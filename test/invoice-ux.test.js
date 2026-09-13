import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { filterInvoices, invoiceLabel } from "../src/format.js";
import { invoicesView, documentsView } from "../src/views.js";
import { invoiceDetails } from "../src/invoice-details.js";

const suppliers = [{ id: "s1", name: "תנובה" }, { id: "s2", name: "מרינה" }];
const invoice = (id, date, amount, extra = {}) => ({
  id, supplierId: "s1", documentNumber: "", documentType: "invoice", invoiceDate: date,
  finalAgorot: amount, totalAgorot: amount, status: "unpaid", attachmentIds: ["photo"], createdAt: 1, ...extra,
});
const rows = [
  invoice("one", "2026-09-05", 118000),
  invoice("two", "2026-08-15", 1118000),
  invoice("three", "2026-09-05", 118000, { supplierId: "s2", status: "paid", payment: { method: "cash", paymentDate: "2026-09-06" } }),
  invoice("four", "2026-08-05", 65000, { documentNumber: "1180" }),
];
const context = extra => ({ route: "invoices", data: { invoices: rows, suppliers }, filters: {}, folderPath: {}, draftNames: [], limit: 80, ...extra });
const dom = html => new JSDOM(html).window.document;
const search = (q, extra = {}) => filterInvoices(rows, { q, ...extra }, suppliers).map(i => i.id);

test("search identifies invoices with blank numbers by supplier, exact shekel amount and readable dates", () => {
  for (const amount of ["1180", "1,180", "1,180.00 ₪", "₪1180.00"]) assert.deepEqual(search(amount), ["one", "three"]);
  for (const date of ["5/9/2026", "05.09.2026", "5-9-26", "2026-09-05", "5/9"]) assert.deepEqual(search(date), ["one", "three"]);
  assert.deepEqual(search("תנובה 5/9 1,180"), ["one"]);
  assert.deepEqual(search("2026-08"), ["two", "four"]);
  assert.deepEqual(search("11,180"), ["two"]);
  assert.deepEqual(search("1180", { status: "unpaid" }), ["one"]);
  assert.deepEqual(search("0"), []);
  assert.deepEqual(search("5/9", { month: "2026-08" }), []);
});

test("search supports the printed total after a payment reduction, never includes deleted invoices", () => {
  const items = [invoice("reduced", "2026-09-05", 108000, { totalAgorot: 118000 }), invoice("deleted", "2026-09-05", 118000, { deletedAt: 1 })];
  assert.deepEqual(filterInvoices(items, { q: "1180" }, suppliers).map(i => i.id), ["reduced"]);
});

test("the opening screen shows folders immediately and keeps administrative actions inside More", () => {
  const page = dom(invoicesView(context()));
  assert.equal(page.querySelectorAll(".month-folder").length, 2);
  assert.equal(page.querySelectorAll(".invoice-entry,.scan-primary,.check-search-link,.tabs").length, 0);
  const options = page.querySelector(".invoice-options");
  assert.equal(options.open, false);
  for (const action of ["invoice", "manage-suppliers", "refresh"]) assert.ok(options.querySelector(`[data-action="${action}"]`));
  assert.ok(page.querySelector('[data-action="open-unpaid"]'));
  assert.match(page.querySelector("#invoice-search").getAttribute("placeholder"), /ספק, תאריך או סכום/);
});

test("search results open records directly, respect the current folder and report no matches", () => {
  const ctx = context({ filters: { q: "תנובה" } });
  let page = dom(invoicesView(ctx));
  assert.equal(page.querySelectorAll(".month-folder,.supplier-folder").length, 0);
  assert.deepEqual([...page.querySelectorAll('[data-action="detail"]')].map(el => el.dataset.id), ["one", "two", "four"]);
  ctx.folderPath = { month: "2026-09", supplierId: "s1" };
  page = dom(invoicesView(ctx));
  assert.equal(page.querySelectorAll('[data-action="detail"]').length, 1);
  assert.equal(page.querySelectorAll("h1").length, 1);
  assert.equal(page.querySelector(".supplier-name").textContent, "05.09.2026");
  ctx.filters.q = "1234567";
  page = dom(invoicesView(ctx));
  assert.match(page.body.textContent, /אין חשבוניות שמתאימות לסינון/);
  assert.ok(page.querySelector('[data-action="clear-search"]'));
  ctx.filters.q = "תנובה"; ctx.folderPath = {};
  page = dom(documentsView(ctx));
  assert.equal(page.querySelectorAll('[data-action="documents"]').length, 3);
  assert.equal(page.querySelectorAll(".month-folder,.supplier-folder").length, 0);
});

test("invoice rows have one action and no number or missing-number label", () => {
  const page = dom(invoicesView(context({ filters: { q: "תנובה" } })));
  for (const row of page.querySelectorAll(".invoice-card")) {
    assert.equal(row.querySelectorAll("button").length, 1);
    assert.ok(row.querySelector(".amount"));
    assert.ok(row.querySelector(".badge"));
    assert.doesNotMatch(row.textContent, /מספר|ללא מספר/);
  }
  assert.equal(invoiceLabel(rows[0]), "חשבונית");
});

test("paid details show the payment while corrections and per-page deletions remain in More", () => {
  const original = structuredClone(rows[2]);
  const page = dom(invoiceDetails(rows[2], suppliers[1]));
  assert.ok(page.querySelector(".payment-receipt"));
  assert.equal(page.querySelectorAll(".invoice-detail-primary").length, 0);
  const more = page.querySelector(".invoice-edit-actions");
  assert.equal(more.open, false);
  for (const action of ["pay", "edit", "unpay", "delete"]) assert.ok(more.querySelector(`[data-detail-action="${action}"]`));
  assert.ok(more.querySelector("[data-delete-document]"));
  assert.equal(page.querySelector(".attachment-row [data-delete-document]"), null);
  assert.ok(page.querySelector(".attachment-row [data-open-document]"));
  const unpaid = dom(invoiceDetails(rows[0], suppliers[0]));
  assert.equal(unpaid.querySelector(".invoice-detail-primary").textContent, "סמן ששילמתי");
  assert.deepEqual(rows[2], original);
});
