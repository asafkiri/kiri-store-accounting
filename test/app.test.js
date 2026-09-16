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
    "./export.js": "export const invoiceCsv=()=>'',cashCsv=()=>'',canShareFiles=()=>false,shareFiles=async(...args)=>globalThis.appTestSdk.share?.(...args),download=async(...args)=>globalThis.appTestSdk.download?.(...args);",
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
  assert.ok(document.querySelector('[data-action="detail"][data-id="persisted-001"]'));
  assert.match(document.body.textContent, /10\.09\.2026/);
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
  assert.match(document.getElementById("modal").textContent, /צילום החשבונית/);
  await tick();
  assert.ok(document.querySelector('[data-invoice-photo] img[src^="blob:"]'));
  document.querySelector("[data-photo-open]").click();
  await tick();
  const request = requests.find(request => request.path === "documents/" + id);
  assert.equal(request.options.blob, true);
  assert.ok(document.querySelector('.preview-dialog img[src^="blob:"]'));
  document.querySelector(".preview-dialog").onclose();
  document.querySelector("[data-close-modal]").click();
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
  document.querySelector('[data-action="detail"]').click();
  await tick();
  document.querySelector('[data-photo-open]').click();
  await tick();
  assert.equal(document.querySelector("#modal").open, true);
  assert.ok(document.querySelector('.preview-dialog img[src^="blob:"]'));
  assert.equal(requests.filter(r => r.path === "documents/" + id).length, 1);
  assert.equal(requests.some(r => r.path.includes("scan-invoice")), false);
  document.querySelector(".preview-dialog").onclose();
  document.querySelector("[data-close-modal]").click();
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
  const status = document.querySelector('[name="status"]'); status.value = 'paid'; status.dispatchEvent(new Event('change'));
  document.querySelector('[data-action="folder-month"][data-value="2026-09"]').click();
  document.querySelector('[data-action="folder-supplier"]').click();
  document.querySelector('[data-action="folder-back"]').click();
  await tick();
  assert.equal(document.querySelector('[name="status"]').value, 'paid');
  assert.equal(document.querySelectorAll('.invoice-card').length, 0);
  const month = document.querySelector('[name="month"]'); month.value = '2026-08'; month.dispatchEvent(new Event('change'));
  assert.equal(document.querySelectorAll('.month-folder').length, 1);
  assert.equal(document.querySelector('.month-folder').dataset.value, '2026-08');
  assert.equal(document.querySelector('[data-action="folder-back"]'), null);
});

// One page of one invoice, moved to the recycle bin. The photo screens are the only
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
  document.querySelector('[data-route="documents"]').click();
  document.querySelector('[data-action="folder-month"]').click();
  document.querySelector('[data-action="folder-supplier"]').click();
  document.querySelector('[data-action="documents"]').click();
  return { pages, requests, modal: document.querySelector("#modal") };
}

test("deleting a photo calls the versioned file endpoint and refreshes the photo list", async t => {
  const { pages, requests, modal } = await photoWorkspace(t);
  assert.equal(modal.querySelectorAll("[data-delete-document]").length, 2);
  assert.match(modal.textContent, /נמחק מהמערכת ומהאחסון אוטומטית כעבור שנה/);
  modal.querySelector(`[data-delete-document="${pages[0]}"]`).click();
  await tick();
  const call = requests.find(r => r.method === "DELETE");
  assert.equal(call.path, "invoices/photo-invoice/documents/" + pages[0]);
  assert.equal(call.body.expectedVersion, 4);
  assert.ok(call.body.mutationId);
  assert.equal(call.body.data, undefined);
  assert.match(document.querySelector("#toast").textContent, /הועבר לסל המחזור/);
  const left = modal.querySelectorAll("[data-delete-document]");
  assert.equal(left.length, 1, "the deleted page must leave the list");
  assert.equal(left[0].dataset.deleteDocument, pages[1]);
  assert.equal(modal.querySelectorAll(`[data-open-document="${pages[0]}"]`).length, 0);
});

