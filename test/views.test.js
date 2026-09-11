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

test("the invoice and photo archive group by month then supplier, and search reveals closed folders", async () => {
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
  const dom = new JSDOM(invoicesView(ctx));
  const months = [...dom.window.document.querySelectorAll(".month-folder")];
  assert.deepEqual(months.map(m => m.dataset.folder), ["invoices:2026-09", "invoices:2026-08"]);
  assert.equal(months[0].querySelectorAll(".supplier-folder").length, 2);
  assert.equal(months[0].querySelectorAll(".invoice-card").length, 2);
  assert.equal(months[1].querySelectorAll(".invoice-card").length, 1);
  dom.window.close();
  const photos = new JSDOM(documentsView(ctx));
  assert.equal(photos.window.document.querySelectorAll(".document-card").length, 2);
  assert.deepEqual([...photos.window.document.querySelectorAll("[data-open-document]")].map(b => b.dataset.openDocument), ["photo-a", "photo-b", "photo-c"]);
  photos.window.close();
  ctx.filters.q = "ספק א";
  ctx.folderState = { "invoices:2026-09": false, "invoices:2026-09:s1": false };
  const searched = new JSDOM(invoicesView(ctx));
  assert.equal(searched.window.document.querySelector('[data-folder="invoices:2026-09:s1"]').open, true);
  assert.equal(searched.window.document.querySelectorAll(".invoice-card").length, 2);
  searched.window.close();
});
