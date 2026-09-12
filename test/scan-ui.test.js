import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { scanDialog } from "../src/scan.js";
import { ApiError } from "../src/api.js";
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
  assert.equal(document.querySelector(".quick-invoice [type=submit]").hidden, true);
  assert.ok(document.querySelector('[data-quick-choice="vat-rate"]'));
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
const selectedFiles = () => [
  { name: "processed-page.jpg", mime: "image/jpeg", data: "AQID" },
  { name: "second-page.pdf", mime: "application/pdf", data: "BAUG" },
];
const attachmentIds = ["a".repeat(64), "b".repeat(64)];
test("manual continuation uploads every selected file once and links them only on reviewed save", async () => {
  const files = selectedFiles();
  const { ctx, cache, calls } = setup({ files, attachmentIds: [], status: "editing" });
  let completeUpload;
  const saved = [];
  ctx.api.request = async (path, options) => {
    calls.push({ path, options });
    return new Promise(resolve => { completeUpload = resolve; });
  };
  ctx.api.save = async pending => {
    saved.push(structuredClone(pending));
    return { record: { id: pending.path.split("/")[1], ...pending.body.data } };
  };
  await scanDialog(ctx);
  const button = document.getElementById("manual-from-scan");
  const continuing = button.onclick();
  await button.onclick(); // A second activation while the upload is pending.
  assert.equal(button.disabled, true);
  assert.equal(document.getElementById("run-scan").disabled, true);
  assert.equal(document.getElementById("camera-file").disabled, true);
  assert.equal(document.getElementById("invoice-form"), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "documents");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.body.files, files);
  completeUpload({ documents: attachmentIds.map(id => ({ id })) });
  await continuing;
  await tick();
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds);
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, attachmentIds);
  assert.deepEqual([...document.querySelectorAll("[data-open-document]")].map(b => b.dataset.openDocument), attachmentIds);
  assert.equal(document.querySelector("[name=review]").checked, false);
  assert.equal(saved.length, 0);
  const form = document.getElementById("invoice-form");
  for (const [name, value] of Object.entries({ supplierId: "supplier-001", documentNumber: "MANUAL-1", total: "10", final: "10" })) {
    form.elements[name].value = value;
    form.elements[name].dispatchEvent(new Event("input", { bubbles: true }));
  }
  form.elements.review.checked = true;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].body.data.attachmentIds, attachmentIds);
  assert.equal(saved[0].body.data.source, "manual");
  assert.equal(saved[0].body.data.scanJobId, null);
  assert.equal(saved[0].body.data.reviewConfirmed, true);
  assert.deepEqual(calls.map(c => c.path), ["documents"], "no paid AI request");
});
test("failed manual upload preserves the photos and lets the user retry", async () => {
  const files = selectedFiles();
  const { ctx, cache, calls } = setup({ files, attachmentIds: [], status: "editing" });
  ctx.api.request = async path => {
    calls.push(path);
    if (calls.length === 1) throw new ApiError("אין חיבור לרשת כרגע", "NETWORK", 0);
    return { documents: attachmentIds.map(id => ({ id })) };
  };
  await scanDialog(ctx);
  await document.getElementById("manual-from-scan").onclick();
  assert.equal(document.getElementById("invoice-form"), null);
  assert.equal(cache.has("invoice"), false);
  assert.deepEqual(cache.get("scan").files, files);
  assert.equal(document.getElementById("manual-from-scan").disabled, false);
  assert.equal(document.getElementById("scan-error").hidden, false);
  await document.getElementById("manual-from-scan").onclick();
  await tick();
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, attachmentIds);
  assert.deepEqual(calls, ["documents", "documents"]);
});
test("reopening after a failed manual form load reuses the uploaded documents", async () => {
  const { ctx, cache, calls } = setup({ files: selectedFiles(), attachmentIds: [], status: "editing" });
  ctx.api.request = async path => {
    calls.push(path);
    return { documents: attachmentIds.map(id => ({ id })) };
  };
  const load = ctx.drafts.load;
  ctx.drafts.load = async key => {
    if (key === "invoice") throw new DOMException("closed", "InvalidStateError");
    return load(key);
  };
  await scanDialog(ctx);
  await document.getElementById("manual-from-scan").onclick();
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds);
  ctx.drafts.load = load;
  await scanDialog(ctx);
  await document.getElementById("manual-from-scan").onclick();
  await tick();
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, attachmentIds);
  assert.deepEqual(calls, ["documents"]);
});
test("manual entry without selected files does not upload an empty document batch", async () => {
  const { ctx, calls } = setup({ files: [], attachmentIds: [], status: "editing" });
  await scanDialog(ctx);
  await document.getElementById("manual-from-scan").onclick();
  assert.ok(document.getElementById("invoice-form"));
  assert.deepEqual(calls, []);
});
test("an upload finishing after the scan view is removed does not reopen an invoice", async () => {
  const { ctx, cache } = setup({ files: selectedFiles(), attachmentIds: [], status: "editing" });
  let completeUpload;
  ctx.api.request = async () => new Promise(resolve => { completeUpload = resolve; });
  await scanDialog(ctx);
  const continuing = document.getElementById("manual-from-scan").onclick();
  document.getElementById("modal").replaceChildren();
  completeUpload({ documents: attachmentIds.map(id => ({ id })) });
  await continuing;
  assert.equal(document.getElementById("invoice-form"), null);
  assert.equal(cache.has("invoice"), false);
});
for (const existing of [false, true, "offline"]) {
  test(`scan lock recovery checks whether this job exists (${existing}) without another paid request`, async () => {
    const { ctx, cache, calls } = setup({
      files: [{ name: "page.jpg", mime: "image/jpeg", data: "AAAA" }],
      attachmentIds: ["a".repeat(64)],
      jobId: null,
      status: "editing",
    });
    ctx.api.request = async (path) => {
      calls.push(path);
      if (path === "scan-invoice")
        throw new ApiError("כבר מתבצעת סריקה", "SCAN_IN_PROGRESS", 409);
      if (existing === "offline") throw new ApiError("ניתוק", "NETWORK", 0);
      if (!existing) throw new ApiError("לא נמצא", "NOT_FOUND", 404);
      return { id: cache.get("scan").jobId, status: "running" };
    };
    await scanDialog(ctx);
    document.getElementById("run-scan").click();
    await tick();
    assert.equal(calls.length, 2);
    assert.match(calls[1], /^scan-jobs\//);
    assert.equal(cache.get("scan").status, existing ? "running" : "editing");
    assert.equal(Boolean(cache.get("scan").jobId), Boolean(existing));
    assert.equal(
      document.getElementById("run-scan").disabled,
      Boolean(existing),
    );
    assert.deepEqual(cache.get("scan").attachmentIds, ["a".repeat(64)]);
  });
}

// The browser gave up on a Tnuva invoice the server had already read, and the
// screen asked to check the connection in front of a finished scan.
for (const served of ["completed", "running", "offline"]) {
  test(`a scan with no answer is looked up for free before the connection is blamed (${served})`, async () => {
    const { ctx, cache, calls } = setup({
      files: [{ name: "page.jpg", mime: "image/jpeg", data: "AAAA" }],
      attachmentIds: ["a".repeat(64)],
      jobId: null,
      status: "editing",
    });
    const completed = await ctx.api.request("template");
    calls.length = 0;
    ctx.api.request = async (path) => {
      calls.push(path);
      if (path === "scan-invoice")
        throw new ApiError("אין כרגע אישור מהשרת.", "NETWORK", 0);
      if (served === "offline") throw new ApiError("ניתוק", "NETWORK", 0);
      return { ...completed, id: cache.get("scan").jobId, status: served };
    };
    await scanDialog(ctx);
    document.getElementById("run-scan").click();
    await tick();
    assert.equal(calls.length, 2, "exactly one free lookup, never another paid scan");
    assert.equal(calls[0], "scan-invoice");
    assert.match(calls[1], /^scan-jobs\//);
    assert.equal(
      Boolean(document.getElementById("invoice-form")),
      served === "completed",
      "a finished reading opens for review instead of showing an error",
    );
    const error = document.getElementById("scan-error");
    assert.equal(error?.hidden ?? true, served !== "offline", "the connection is blamed only when it is at fault");
  });
}