test("photo recycling is reported clearly, and a refused deletion keeps the page", async t => {
  const shared = await photoWorkspace(t, { fileDeleted: false });
  shared.modal.querySelector("[data-delete-document]").click();
  await tick();
  assert.match(document.querySelector("#toast").textContent, /סל המחזור/);
  assert.match(document.querySelector("#toast").textContent, /30 יום/);
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
  assert.match(modal.textContent, /צילום החשבונית/);
  assert.equal(modal.querySelectorAll("[data-delete-document]").length, 2);
  assert.match(modal.textContent, /נמחק מהמערכת ומהאחסון אוטומטית כעבור שנה/);
});

// The father's report: he opens a supplier, leaves for Home, comes back — the
// app resumes inside that supplier — and then "חזרה לספקים" dropped him on Home
// instead, so tapping the section again put him right back inside the supplier.
// The level above was never in the history behind that screen.
const FOLDER_DATA = {
  full: true, version: 1, dailyCash: [],
  suppliers: [{ id: "s1", name: "גלוברנס" }, { id: "s2", name: "תנובה" }],
  invoices: ["s1", "s2"].map((supplierId, n) => ({
    id: "inv-" + n, supplierId, documentNumber: "D" + n, documentType: "invoice",
    invoiceDate: "2026-09-0" + (n + 1), status: "unpaid", finalAgorot: 100,
    deductions: [], attachmentIds: ["page-" + n],
  })),
};
const folderLevel = () =>
  document.querySelectorAll(".supplier-folder").length ? "suppliers"
    : document.querySelectorAll(".month-folder").length ? "months"
      : document.querySelectorAll('[data-action="detail"],[data-action="documents"]').length ? "one supplier"
        : document.querySelector('[data-route="invoices"]') ? "home" : "elsewhere";

for (const route of ["invoices", "documents"]) {
  test(`${route}: the button that says "חזרה לספקים" reaches the suppliers, even on a folder the app resumed`, async t => {
    await setup(t, { request: async path => path === "me" ? { uid: "owner" } : FOLDER_DATA });
    await globalThis.appAuthCallback({});
    document.querySelector(`[data-route="${route}"]`).click(); await tick();
    document.querySelector('[data-action="folder-month"]').click(); await tick();
    document.querySelector('[data-action="folder-supplier"]').click(); await tick();
    assert.equal(folderLevel(), "one supplier");
    document.querySelector('.sidebar [data-route="home"]').click(); await tick();
    document.querySelector(`[data-route="${route}"]`).click(); await tick();
    assert.equal(folderLevel(), "one supplier", "the section resumes where he left it");
    assert.match(document.querySelector(".app-back").textContent, /חזרה לספקים/);
    document.querySelector(".app-back").click(); await tick(); await tick();
    assert.equal(folderLevel(), "suppliers", "and Back climbs one level instead of leaving the section");
    document.querySelector(".app-back").click(); await tick(); await tick();
    assert.equal(folderLevel(), "months");
  });
}

test("walking into a folder by hand still unwinds through the history it built", async t => {
  await setup(t, { request: async path => path === "me" ? { uid: "owner" } : FOLDER_DATA });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="invoices"]').click(); await tick();
  document.querySelector('[data-action="folder-month"]').click(); await tick();
  document.querySelector('[data-action="folder-supplier"]').click(); await tick();
  document.querySelector(".app-back").click(); await tick(); await tick();
  assert.equal(folderLevel(), "suppliers");
  document.querySelector(".app-back").click(); await tick(); await tick();
  assert.equal(folderLevel(), "months");
  // Nothing was rewritten: the phone's own forward gesture still finds the
  // levels he walked through.
  window.history.forward(); await tick(); await tick();
  assert.equal(folderLevel(), "suppliers");
});

