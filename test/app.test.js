import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { loadModule } from "./load-module.mjs";
const tick = () => new Promise((r) => setTimeout(r, 20));
async function setup(t, sdk = {}) {
  const dom = new JSDOM(
    '<div id="app"></div><dialog id="modal"></dialog><div id="toast"></div>',
    { url: "https://unit.example" },
  );
  t.after(() => dom.window.close());
  for (const k of ["window", "document", "Event", "FormData"])
    globalThis[k] = dom.window[k];
  dom.window.scrollTo = () => {};
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  globalThis.appTestSdk = {
    initializeAuth: async () => ({}),
    request: async () => ({ uid: "owner-test" }),
    drafts: new Map(),
    ...sdk,
  };
  await loadModule("src/app.js", {
    "./auth.js":
      'export const {initializeAuth,sendCode}=globalThis.appTestSdk; export const onAuthStateChanged=(_auth,fn)=>{globalThis.appAuthCallback=fn;}, signOut=async()=>{}; export {authMessage} from "' +
      resolveAuthPath() +
      '";',
    "./export.js": "export const invoiceCsv=()=>'',cashCsv=()=>'',download=async(...args)=>globalThis.appTestSdk.download?.(...args);",
    "./api.js":
      "export class Api { request(...args) { return globalThis.appTestSdk.request(...args); } save(pending) { return this.request(pending.path, { method: pending.method, body: pending.body }); } } export class ApiError extends Error {} export const pendingMutation=(path,data,expectedVersion=0,method='PUT',extra={})=>({path,method,body:{expectedVersion,mutationId:'test-mutation-'+path,...(data?{data}:{}),...extra}});",
    "./drafts.js":
      "export class Drafts { async open(){} async names(){if(globalThis.appTestSdk.namesError)throw globalThis.appTestSdk.namesError;return [...globalThis.appTestSdk.drafts.keys()];} async load(k){return globalThis.appTestSdk.drafts.get(k);} async save(k,v){globalThis.appTestSdk.drafts.set(k,structuredClone(v));} async remove(k){globalThis.appTestSdk.drafts.delete(k);} }",
  });
  await tick();
}
function resolveAuthPath() {
  return new URL("../src/auth.js", import.meta.url).pathname;
}
test("restoring navigation does not steal focus after the user starts searching", async t => {
  await setup(t);
  await globalThis.appAuthCallback({});
  const frames = [];
  window.requestAnimationFrame = callback => frames.push(callback);
  document.querySelector('[data-route="more"]').click();
  document.querySelector('[data-route="checks"]').click();
  const search = document.querySelector("#check-search");
  search.focus();
  for (const callback of frames) callback();
  assert.equal(document.activeElement, search, "a navigation frame must leave the active search field focused");
});
test("startup hides native browser diagnostics", async (t) => {
  await setup(t, {
    initializeAuth: async () => {
      throw Error("Load failed");
    },
  });
  assert.match(document.body.textContent, /טעינת המערכת לא הושלמה/);
  assert.doesNotMatch(document.body.textContent, /Load failed/);
});
test("archived stale drafts remain readable without changing the current record", async (t) => {
  const key = "saved-invoice-invoice-old";
  const drafts = new Map([
    [
      key,
      {
        kind: "invoice",
        recordId: "invoice-old",
        version: 1,
        fields: { documentNumber: "ABC", notes: "הערה ישנה שנשמרה" },
      },
    ],
  ]);
  await setup(t, {
    drafts,
    request: async (path) =>
      path === "me"
        ? { uid: "owner" }
        : {
            full: true,
            version: 2,
            suppliers: [],
            invoices: [
              {
                id: "invoice-old",
                version: 2,
                status: "paid",
                finalAgorot: 100,
                invoiceDate: "2026-09-10",
              },
            ],
            dailyCash: [],
          },
  });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="more"]').click();
  document.querySelector('[data-route="settings"]').click();
  document.querySelector('[data-key="' + key + '"]').click();
  await tick();
  assert.match(
    document.getElementById("modal").textContent,
    /הערה ישנה שנשמרה/,
  );
  assert.equal(drafts.has(key), true);
  assert.equal(drafts.has("invoice"), false);
});
test("failed SMS exposes restart and allows the next send from the login screen", async (t) => {
  let calls = 0;
  await setup(t, {
    sendCode: async () => {
      if (++calls === 1) throw Error("reCAPTCHA error");
      return { confirmation: { confirm: async () => {} }, clear() {} };
    },
  });
  await globalThis.appAuthCallback(null);
  document.getElementById("phone").value = "0500000000";
  const form = document.getElementById("login-form");
  await form.onsubmit({ preventDefault() {} });
  assert.equal(document.getElementById("restart-login").hidden, false);
  assert.doesNotMatch(
    document.getElementById("login-error").textContent,
    /reCAPTCHA error/,
  );
  await form.onsubmit({ preventDefault() {} });
  assert.equal(document.getElementById("otp-fields").hidden, false);
  assert.equal(calls, 2);
});
test("initial sync failure renders retry, never a false empty list, then loads actual data", async (t) => {
  let failSync;
  await setup(t, {
    request: async (path) => {
      if (path === "me") return { uid: "owner-test" };
      return new Promise((_resolve, reject) => {
        failSync = reject;
      });
    },
  });
  const startup = globalThis.appAuthCallback({});
  await tick();
  assert.match(document.getElementById("main").textContent, /טוען/);
  assert.doesNotMatch(
    document.getElementById("main").textContent,
    /0 חשבוניות|אין כרגע/,
  );
  failSync(Error("Failed to fetch"));
  await startup;
  assert.match(
    document.getElementById("main").textContent,
    /לא התקבל עדכון מהשרת/,
  );
  globalThis.appTestSdk.request = async () => ({
    full: true,
    version: 1,
    suppliers: [],
    invoices: [],
    dailyCash: [],
  });
  document.querySelector('[data-action="refresh"]').click();
  await tick();
  assert.match(
    document.getElementById("main").textContent,
    /מה עושים עכשיו/,
  );
  assert.doesNotMatch(
    document.getElementById("main").textContent,
    /לא התקבל עדכון/,
  );
});


