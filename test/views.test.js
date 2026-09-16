import test from "node:test";
import assert from "node:assert/strict";
import {
  shell,
  invoicesView,
  suppliersView,
  reportsView,
} from "../src/views.js";
import { money } from "../src/format.js";
test("loading and failed sync never report an empty store or a zero payable total", () => {
  for (const route of ["invoices", "suppliers", "cash", "reports"]) {
    const ctx = {
      route,
      filters: { status: "unpaid" },
      data: { invoices: [], suppliers: [], dailyCash: [] },
      draftNames: [],
      limit: 80,
    };
    const loading = shell({ ...ctx, loading: true, lastRefresh: 0 });
    assert.match(loading, /טוען/);
    assert.doesNotMatch(
      loading,
      /אין כרגע חשבוניות|0 חשבוניות|0\.00|אין עדיין ספקים/,
    );
    const failed = shell({
      ...ctx,
      loading: false,
      lastRefresh: 123,
      syncError: true,
    });
    assert.match(failed, /לא התקבל עדכון מהשרת/);
    assert.match(failed, /data-action="refresh"/);
    assert.doesNotMatch(
      failed,
      /אין כרגע חשבוניות|0 חשבוניות|0\.00|אין עדיין ספקים/,
    );
  }
});

test("invoice, supplier and monthly summaries subtract signed credits and flag legacy positive credits", () => {
  const invoice = {
    id: "invoice-001",
    supplierId: "supplier-001",
    documentNumber: "INV-1",
    documentType: "invoice",
    invoiceDate: "2026-09-10",
    status: "unpaid",
    subtotalAgorot: null,
    vatAgorot: null,
    totalAgorot: 10000,
    finalAgorot: 10000,
  };
  const credit = {
    ...invoice,
    id: "credit-001",
    documentType: "credit",
    documentNumber: "CR-1",
    totalAgorot: -3000,
    finalAgorot: -3000,
  };
  const ctx = {
    filters: { month: "2026-09", status: "unpaid" },
    limit: 80,
    draftNames: [],
    data: {
      invoices: [invoice, credit],
      suppliers: [{ id: invoice.supplierId, name: "ספק בדיקה", active: true }],
    },
  };
  for (const view of [invoicesView, suppliersView, reportsView]) {
    assert.ok(view(ctx).includes(money(7000)));
    credit.totalAgorot = credit.finalAgorot = 3000;
    const invalid = view(ctx);
    assert.match(invalid, /נדרש תיקון זיכוי/);
    assert.ok(!invalid.includes(money(13000)));
    assert.equal(
      credit.finalAgorot,
      3000,
      "view must not change original stored data",
    );
    credit.totalAgorot = credit.finalAgorot = -3000;
  }
});