// Standing in a supplier's folder already answers the intake's first question.
const SUPPLIER_FOLDER_DATA = {
  full: true, version: 1, dailyCash: [],
  suppliers: [{ id: "s1", name: "תנובה", active: true }, { id: "s2", name: "גלוברנס", active: true }],
  invoices: [{
    id: "a", supplierId: "s1", documentNumber: "A", documentType: "invoice",
    invoiceDate: "2026-09-01", status: "unpaid", finalAgorot: 100, totalAgorot: 100,
    deductions: [], attachmentIds: ["page-a"],
  }],
};
for (const route of ["invoices", "documents"]) {
  test(`${route}: a supplier folder opens the camera for that supplier, and the questions skip past it`, async t => {
    await setup(t, { request: async path => path === "me" ? { uid: "owner" } : SUPPLIER_FOLDER_DATA });
    await globalThis.appAuthCallback({});
    document.querySelector(`[data-route="${route}"]`).click(); await tick();
    document.querySelector('[data-action="folder-month"]').click(); await tick();
    assert.equal(document.querySelector(".folder-add"), null, "the month has no one supplier to add for");
    document.querySelector('[data-action="folder-supplier"]').click(); await tick();
    const add = document.querySelector(".folder-add");
    assert.match(add.textContent, /צלם חשבונית לתנובה/);
    assert.equal(add.dataset.supplier, "s1");
    add.click(); await tick(); await tick();
    document.querySelector("#fill-details").click(); await tick(); await tick(); await tick();
    assert.match(document.querySelector(".quick-question h3").textContent, /מה הסכום כולל מע״מ/,
      "the supplier is already known, so the first question is the amount");
    assert.match(document.querySelector(".quick-progress span").textContent, /שאלה 2 מתוך 4/);
    // Not merely a skipped question: the full editor shows the supplier filled in.
    document.querySelector("[data-full-invoice]").click(); await tick(); await tick();
    assert.equal(document.querySelector("#invoice-form").elements.supplierId.value, "s1");
    assert.equal(document.querySelector("#invoice-form").elements.supplierName.value, "תנובה");
  });
}

test("a supplier in the recycle bin is not offered new invoices", async t => {
  const deleted = {
    ...SUPPLIER_FOLDER_DATA,
    suppliers: [{ id: "s1", name: "תנובה", active: false, deletedAt: 1 }, { id: "s2", name: "גלוברנס", active: true }],
  };
  await setup(t, { request: async path => path === "me" ? { uid: "owner" } : deleted });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="invoices"]').click(); await tick();
  document.querySelector('[data-action="folder-month"]').click(); await tick();
  document.querySelector('[data-action="folder-supplier"]').click(); await tick();
  assert.match(document.querySelector("[data-folder-heading]").textContent, /תנובה/, "his history is still readable");
  assert.equal(document.querySelector(".folder-add"), null);
});

// He pays part of last month and part of this one in a single check. Until now
// that meant walking into every month to find what was still open; the supplier
// folder now offers the whole debt on one screen, month by month.
const OWING_DATA = {
  full: true, version: 1, dailyCash: [],
  suppliers: [{ id: "s1", name: "תנובה", active: true }, { id: "s2", name: "גלוברנס", active: true }],
  invoices: [
    ["owe-aug-1", "s1", "2026-08-04", "unpaid", 20000],
    ["owe-aug-2", "s1", "2026-08-19", "unpaid", 23500],
    ["owe-sep-1", "s1", "2026-09-08", "unpaid", 125400],
    ["paid-sep", "s1", "2026-09-02", "paid", 5000],
    ["other-sep", "s2", "2026-09-05", "unpaid", 700],
  ].map(([id, supplierId, invoiceDate, status, finalAgorot]) => ({
    id, supplierId, invoiceDate, status, finalAgorot, totalAgorot: finalAgorot,
    documentNumber: id.toUpperCase(), documentType: "invoice", version: 1, deductions: [], attachmentIds: [],
  })),
};
const owingEntry = () => document.querySelector(".folder-open-supplier");
async function intoSupplier(t, data = OWING_DATA, month = "2026-09") {
  await setup(t, { request: async path => path === "me" ? { uid: "owner" } : data });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-route="invoices"]').click(); await tick();
  document.querySelector(`[data-action="folder-month"][data-value="${month}"]`).click(); await tick();
  document.querySelector('[data-action="folder-supplier"][data-value="s1"]').click(); await tick();
}