test("successful sync renders server data even when local draft reads fail", async t => {
  await setup(t, {
    namesError: new DOMException("closed", "InvalidStateError"),
    request: async path => path === "me" ? { uid: "owner" } : {
      full: true, version: 5, suppliers: [], dailyCash: [],
      invoices: [{ id: "persisted-001", documentNumber: "SERVER-OK", supplierId: "supplier-test", documentType: "invoice", invoiceDate: "2026-09-10", status: "unpaid", totalAgorot: 1000, finalAgorot: 1000 }],
    },
  });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="invoices"]').click();
  document.querySelector('[data-action="folder-month"]').click();
  document.querySelector('[data-action="folder-supplier"]').click();
  assert.match(document.body.textContent, /SERVER-OK/);
  assert.match(document.body.textContent, /טיוטות במכשיר/);
  assert.doesNotMatch(document.body.textContent, /InvalidStateError|לא התקבל עדכון מהשרת/);
});


test("async export errors reach the Hebrew action error handler", async t => {
  await setup(t, {
    request: async path => path === "me" ? { uid: "owner" } : { full: true, version: 1, invoices: [], suppliers: [], dailyCash: [] },
    download: async () => { throw new DOMException("NotAllowedError", "NotAllowedError"); },
  });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="more"]').click();
  document.querySelector('[data-route="settings"]').click();
  const button = document.querySelector('[data-action="backup"]');
  await document.querySelector("#app").onclick({ target: button });
  assert.match(document.querySelector("#toast").textContent, /הפעולה לא הושלמה/);
  assert.doesNotMatch(document.querySelector("#toast").textContent, /NotAllowedError/);
});

