import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { scanDialog } from "../src/scan.js";
import { ApiError } from "../src/api.js";
const attachmentIds = ["a".repeat(64), "b".repeat(64)];
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
    // The only request this screen makes is the upload of the pages.
    api: {
      request: async (path, options) => {
        calls.push(path);
        return { documents: options.body.files.map((_, i) => ({ id: attachmentIds[i] })) };
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
const selectedFiles = () => [
  { name: "processed-page.jpg", mime: "image/jpeg", data: "AQID" },
  { name: "second-page.pdf", mime: "application/pdf", data: "BAUG" },
];
const questionTitle = () => document.querySelector(".quick-question h3")?.textContent;

test("a photographed invoice opens the typed questions with the pages attached, and nothing reads it", async () => {
  const { ctx, cache, calls } = setup({ files: selectedFiles(), attachmentIds: [] });
  await scanDialog(ctx);
  assert.equal(document.getElementById("run-scan"), null, "no scan button exists");
  assert.equal(document.getElementById("check-scan"), null);
  const button = document.getElementById("fill-details");
  assert.equal(button.textContent, "המשך למילוי הפרטים");
  await button.onclick();
  await tick();
  assert.deepEqual(calls, ["documents"], "one upload and no other request");
  assert.ok(document.getElementById("invoice-form"));
  assert.equal(questionTitle(), "מי הספק?", "the questions start with the supplier");
  assert.match(document.querySelector(".quick-progress span").textContent, /שאלה 1 מתוך 5/);
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds);
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, attachmentIds);
  assert.equal(cache.get("invoice").fields.source, "manual");
  assert.equal(cache.get("invoice").fields.scanJobId, null);
  assert.equal(cache.get("invoice").scan, null);
  assert.ok(document.querySelector("[data-open-document]"), "the photograph stays one tap away");
});
test("the upload happens once even when the button is pressed twice, and shows its wait", async () => {
  const files = selectedFiles();
  const { ctx, cache, calls } = setup({ files, attachmentIds: [] });
  let completeUpload;
  ctx.api.request = async (path, options) => {
    calls.push({ path, options });
    return new Promise((resolve) => { completeUpload = resolve; });
  };
  await scanDialog(ctx);
  const button = document.getElementById("fill-details");
  const continuing = button.onclick();
  await button.onclick(); // A second activation while the upload is pending.
  assert.equal(button.disabled, true);
  assert.equal(document.getElementById("camera-file").disabled, true);
  assert.equal(document.getElementById("invoice-form"), null);
  const status = document.getElementById("scan-status");
  assert.ok(status.querySelector(".scan-wait-spin"), "the wait is visibly alive");
  assert.match(status.querySelector(".scan-wait-text strong").textContent, /מעלה את הצילום…/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "documents");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.body.files, files);
  completeUpload({ documents: attachmentIds.map((id) => ({ id })) });
  await continuing;
  await tick();
  assert.equal(status.getAttribute("aria-busy"), null, "nothing keeps spinning");
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds);
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, attachmentIds);
  assert.equal(questionTitle(), "מי הספק?");
});
test("a failed upload keeps the photos and lets the user try again", async () => {
  const files = selectedFiles();
  const { ctx, cache, calls } = setup({ files, attachmentIds: [] });
  ctx.api.request = async (path) => {
    calls.push(path);
    if (calls.length === 1) throw new ApiError("אין חיבור לרשת כרגע", "NETWORK", 0);
    return { documents: attachmentIds.map((id) => ({ id })) };
  };
  await scanDialog(ctx);
  await document.getElementById("fill-details").onclick();
  assert.equal(document.getElementById("invoice-form"), null);
  assert.equal(cache.has("invoice"), false);
  assert.deepEqual(cache.get("scan").files, files);
  assert.equal(document.getElementById("fill-details").disabled, false);
  assert.equal(document.getElementById("scan-error").hidden, false);
  await document.getElementById("fill-details").onclick();
  await tick();
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, attachmentIds);
  assert.deepEqual(calls, ["documents", "documents"]);
});
test("reopening after a failed form load reuses the uploaded pages", async () => {
  const { ctx, cache, calls } = setup({ files: selectedFiles(), attachmentIds: [] });
  const load = ctx.drafts.load;
  ctx.drafts.load = async (key) => {
    if (key === "invoice") throw new DOMException("closed", "InvalidStateError");
    return load(key);
  };
  await scanDialog(ctx);
  await document.getElementById("fill-details").onclick();
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds);
  ctx.drafts.load = load;
  await scanDialog(ctx);
  await document.getElementById("fill-details").onclick();
  await tick();
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, attachmentIds);
  assert.deepEqual(calls, ["documents"]);
});
test("without a photograph the same questions open and nothing is uploaded", async () => {
  const { ctx, calls } = setup({ files: [], attachmentIds: [] });
  await scanDialog(ctx);
  assert.equal(document.getElementById("fill-details").textContent, "מלא פרטים בלי צילום");
  await document.getElementById("fill-details").onclick();
  assert.ok(document.getElementById("invoice-form"));
  assert.equal(questionTitle(), "מי הספק?");
  assert.deepEqual(calls, []);
});
test("an upload finishing after the scan view is removed does not reopen an invoice", async () => {
  const { ctx, cache } = setup({ files: selectedFiles(), attachmentIds: [] });
  let completeUpload;
  ctx.api.request = async () => new Promise((resolve) => { completeUpload = resolve; });
  await scanDialog(ctx);
  const continuing = document.getElementById("fill-details").onclick();
  document.getElementById("modal").replaceChildren();
  completeUpload({ documents: attachmentIds.map((id) => ({ id })) });
  await continuing;
  assert.equal(document.getElementById("invoice-form"), null);
  assert.equal(cache.has("invoice"), false);
});
test("a draft left over from the reading days still opens as pages to photograph and fill", async () => {
  const { ctx, calls } = setup({
    files: selectedFiles(), attachmentIds, jobId: "old-job", status: "completed",
    result: { id: "old-job", status: "completed", result: { supplierName: "ספק בדיקה" } },
  });
  await scanDialog(ctx, { resume: true });
  assert.equal(document.getElementById("invoice-form"), null, "an old reading is not opened for review");
  assert.equal(document.getElementById("fill-details").disabled, false);
  await document.getElementById("fill-details").onclick();
  await tick();
  assert.equal(questionTitle(), "מי הספק?");
  assert.deepEqual(calls, [], "pages that were already uploaded are not uploaded again");
});
