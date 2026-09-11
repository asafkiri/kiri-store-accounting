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