test("saved invoice exposes its attachments and opens the linked file through the API", async t => {
  const id = "a".repeat(64), requests = [];
  await setup(t, {
    request: async (path, options) => {
      requests.push({ path, options });
      if (path === "me") return { uid: "owner" };
      if (path === "documents/" + id) return new Blob(["test photo"], { type: "image/jpeg" });
      return {
        full: true, version: 1, suppliers: [], dailyCash: [],
        invoices: [{ id: "photo-invoice", documentNumber: "PHOTO-1", supplierId: "supplier-test", documentType: "invoice", invoiceDate: "2026-09-10", status: "unpaid", totalAgorot: 1000, finalAgorot: 1000, deductions: [], attachmentIds: [id] }],
      };
    },
  });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="invoices"]').click();
  document.querySelector('[data-action="folder-month"]').click();
  document.querySelector('[data-action="folder-supplier"]').click();
  const card = document.querySelector('[data-action="detail"][data-id="photo-invoice"]');
  assert.match(card.textContent, /מסמך מצורף/);
  card.click();
  assert.match(document.getElementById("modal").textContent, /תמונות ומסמכים מצורפים/);
  document.querySelector("[data-open-document]").click();
  await tick();
  const request = requests.find(request => request.path === "documents/" + id);
  assert.equal(request.options.blob, true);
  assert.ok(document.querySelector('.preview-dialog img[src^="blob:"]'));
  document.querySelector(".preview-dialog").onclose();
});

test("photo archive opens month, supplier, invoice and file without scanning again", async t => {
  const id = "b".repeat(64), requests = [];
  await setup(t, {
    request: async (path, options) => {
      requests.push({ path, options });
      if (path === "me") return { uid: "owner" };
      if (path === "documents/" + id) return new Blob(["photo"], { type: "image/png" });
      return { full: true, version: 1, suppliers: [], dailyCash: [], invoices: [{ id: "archive-invoice", documentNumber: "ARCHIVE", supplierId: "supplier-test", documentType: "invoice", invoiceDate: "2026-09-10", status: "paid", finalAgorot: 100, deductions: [], attachmentIds: [id] }] };
    },
  });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="documents"]').click();
  // Invoices are reached from Home, not from a navigation entry of their own.
  document.querySelector('[data-route="home"]').click();
  document.querySelector('[data-route="invoices"]').click();
  document.querySelector('[data-action="folder-month"]').click();
  document.querySelector('[data-action="folder-supplier"]').click();
  document.querySelector('[data-action="documents"]').click();
  document.querySelector('[data-open-document]').click();
  await tick();
  assert.equal(document.querySelector("#modal").open, true);
  assert.ok(document.querySelector('.preview-dialog img[src^="blob:"]'));
  assert.equal(requests.filter(r => r.path === "documents/" + id).length, 1);
  assert.equal(requests.some(r => r.path.includes("scan-invoice")), false);
  document.querySelector(".preview-dialog").onclose();
});

test("folder back retains status, while choosing another period leaves the old folder", async t => {
  await setup(t, { request: async path => path === 'me' ? { uid: 'owner' } : {
    full: true, version: 1, suppliers: [{ id: 's1', name: 'ספק בדיקה' }], dailyCash: [], invoices: [
      { id: 'one', supplierId: 's1', documentNumber: 'ONE', invoiceDate: '2026-09-01', status: 'paid', finalAgorot: 100 },
      { id: 'two', supplierId: 's1', documentNumber: 'TWO', invoiceDate: '2026-08-01', status: 'paid', finalAgorot: 100 },
    ],
  } });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="invoices"]').click();
  document.querySelector('[data-action="status"][data-value="paid"]').click();
  document.querySelector('[data-action="folder-month"][data-value="2026-09"]').click();
  document.querySelector('[data-action="folder-supplier"]').click();
  document.querySelector('[data-action="folder-back"]').click();
  await tick();
  assert.equal(document.querySelector('[data-action="status"][data-value="paid"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelectorAll('.invoice-card').length, 0);
  const month = document.querySelector('[name="month"]'); month.value = '2026-08'; month.dispatchEvent(new Event('change'));
  assert.equal(document.querySelectorAll('.month-folder').length, 1);
  assert.equal(document.querySelector('.month-folder').dataset.value, '2026-08');
  assert.equal(document.querySelector('[data-action="folder-back"]'), null);
});

// One page of one invoice, deleted for real. The photo screens are the only
// place that offers it, so they are the ones under test.
async function photoWorkspace(t, { fileDeleted = true, failWith = null } = {}) {
  const pages = ["a".repeat(64), "b".repeat(64)];
  const requests = [];
  let invoice = {
    id: "photo-invoice", documentNumber: "PH-1", supplierId: "s1", documentType: "invoice",
    invoiceDate: "2026-09-10", status: "unpaid", totalAgorot: 1000, finalAgorot: 1000,
    deductions: [], version: 4, attachmentIds: [...pages],
  };
  await setup(t, {
    request: async (path, options = {}) => {
      requests.push({ path, ...options });
      if (path === "me") return { uid: "owner" };
      if (options.method === "DELETE") {
        if (failWith) throw Object.assign(Error(failWith.message), failWith);
        invoice = { ...invoice, version: invoice.version + 1,
          attachmentIds: invoice.attachmentIds.filter(id => id !== pages[0]) };
        return { record: invoice, fileDeleted, stillUsedBy: fileDeleted ? null : "other-invoice" };
      }
      return { full: true, version: 1, dailyCash: [], settings: [], documentRetentionDays: 365,
        suppliers: [{ id: "s1", name: "ספק לבדיקה", active: true }], invoices: [invoice] };
    },
  });
  globalThis.confirm = () => true;
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="invoices"]').click();
  document.querySelector('[data-action="folder-month"]').click();
  document.querySelector('[data-action="folder-supplier"]').click();
  document.querySelector('[data-action="documents"]').click();
  return { pages, requests, modal: document.querySelector("#modal") };
}

