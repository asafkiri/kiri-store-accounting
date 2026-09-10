import test from "node:test";
import assert from "node:assert/strict";
import { shell } from "../src/views.js";
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