test("a supplier folder opens everything still owed to him, grouped month by month", async t => {
  await intoSupplier(t);
  const entry = owingEntry();
  assert.match(entry.textContent, /כל מה שעוד לא שולם לתנובה/);
  assert.match(entry.textContent, /3 חשבוניות/, "the two open from August count with September's");
  assert.match(entry.textContent, /1,689\.00/);
  entry.click(); await tick();
  assert.match(document.querySelector("[data-folder-heading]").textContent, /תנובה/);
  assert.match(document.querySelector(".folder-location p").textContent, /כל מה שעוד לא שולם · כל החודשים/);
  const months = [...document.querySelectorAll(".month-section-heading")].map(h => h.textContent);
  assert.equal(months.length, 2, "one heading per month, so the sets are visible before he starts ticking");
  assert.match(months[0], /אוגוסט 2026/, "oldest first, the order the payment screen puts them in");
  assert.match(months[0], /2 חשבוניות · .*435\.00/);
  assert.match(months[1], /ספטמבר 2026/);
  assert.match(months[1], /חשבונית אחת · .*1,254\.00/);
  const rows = [...document.querySelectorAll(".invoice-card .supplier-name")].map(el => el.textContent);
  assert.deepEqual(rows, ["04.08.2026", "19.08.2026", "08.09.2026"],
    "every row is his, so the date is the headline rather than the name repeated three times");
  assert.equal(document.querySelectorAll('[data-action="detail"][data-id="paid-sep"]').length, 0, "what he already paid stays out");
  assert.equal(document.querySelectorAll('[data-action="detail"][data-id="other-sep"]').length, 0, "and so does another supplier's");
});

test("Back out of the open-invoices screen returns to the supplier folder he came from", async t => {
  await intoSupplier(t);
  owingEntry().click(); await tick();
  assert.match(document.querySelector(".app-back").textContent, /חזור/);
  document.querySelector(".app-back").click(); await tick(); await tick();
  assert.equal(folderLevel(), "one supplier");
  assert.ok(owingEntry(), "back inside the month's folder, with the way to the whole debt still offered");
});

test("a supplier with nothing open is offered no such screen", async t => {
  const settled = {
    ...OWING_DATA,
    invoices: OWING_DATA.invoices.map(i => i.supplierId === "s1" ? { ...i, status: "paid" } : i),
  };
  await intoSupplier(t, settled);
  assert.equal(owingEntry(), null);
  assert.equal(document.querySelector('[data-action="folder-month"]'), null, "still inside the folder, just without the offer");
});

test("paying from the open-invoices screen offers one month at a time, and that month only", async t => {
  await intoSupplier(t);
  owingEntry().click(); await tick();
  const pay = document.querySelector('[data-action="batch-payment"]');
  assert.equal(pay.dataset.id, "s1", "the payment button knows whose screen this is");
  pay.click(); await tick();
  const form = document.querySelector("#modal .batch-payment-form");
  const headings = [...form.querySelectorAll(".batch-month-heading")].map(el => el.textContent);
  assert.match(headings[0], /אוגוסט 2026/);
  assert.match(headings[1], /ספטמבר 2026/);
  const august = form.querySelector('[data-select-month="2026-08"]');
  august.click(); await tick();
  const checked = [...form.querySelectorAll('[name="invoiceSelection"]:checked')].map(el => el.value);
  assert.deepEqual(checked, ["owe-aug-1", "owe-aug-2"], "the whole of August, and nothing from September");
  assert.match(form.querySelector("[data-batch-total]").textContent, /2 חשבוניות · .*435\.00/);
  // The mix he actually pays: all of last month plus one from this one.
  form.querySelector('[name="invoiceSelection"][value="owe-sep-1"]').click(); await tick();
  assert.match(form.querySelector("[data-batch-total]").textContent, /3 חשבוניות · .*1,689\.00/);
  august.click(); await tick();
  assert.deepEqual([...form.querySelectorAll('[name="invoiceSelection"]:checked')].map(el => el.value), ["owe-sep-1"],
    "tapping the month again clears exactly what it added");
});

test("the camera opened from Home still asks who the supplier is", async t => {
  await setup(t, { request: async path => path === "me" ? { uid: "owner" } : SUPPLIER_FOLDER_DATA });
  await globalThis.appAuthCallback({});
  document.querySelector('[data-action="scan"]').click(); await tick(); await tick();
  document.querySelector("#fill-details").click(); await tick(); await tick(); await tick();
  assert.match(document.querySelector(".quick-question h3").textContent, /מי הספק/);
  assert.match(document.querySelector(".quick-progress span").textContent, /שאלה 1 מתוך 4/);
});