test("deleting a photo calls the versioned file endpoint and refreshes the photo list", async t => {
  const { pages, requests, modal } = await photoWorkspace(t);
  assert.equal(modal.querySelectorAll("[data-delete-document]").length, 2);
  assert.match(modal.textContent, /נמחק מהמערכת ומהאחסון אוטומטית שנה/);
  modal.querySelector(`[data-delete-document="${pages[0]}"]`).click();
  await tick();
  const call = requests.find(r => r.method === "DELETE");
  assert.equal(call.path, "invoices/photo-invoice/documents/" + pages[0]);
  assert.equal(call.body.expectedVersion, 4);
  assert.ok(call.body.mutationId);
  assert.equal(call.body.data, undefined);
  assert.match(document.querySelector("#toast").textContent, /נמחק מהמערכת ומהאחסון/);
  const left = modal.querySelectorAll("[data-delete-document]");
  assert.equal(left.length, 1, "the deleted page must leave the list");
  assert.equal(left[0].dataset.deleteDocument, pages[1]);
  assert.equal(modal.querySelectorAll(`[data-open-document="${pages[0]}"]`).length, 0);
});

test("a photo another invoice still uses is reported as kept, and a refused deletion keeps the page", async t => {
  const shared = await photoWorkspace(t, { fileDeleted: false });
  shared.modal.querySelector("[data-delete-document]").click();
  await tick();
  assert.match(document.querySelector("#toast").textContent, /הוסר מהחשבונית/);
  assert.match(document.querySelector("#toast").textContent, /חשבונית אחרת/);
  const refused = await photoWorkspace(t, {
    failWith: { status: 409, code: "VERSION_CONFLICT", message: "הרשומה עודכנה מאז." },
  });
  refused.modal.querySelector("[data-delete-document]").click();
  await tick();
  assert.match(document.querySelector("#toast").textContent, /עודכנה מאז/);
  assert.equal(refused.modal.querySelectorAll("[data-delete-document]").length, 2,
    "a deletion the server refused must not remove the page from the screen");
});

test("declining the confirmation deletes nothing, and invoice details offers the same button", async t => {
  const { requests, modal } = await photoWorkspace(t);
  globalThis.confirm = () => false;
  modal.querySelector("[data-delete-document]").click();
  await tick();
  assert.equal(requests.some(r => r.method === "DELETE"), false);
  assert.equal(modal.querySelectorAll("[data-delete-document]").length, 2);
  modal.querySelector("[data-invoice-details]").click();
  assert.match(modal.textContent, /תמונות ומסמכים מצורפים/);
  assert.equal(modal.querySelectorAll("[data-delete-document]").length, 2);
  assert.match(modal.textContent, /נמחק מהמערכת ומהאחסון אוטומטית שנה/);
});
