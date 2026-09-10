import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { scanDialog } from "../src/scan.js";
function setup(draft) {
  const dom = new JSDOM(
    '<body><div id="modal"></div><div id="toast"></div></body>',
    { url: "https://unit.example" },
  );
  for (const k of ["window", "document", "Event", "FormData"])
    globalThis[k] = dom.window[k];
  globalThis.confirm = () => true;
  const cache = new Map([["scan", draft]]),
    calls = [];
  const ctx = {
    data: {
      suppliers: [{ id: "supplier-001", name: "ספק בדיקה", active: true }],
      invoices: [],
      dailyCash: [],
    },
    drafts: {
      load: async (k) => structuredClone(cache.get(k) || null),
      save: async (k, v) => cache.set(k, structuredClone(v)),
      remove: async (k) => cache.delete(k),
    },
    dialog: (_title, body) => {
      document.getElementById("modal").innerHTML =
        '<div class="content">' + body + "</div>";
      return document.querySelector(".content");
    },
    api: {
      request: async (path) => {
        calls.push(path);
        return {
          id: "job-unit-1",
          status: "completed",
          attachmentIds: ["a".repeat(64)],
          result: {
            supplierName: "ספק בדיקה",
            documentNumber: "123",
            invoiceDate: "2026-09-10",
            documentType: "invoice",
            subtotalAgorot: null,
            vatAgorot: null,
            totalAgorot: 100,
            finalAgorot: null,
            deductions: [],
            uncertainFields: ["vatAgorot"],
            needsReview: true,
            warnings: [],
          },
        };
      },
    },
    setModalBusy() {},
    closeModal() {},
    render() {},
    refresh() {},
    mergeRecord() {},
  };
  return { ctx, cache, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 30));
test("recovering a scan retrieves its result without an extra paid scan and opens review only", async () => {
  const { ctx, calls } = setup({
    files: [],
    attachmentIds: ["a".repeat(64)],
    jobId: "job-unit-1",
    status: "running",
  });
  await scanDialog(ctx);
  assert.equal(document.getElementById("run-scan").disabled, true);
  document.getElementById("check-scan").click();
  await tick();
  assert.deepEqual(calls, ["scan-jobs/job-unit-1"]);
  assert.ok(document.getElementById("invoice-form"));
  assert.equal(document.querySelector("[name=vat]").value, "");
  assert.equal(document.querySelector("[name=review]").checked, false);
});
test("failed AI can continue with a manual invoice retaining already-uploaded files", async () => {
  const { ctx, calls, cache } = setup({
    files: [],
    attachmentIds: ["a".repeat(64)],
    jobId: "failed-unit-job",
    status: "failed",
  });
  await scanDialog(ctx);
  document.getElementById("manual-from-scan").click();
  await tick();
  assert.ok(document.getElementById("invoice-form"));
  assert.deepEqual(calls, []);
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, ["a".repeat(64)]);
  assert.equal(cache.get("invoice").fields.source, "manual");
  assert.equal(cache.get("invoice").fields.scanJobId, null);
});