test("the invoice and photo archive show only the current folder and retain a back button", async () => {
  const { JSDOM } = await import("jsdom");
  const { documentsView } = await import("../src/views.js");
  const ctx = { route: "invoices", filters: {}, limit: 80, draftNames: [], data: {
    suppliers: [{ id: "s1", name: "ספק א", active: false }, { id: "s2", name: "ספק ב", active: true }],
    invoices: [
      { id: "i1", supplierId: "s1", invoiceDate: "2026-09-02", documentType: "invoice", documentNumber: "1", status: "unpaid", finalAgorot: 100, attachmentIds: ["photo-a", "photo-b"] },
      { id: "i2", supplierId: "s2", invoiceDate: "2026-09-01", documentType: "invoice", documentNumber: "2", status: "paid", finalAgorot: 200, attachmentIds: [] },
      { id: "i3", supplierId: "s1", invoiceDate: "2026-08-10", documentType: "invoice", documentNumber: "3", status: "paid", finalAgorot: 300, attachmentIds: ["photo-c"] },
    ],
  } };
  const render = (view = invoicesView) => new JSDOM(shell({ ...ctx, lastRefresh: 1, route: view === documentsView ? "documents" : "invoices" })).window.document;
  let doc = render();
  assert.deepEqual([...doc.querySelectorAll('.month-folder')].map(b => b.dataset.value), ["2026-09", "2026-08"]);
  assert.equal(doc.querySelectorAll('.invoice-card,.supplier-folder,details.month-folder').length, 0);
  ctx.folderPath = { month: "2026-09" }; doc = render();
  assert.equal(doc.querySelectorAll('.supplier-folder').length, 2);
  assert.equal(doc.querySelectorAll('.invoice-card,.month-folder').length, 0);
  assert.match(doc.querySelector('[data-action="folder-back"]').textContent, /חזרה לחודשים/);
  ctx.folderPath.supplierId = "s1"; doc = render();
  assert.equal(doc.querySelectorAll('.invoice-card').length, 1);
  assert.equal(doc.querySelectorAll('.supplier-folder,.month-folder').length, 0);
  assert.match(doc.querySelector('[data-action="folder-back"]').textContent, /חזרה לספקים/);
  doc = render(documentsView);
  assert.equal(doc.querySelectorAll('.document-card').length, 1);
  assert.equal(doc.querySelector('[data-action="documents"]').dataset.id, "i1");
  assert.equal(doc.querySelectorAll('.document-card button').length, 1, "the row opens the document; sharing is inside it");
  // Sharing the month must still include other suppliers when viewing one.
  assert.equal(doc.querySelector('[data-action="share-month"]').dataset.month, "2026-09");
  ctx.folderPath = {}; ctx.filters.q = "ספק א"; doc = render();
  assert.equal(doc.querySelectorAll('.month-folder').length, 0);
  assert.equal(doc.querySelectorAll('.invoice-card').length, 2, "search reaches invoices directly across months");
});

test("the main navigation does not duplicate the invoices entry already offered on Home", async () => {
  const { JSDOM } = await import("jsdom");
  const ctx = {
    filters: {},
    folderPath: {},
    limit: 80,
    data: { invoices: [], suppliers: [], dailyCash: [] },
    draftNames: [],
    lastRefresh: 123,
    syncError: false,
  };
  const render = route => new JSDOM(shell({ ...ctx, route })).window.document;
  const home = render("home"), nav = home.querySelector('nav[aria-label="ניווט ראשי"]');
  assert.deepEqual([...nav.querySelectorAll("[data-route]")].map(b => b.dataset.route), ["home", "more"]);
  // The invoices entry belongs to Home, which keeps it reachable in one tap.
  assert.ok(home.querySelector('#main [data-route="invoices"]'));
  const invoicesNav = render("invoices").querySelector('nav[aria-label="ניווט ראשי"]');
  assert.equal(invoicesNav.querySelectorAll("button.active,[aria-current]").length, 0);
});

// Back sits with Home at the bottom of the phone, where the thumb rests, and
// keeps its place on Home so the bar never shifts under a finger already aimed.
test("Back rides the bottom bar beside Home, and only Back answers to a tap meant for it", async () => {
  const { JSDOM } = await import("jsdom");
  const base = { filters: {}, folderPath: {}, limit: 80, data: { invoices: [], suppliers: [], dailyCash: [] }, draftNames: [], lastRefresh: 123, syncError: false };
  const render = extra => new JSDOM(shell({ ...base, ...extra })).window.document;
  for (const [state, label, action] of [
    [{ route: "invoices", folderPath: { month: "2026-09", supplierId: "s1" } }, "חזרה לספקים", "folder-back"],
    [{ route: "invoices", folderPath: { month: "2026-09" } }, "חזרה לחודשים", "folder-back"],
    [{ route: "suppliers" }, "חזור", "back"],
  ]) {
    const doc = render(state), nav = doc.querySelector('nav[aria-label="ניווט ראשי"]');
    const back = nav.querySelector(".app-back");
    assert.equal(nav.firstElementChild, back, "Back leads the bar, nearest the thumb in Hebrew");
    assert.match(back.textContent, new RegExp(label));
    assert.equal(back.dataset.action, action);
    assert.equal(back.disabled, false);
    assert.equal(doc.querySelectorAll(".topbar [data-route],.topbar [data-action]").length, 0, "nothing in the top bar competes with it");
  }
  const onHome = render({ route: "home" }).querySelector("nav .app-back");
  assert.equal(onHome.disabled, true, "nothing to go back to, but the bar does not move");
  assert.match(onHome.textContent, /חזור/);
});
