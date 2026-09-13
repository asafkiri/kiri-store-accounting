import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { scanDialog } from "../src/scan.js";
import { uploadScanPages } from "../src/scan-upload.js";
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

test("a photographed invoice opens the typed questions at once, while its pages go up behind them", async () => {
  const { ctx, cache, calls } = setup({ files: selectedFiles(), attachmentIds: [] });
  let completeUpload;
  ctx.api.request = async (path, options) => {
    calls.push({ path, options });
    return new Promise((resolve) => { completeUpload = resolve; });
  };
  await scanDialog(ctx);
  assert.equal(document.getElementById("run-scan"), null, "no scan button exists");
  assert.equal(document.getElementById("check-scan"), null);
  const button = document.getElementById("fill-details");
  assert.equal(button.textContent, "המשך למילוי הפרטים");
  await button.onclick();
  // The questions are answerable while the photograph is still on its way.
  assert.ok(document.getElementById("invoice-form"));
  assert.equal(questionTitle(), "מי הספק?", "the questions start with the supplier");
  assert.match(document.querySelector(".quick-progress span").textContent, /שאלה 1 מתוך 5/);
  assert.equal(calls.length, 1, "one upload and no other request");
  assert.equal(calls[0].path, "documents");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.body.files, selectedFiles());
  assert.deepEqual(cache.get("scan").attachmentIds, [], "nothing is recorded before the server answers");
  assert.ok(document.querySelector("[data-quick-photo]"), "the photograph stays one tap away from the device itself");
  assert.equal(cache.get("invoice").fromScan, true, "the invoice knows it is waiting for pages");
  assert.equal(cache.get("invoice").fields.source, "manual");
  assert.equal("scanJobId" in cache.get("invoice").fields, false, "no reading to point at");
  assert.equal("scan" in cache.get("invoice"), false, "nothing was read");
  completeUpload({ documents: attachmentIds.map((id) => ({ id })) });
  await tick();
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds, "the pages are recorded where they can be found again");
  // Typing anything saves the open draft, which by now carries the pages.
  document.getElementById("invoice-form").dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  assert.deepEqual(cache.get("invoice").fields.attachmentIds, attachmentIds, "the pages reach the open questions");
});
test("pressing continue twice uploads the pages once and opens one set of questions", async () => {
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
  await continuing;
  assert.equal(calls.length, 1, "the pages are sent once");
  assert.equal(calls[0].path, "documents");
  assert.deepEqual(calls[0].options.body.files, files);
  assert.equal(document.querySelectorAll("#invoice-form").length, 1);
  assert.equal(questionTitle(), "מי הספק?");
  completeUpload({ documents: attachmentIds.map((id) => ({ id })) });
  await tick();
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds);
});
test("an upload that fails in the background keeps the photos and is retried on demand", async () => {
  const files = selectedFiles();
  const { ctx, cache, calls } = setup({ files, attachmentIds: [] });
  ctx.api.request = async (path) => {
    calls.push(path);
    if (calls.length === 1) throw new ApiError("אין חיבור לרשת כרגע", "NETWORK", 0);
    return { documents: attachmentIds.map((id) => ({ id })) };
  };
  await scanDialog(ctx);
  await document.getElementById("fill-details").onclick();
  await tick();
  // The failure must not cost the person the photograph or the questions.
  assert.ok(document.getElementById("invoice-form"), "the questions still open");
  assert.deepEqual(cache.get("scan").files, files, "the pages stay in the draft");
  // The next caller of the same queue retries: the open draft first, and the
  // save after it. Nothing is lost, and a page that landed is never resent.
  assert.deepEqual(calls, ["documents", "documents"]);
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds);
  assert.deepEqual(await uploadScanPages(ctx), attachmentIds);
  assert.equal(calls.length, 2);
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
test("pages that land after the screen is gone are kept for the save, not thrown away", async () => {
  const { ctx, cache } = setup({ files: selectedFiles(), attachmentIds: [] });
  let completeUpload;
  ctx.api.request = async () => new Promise((resolve) => { completeUpload = resolve; });
  await scanDialog(ctx);
  const continuing = document.getElementById("fill-details").onclick();
  await continuing;
  document.getElementById("modal").replaceChildren();
  completeUpload({ documents: attachmentIds.map((id) => ({ id })) });
  await tick();
  assert.equal(document.getElementById("invoice-form"), null, "no screen is reopened");
  assert.deepEqual(cache.get("scan").attachmentIds, attachmentIds, "the upload is still worth what it cost");
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
