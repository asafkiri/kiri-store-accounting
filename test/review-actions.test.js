import test from "node:test";
import assert from "node:assert/strict";
import { warningDates, warningFields } from "../src/review-actions.js";
const draft = { fields: { deductions: [] } };
test("warning suggestions are specific and unknown notes do not guess a field", () => {
  assert.deepEqual(warningFields("מספר החשבונית אינו חד משמעי", draft).map(([k]) => k), ["documentNumber"]);
  assert.deepEqual(warningFields("תאריך החשבונית דורש בדיקה", draft).map(([k]) => k), ["invoiceDate"]);
  assert.deepEqual(warningFields("מספר דפים חסר בצילום", draft), []);
  assert.deepEqual(warningFields("הצילום אינו ברור", draft), []);
});
test("date choices preserve valid dates from the note without inventing or normalizing impossible dates", () => {
  assert.deepEqual(warningDates("מופיעים 10.09.2026 ו־12/09/2026 וגם 2026-09-10"), ["2026-09-10", "2026-09-12"]);
  assert.deepEqual(warningDates("31/02/2026 או 12/13/2026 או 12/09/26"), []);
  assert.deepEqual(warningDates("מספר החשבונית 59912_21 וסכום 2026.09"), []);
});
