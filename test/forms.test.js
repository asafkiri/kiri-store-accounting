import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  invoiceForm as openInvoiceForm,
  paymentForm,
  cashForm,
  supplierForm,
} from "../src/forms.js";
import { ApiError } from "../src/api.js";
import { today, totals } from "../src/format.js";
// These tests exercise the retained detailed editor; quick intake has its own
// integration tests for sequential answers, summary approval and recovery.
const invoiceForm = (ctx, record = null, attachments = []) =>
  openInvoiceForm(ctx, record, attachments, { fullEditor: true });
const tick = () => new Promise((r) => setTimeout(r, 20));
function setup() {
  const dom = new JSDOM(
    '<body><div id="modal"></div><div id="toast"></div></body>',
    { url: "https://unit.example" },
  );
  for (const k of ["document", "window", "FormData", "Event"])
    globalThis[k] = dom.window[k];
  globalThis.confirm = () => true;
  const drafts = new Map(),
    saved = [];
  const ctx = {
    data: {
      suppliers: [{ id: "supplier-001", name: "ספק בדיקה", active: true }],
      invoices: [],
      dailyCash: [],
    },
    drafts: {
      load: async (k) => structuredClone(drafts.get(k) || null),
      save: async (k, v) => drafts.set(k, structuredClone(v)),
      remove: async (k) => drafts.delete(k),
    },
    dialog: (title, body) => {
      document.getElementById("modal").innerHTML = body;
      return document.getElementById("modal");
    },
    api: {
      save: async (p) => {
        saved.push(p);
        return {
          record: { id: p.path.split("/")[1], version: 1, ...p.body.data },
        };
      },
    },
    setModalBusy() {},
    closeModal() {},
    mergeRecord() {},
    render() {},
    refresh() {},
    reopen() {},
  };
  return { ctx, drafts, saved };
}
const fill = (name, value) => {
  const input = document.querySelector(`[name="${name}"]`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = () =>
  document
    .querySelector("form")
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
test("manual form and recovery preserve values, unknown VAT and explicit review", async () => {
  const { ctx, drafts, saved } = setup();
  await invoiceForm(ctx);
  fill("supplierId", "supplier-001");
  fill("documentNumber", "A-001");
  fill("total", "123.45");
  fill("final", "123.45");
  fill("notes", "טיוטה לבדיקה");
  await tick();
  assert.equal(drafts.get("invoice").fields.notes, "טיוטה לבדיקה");
  await invoiceForm(ctx);
  assert.equal(document.querySelector("[name=documentNumber]").value, "A-001");
  assert.equal(document.querySelector("[name=vat]").value, "");
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].body.data.totalAgorot, 12345);
  assert.equal(saved[0].body.data.vatAgorot, null);
  assert.equal(saved[0].body.data.reviewConfirmed, true);
  assert.equal(drafts.has("invoice"), false);
});
test("network failure locks original mutation, retains draft, and retries same identity", async () => {
  const { ctx, drafts } = setup();
  const attempts = [];
  ctx.api.save = async (p) => {
    attempts.push(structuredClone(p));
    if (attempts.length === 1) throw new ApiError("ניתוק", "NETWORK", 0);
    return { record: { id: "supplier-001", version: 1 } };
  };
  await supplierForm(ctx);
  fill("name", "ספק חדש");
  submit();
  await tick();
  assert.equal(drafts.has("supplier"), true);
  assert.equal(document.querySelector("[name=name]").disabled, true);
  assert.match(
    document.querySelector("[data-form-error]").textContent,
    /ניתוק/,
  );
  submit();
  await tick();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(drafts.has("supplier"), false);
});
test("cheque form sends handover and due dates separately", async () => {
  const { ctx, saved } = setup();
  await paymentForm(ctx, {
    id: "invoice-001",
    version: 1,
    documentNumber: "a",
    finalAgorot: 500,
    status: "unpaid",
  });
  document.querySelector('[data-payment-method="check"]').click();
  fill("paymentDate", "2026-09-10");
  fill("checkDueDate", "2026-09-30");
  submit();
  await tick();
  assert.equal(saved[0].body.payment.paymentDate, "2026-09-10");
  assert.equal(saved[0].body.payment.checkDueDate, "2026-09-30");
  assert.equal(saved[0].body.payment.method, "check");
});
test("payment choices keep the draft on Back and a lost response reuses the same mutation", async () => {
  const { ctx, drafts } = setup(), attempts = [], confirmations = [];
  ctx.api.save = async pending => {
    attempts.push(structuredClone(pending));
    if (attempts.length === 1) throw new ApiError("אין חיבור לרשת");
    return { record: { id: "invoice-pay", status: "paid", version: 2, payment: pending.body.payment } };
  };
  ctx.showSaved = (kind, record) => confirmations.push({ kind, record });
  const record = { id: "invoice-pay", supplierId: "supplier-001", version: 1, documentNumber: "PAY-1", finalAgorot: 11800, status: "unpaid" };
  await paymentForm(ctx, record);
  document.querySelector('[data-payment-method="check"]').click();
  fill("checkNumber", "000234");
  ctx.modalBack();
  assert.equal(document.querySelector("[data-payment-methods]").hidden, false);
  document.querySelector('[data-payment-method="check"]').click();
  assert.equal(document.querySelector('[name="checkNumber"]').value, "000234");
  submit(); await tick();
  assert.equal(confirmations.length, 0);
  assert.ok(drafts.get("payment").pending);
  await paymentForm(ctx, record);
  assert.equal(document.querySelector('[type="submit"]').hidden, false);
  submit(); await tick();
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(confirmations.length, 1); assert.equal(confirmations[0].kind, "payment");
  assert.equal(drafts.has("payment"), false);
});
test("daily cash form records two independent amounts", async () => {
  const { ctx, saved } = setup();
  await cashForm(ctx);
  fill("cash", "123.45");
  fill("ravKav", "56.78");
  submit();
  await tick();
  assert.equal(saved[0].body.data.cashAgorot, 12345);
  assert.equal(saved[0].body.data.ravKavAgorot, 5678);
});

for (const version of [0, 2]) {
  test(`a previous day's cash draft (version ${version}) cannot replace today's closing`, async () => {
    const { ctx, drafts, saved } = setup();
    const oldDate = "2026-09-09";
    assert.notEqual(today(), oldDate);
    const old = {
      recordId: oldDate,
      version,
      fields: { date: oldDate, cash: "999", ravKav: "88", notes: "לא לאבד" },
    };
    drafts.set("cash", old);
    await cashForm(ctx);
    assert.equal(document.querySelector("[name=date]").value, today());
    assert.equal(document.querySelector("[name=date]").readOnly, false);
    assert.equal(document.querySelector("[name=cash]").value, "");
    assert.equal(document.querySelector("[name=ravKav]").value, "");
    assert.equal(drafts.get("saved-cash-" + oldDate).fields.notes, "לא לאבד");
    fill("cash", "120");
    fill("ravKav", "30");
    submit();
    await tick();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].path, "daily-cash/" + today());
    assert.equal(saved[0].body.expectedVersion, 0);
  });
}
test("cash edits archive stale values, while explicit resume can recover an unsaved past date", async () => {
  const { ctx, drafts } = setup();
  const date = "2026-09-09";
  const record = {
    id: date,
    date,
    version: 2,
    cashAgorot: 20000,
    ravKavAgorot: 1500,
    notes: "עדכני",
  };
  drafts.set("cash", {
    recordId: date,
    version: 1,
    fields: { date, cash: "90", ravKav: "5", notes: "ישן" },
  });
  await cashForm(ctx, record);
  assert.equal(document.querySelector("[name=cash]").value, "200.00");
  assert.equal(drafts.has("cash"), false);
  assert.equal(drafts.get("saved-cash-" + date).fields.notes, "ישן");
  drafts.set("cash", {
    recordId: date,
    version: 0,
    fields: { date, cash: "45.00", ravKav: "6.00", notes: "השלמה" },
  });
  await cashForm(ctx, null, date);
  assert.equal(document.querySelector("[name=date]").value, date);
  assert.equal(document.querySelector("[name=cash]").value, "45.00");
});
test("changing the date of an unsaved cash draft updates its identity before reopening daily close", async () => {
  const { ctx, drafts } = setup();
  await cashForm(ctx);
  fill("date", "2026-09-09");
  fill("cash", "45");
  await tick();
  assert.equal(drafts.get("cash").recordId, "2026-09-09");
  await cashForm(ctx);
  assert.equal(document.querySelector("[name=date]").value, today());
  assert.equal(document.querySelector("[name=cash]").value, "");
});

test("version conflict recovery survives reload and does not silently overwrite the draft", async () => {
  const { ctx, drafts } = setup();
  ctx.api.save = async () => {
    throw new ApiError("גרסה ישנה", "VERSION_CONFLICT", 409);
  };
  const record = {
    id: "supplier-001",
    version: 1,
    name: "ספק בדיקה",
    contact: "",
    notes: "",
    active: true,
  };
  await supplierForm(ctx, record);
  fill("notes", "הערה שלא תידרס");
  submit();
  await tick();
  assert.equal(drafts.get("supplier").conflict, true);
  await supplierForm(ctx, record);
  assert.equal(document.querySelector("[data-form-error]").hidden, false);
  assert.match(
    document.querySelector("[data-safe-action]").textContent,
    /טען את העדכון/,
  );
  assert.equal(document.querySelector("[name=notes]").value, "הערה שלא תידרס");
});

const existingInvoice = () => ({
  id: "invoice-existing",
  version: 1,
  supplierId: "supplier-001",
  documentNumber: "old",
  invoiceDate: "2026-09-10",
  documentType: "invoice",
  subtotalAgorot: null,
  vatAgorot: null,
  totalAgorot: 100,
  finalAgorot: 100,
  deductions: [],
  attachmentIds: [],
  source: "manual",
  notes: "original",
});
for (const kind of ["invoice", "supplier"]) {
  test(`${kind}: Add never adopts an abandoned edit, including a legacy draft`, async () => {
    const { ctx, drafts, saved } = setup();
    const record =
      kind === "invoice"
        ? existingInvoice()
        : {
            id: "supplier-existing",
            version: 1,
            name: "existing",
            active: true,
          };
    ctx.data[kind === "invoice" ? "invoices" : "suppliers"].push(record);
    const open = kind === "invoice" ? invoiceForm : supplierForm;
    await open(ctx, record);
    fill("notes", "abandoned edit");
    await tick();
    delete drafts.get(kind).mode; // Upgrade safety for drafts from the previous version.
    await open(ctx);
    assert.equal(drafts.has(kind), false, "merely opening Add does not create work");
    fill("notes", "new record");
    await tick();
    assert.notEqual(drafts.get(kind).recordId, record.id);
    assert.equal(drafts.get(kind).version, 0);
    assert.equal(drafts.get(kind).mode, "new");
    assert.equal(
      drafts.get(`saved-${kind}-${record.id}`).fields.notes,
      "abandoned edit",
    );
    if (kind === "invoice") {
      fill("supplierId", "supplier-001");
      fill("documentNumber", "new");
      fill("total", "2");
      fill("final", "2");
      document.querySelector("[name=review]").checked = true;
    } else fill("name", "new supplier");
    submit();
    await tick();
    assert.equal(saved.length, 1);
    assert.notEqual(saved[0].path.split("/")[1], record.id);
    assert.equal(saved[0].body.expectedVersion, 0);
  });
}
test("reopening stale fields archives them and opens the current version without overwriting newer data", async () => {
  const { ctx, drafts, saved } = setup();
  const old = existingInvoice();
  await invoiceForm(ctx, old);
  fill("notes", "abandoned edit");
  await tick();
  const current = {
    ...old,
    version: 2,
    notes: "newer saved note",
    totalAgorot: 200,
    finalAgorot: 200,
  };
  ctx.data.invoices = [current];
  await invoiceForm(ctx, current);
  assert.equal(drafts.has("invoice"), false);
  assert.equal(
    document.querySelector("[name=notes]").value,
    "newer saved note",
  );
  assert.equal(
    drafts.get("saved-invoice-" + old.id).fields.notes,
    "abandoned edit",
  );
  assert.match(document.body.textContent, /הרשומה עודכנה/);
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(saved[0].body.data.totalAgorot, 200);
});
test("an ambiguous pending save keeps its exact mutation when a newer record is available", async () => {
  const { ctx, drafts } = setup();
  const record = existingInvoice();
  ctx.api.save = async () => {
    throw new ApiError("ניתוק", "NETWORK", 0);
  };
  await invoiceForm(ctx, record);
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  const pending = structuredClone(drafts.get("invoice").pending);
  await invoiceForm(ctx, { ...record, version: 2 });
  assert.deepEqual(drafts.get("invoice").pending, pending);
});
// The detailed editor opened by hand, with the supplier name typed into the
// picker exactly as it would be from the paper.
const typedSupplier = async (ctx, name) => {
  await invoiceForm(ctx);
  fill("supplierName", name);
  fill("documentNumber", "new-1001");
  fill("total", "12");
  fill("final", "12");
};
const supplierAction = (name) =>
  document.querySelector(`[data-supplier-action="${name}"]`);

test("changing a pending supplier clears its stale option and choosing an existing one cancels creation", async () => {
  const { ctx, drafts, saved } = setup();
  await typedSupplier(ctx, "שם חדש");
  supplierAction("create").click();
  await tick();
  const oldId = drafts.get("invoice").newSupplier.id;
  fill("supplierId", "supplier-001");
  await tick();
  assert.equal(drafts.get("invoice").newSupplier, undefined);
  assert.equal(
    document.querySelector(`[name=supplierId] option[value="${oldId}"]`),
    null,
  );
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(saved[0].body.data.supplierId, "supplier-001");
  assert.equal(saved[0].body.data.newSupplier, undefined);
});

test("failed conflict lookup keeps fields and allows an explicit lookup retry without another write", async () => {
  const { ctx, drafts } = setup();
  let writes = 0,
    reads = 0;
  const existing = {
    id: "existing-after-race",
    name: "מרינה",
    active: false,
    version: 1,
  };
  ctx.api.save = async () => {
    writes++;
    const err = new ApiError("כבר קיים ספק", "SUPPLIER_EXISTS", 409);
    err.details = { supplierId: existing.id };
    throw err;
  };
  ctx.api.request = async () => {
    reads++;
    if (reads === 1) throw new ApiError("לא התקבלה תשובה מהשרת.", "NETWORK", 0);
    return existing;
  };
  ctx.mergeRecord = (record) => ctx.data.suppliers.push(record);
  await typedSupplier(ctx, "מרינה");
  supplierAction("create").click();
  fill("notes", "נשאר גם בניתוק");
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(drafts.get("invoice").fields.notes, "נשאר גם בניתוק");
  assert.equal(drafts.get("invoice").newSupplier, undefined);
  assert.ok(supplierAction("lookup"));
  supplierAction("lookup").click();
  await tick();
  assert.ok(supplierAction("reactivate"));
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test("unknown scanned supplier is editable, stays pending through refresh, and saves only with invoice review", async () => {
  const { ctx, drafts, saved } = setup();
  const merged = [];
  ctx.mergeRecord = (record, path) => merged.push({ record, path });
  ctx.api.save = async (p) => {
    saved.push(p);
    return {
      record: { id: p.path.split("/")[1], supplierId: p.body.data.supplierId },
      supplierAction: "created",
      relatedRecords: [
        {
          path: "suppliers/" + p.body.data.supplierId,
          record: {
            id: p.body.data.supplierId,
            name: p.body.data.newSupplier.name,
            active: true,
            createdBy: "owner",
          },
        },
      ],
    };
  };
  await typedSupplier(ctx, "מרינה");
  assert.match(document.body.textContent, /ספק חדש: מרינה/);
  assert.equal(document.querySelector("[name=supplierName]").value, "מרינה");
  assert.equal(saved.length, 0);
  fill("supplierName", "מרינה סניף בדיקה");
  supplierAction("create").click();
  await tick();
  const pendingSupplier = drafts.get("invoice").newSupplier;
  assert.equal(pendingSupplier.name, "מרינה סניף בדיקה");
  assert.equal(saved.length, 0);
  await invoiceForm(ctx);
  assert.deepEqual(drafts.get("invoice").newSupplier, pendingSupplier);
  assert.equal(
    document.querySelector("[name=supplierId]").value,
    pendingSupplier.id,
  );
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path.startsWith("invoices/"), true);
  assert.deepEqual(saved[0].body.data.newSupplier, {
    name: pendingSupplier.name,
    taxIds: [],
  });
  assert.equal(saved[0].body.data.supplierId, pendingSupplier.id);
  assert.ok(merged.find((r) => r.path === "suppliers/" + pendingSupplier.id));
  assert.match(
    document.querySelector("#toast").textContent,
    /נפתח ספק חדש: מרינה סניף בדיקה/,
  );
});

test("normalized match needs explicit confirmation; rejecting it asks for a distinct name", async () => {
  const { ctx, drafts, saved } = setup();
  ctx.data.suppliers = [
    { id: "supplier-marina", name: "מרינה בע״מ", active: true, version: 1 },
  ];
  await typedSupplier(ctx, "מרינה");
  assert.equal(document.querySelector("[name=supplierId]").value, "");
  assert.match(document.body.textContent, /זה הספק.*מרינה בע״מ.*שכבר קיים/);
  assert.equal(supplierAction("create"), null);
  supplierAction("reject").click();
  assert.equal(saved.length, 0);
  assert.match(document.body.textContent, /שם שמבדיל/);
  fill("supplierName", "מרינה");
  supplierAction("confirm").click();
  await tick();
  assert.equal(
    document.querySelector("[name=supplierId]").value,
    "supplier-marina",
  );
  assert.equal(drafts.get("invoice").newSupplier, undefined);
});

test("inactive supplier offers reactivation inside the invoice and does not immediately write", async () => {
  const { ctx, drafts, saved } = setup();
  ctx.data.suppliers = [
    { id: "supplier-marina", name: "מרינה", active: false, version: 3 },
  ];
  await typedSupplier(ctx, "מרינה");
  assert.equal(document.querySelector("[name=supplierId]").value, "");
  assert.match(document.body.textContent, /סומן כלא פעיל.*להפעיל אותו מחדש/);
  supplierAction("reactivate").click();
  await tick();
  assert.equal(saved.length, 0);
  assert.deepEqual(drafts.get("invoice").reactivateSupplier, {
    id: "supplier-marina",
    expectedVersion: 3,
  });
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.deepEqual(saved[0].body.data.reactivateSupplier, {
    expectedVersion: 3,
  });
  assert.equal(saved[0].body.data.newSupplier, undefined);
});

test("canceling review leaves no supplier on server, even after the inline confirmation", async () => {
  const { ctx, drafts, saved } = setup();
  await typedSupplier(ctx, "חדש לביטול");
  supplierAction("create").click();
  await tick();
  document.querySelector("[data-discard-draft]").click();
  await tick();
  assert.equal(saved.length, 0);
  assert.equal(drafts.has("invoice"), false);
});

test("manual invoice uses the same inline creation flow and never opens another dialog", async () => {
  const { ctx, saved } = setup();
  await invoiceForm(ctx);
  fill("supplierName", "ספק ידני חדש");
  supplierAction("create").click();
  fill("documentNumber", "M-001");
  fill("total", "100");
  fill("final", "100");
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].body.data.source, "manual");
  assert.deepEqual(saved[0].body.data.newSupplier, { name: "ספק ידני חדש", taxIds: [] });
});

test("new supplier save after network loss replays the same invoice mutation and supplier ID after reload", async () => {
  const { ctx, drafts } = setup();
  const attempts = [];
  ctx.api.save = async (p) => {
    attempts.push(structuredClone(p));
    if (attempts.length === 1) throw new ApiError("ניתוק", "NETWORK", 0);
    return { record: { id: p.path.split("/")[1] } };
  };
  await typedSupplier(ctx, "ספק לניתוק");
  supplierAction("create").click();
  document.querySelector("[name=review]").checked = true;
  submit();
  submit();
  await tick();
  assert.equal(attempts.length, 1);
  const supplierId = drafts.get("invoice").newSupplier.id;
  await invoiceForm(ctx);
  assert.equal(document.querySelector("[name=supplierName]").disabled, true);
  submit();
  await tick();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[1].body.data.supplierId, supplierId);
});

test("concurrent supplier conflict preserves invoice fields and offers explicit association to the server record", async () => {
  const { ctx, drafts, saved } = setup();
  const existing = {
    id: "supplier-other-device",
    name: "מרינה בע״מ",
    active: true,
    version: 1,
  };
  ctx.api.request = async (path) => {
    assert.equal(path, "suppliers/" + existing.id);
    return existing;
  };
  ctx.mergeRecord = (record) => {
    if (record.id === existing.id) ctx.data.suppliers = [existing];
  };
  ctx.api.save = async (p) => {
    saved.push(structuredClone(p));
    if (saved.length === 1) {
      const error = new ApiError(
        "כבר קיים ספק בשם הזה.",
        "SUPPLIER_EXISTS",
        409,
      );
      error.details = { supplierId: existing.id };
      throw error;
    }
    return { record: { id: p.path.split("/")[1] } };
  };
  await typedSupplier(ctx, "מרינה");
  supplierAction("create").click();
  fill("notes", "לא לאבד");
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(drafts.get("invoice").pending, null);
  assert.equal(document.querySelector("[name=notes]").value, "לא לאבד");
  assert.equal(document.querySelector("[name=supplierId]").value, "");
  supplierAction("confirm").click();
  submit();
  await tick();
  assert.equal(saved[1].body.data.supplierId, existing.id);
  assert.equal(saved[1].body.data.newSupplier, undefined);
  assert.equal(saved[1].body.data.notes, "לא לאבד");
  assert.notEqual(saved[0].body.mutationId, saved[1].body.mutationId);
});

test("credit entry accepts magnitudes and stores a negative reviewed amount", async () => {
  const { ctx, saved } = setup();
  await typedSupplier(ctx, "ספק בדיקה");
  fill("documentType", "credit");
  assert.equal(document.querySelector("[data-credit-notice]").hidden, false);
  assert.match(document.querySelector("[data-credit-notice]").textContent, /כמספר חיובי/);
  assert.equal(document.querySelector("[name=total]").inputMode, "decimal");
  fill("total", "30"); fill("final", "30");
  document.querySelector("[name=review]").checked = true;
  submit(); await tick();
  assert.equal(saved[0].body.data.finalAgorot, -3000);
  assert.equal(totals([{ ...existingInvoice(), totalAgorot: 10000, finalAgorot: 10000 }, saved[0].body.data]).final, 7000);
  await invoiceForm(ctx, { ...existingInvoice(), documentType: "credit", totalAgorot: -3000, finalAgorot: -3000 });
  assert.equal(document.querySelector("[name=total]").value, "30.00");
});

for (const recovery of [true, false]) test(`server save remains successful after local cleanup fails (reopen=${recovery})`, async () => {
  globalThis.indexedDB = (await import("fake-indexeddb")).indexedDB;
  const { Drafts } = await import("../src/drafts.js");
  const { ctx, saved } = setup();
  const local = new Drafts("save-close-" + recovery);
  ctx.drafts = local;
  const save = ctx.api.save;
  let closed = false, merged;
  ctx.api.save = async pending => {
    const result = await save(pending);
    local.db.close();
    if (!recovery) local.remove = async () => { throw new DOMException("closed", "InvalidStateError"); };
    return result;
  };
  ctx.closeModal = () => { closed = true; };
  ctx.mergeRecord = record => { merged = record; };
  await cashForm(ctx);
  fill("cash", "123");
  submit();
  for (let n = 0; n < 30 && !closed; n++) await tick();
  assert.equal(closed, true);
  assert.equal(saved.length, 1);
  assert.equal(merged.cashAgorot, 12300);
  assert.match(document.querySelector("#toast").textContent, /נשמר בחנות/);
  assert.equal(document.querySelector("[data-form-error]").hidden, true);
  if (!recovery) {
    assert.match(ctx.draftWarning, /השמירה בחנות הושלמה/);
    assert.equal((await local.load("cash")).pending.body.mutationId, saved[0].body.mutationId);
  } else assert.equal(await local.load("cash"), null);
  submit(); await tick(); assert.equal(saved.length, 1);
  local.db.close();
});

test("persistent server failure can be cancelled, edited and saved with a new identity after the server fence", async () => {
  const { ctx, drafts } = setup();
  const writes = [],
    cancelled = [];
  ctx.api.save = async (p) => {
    writes.push(structuredClone(p));
    if (writes.length === 1) throw new ApiError("תקלה בשרת", "INTERNAL", 503);
    return { record: { id: "saved-supplier", ...p.body.data } };
  };
  ctx.api.request = async (path, options) => {
    cancelled.push({ path, options });
    return { status: "cancelled" };
  };
  await supplierForm(ctx);
  fill("name", "ספק לפני תקלה");
  fill("notes", "הערה שנשמרת");
  submit();
  await tick();
  const button = document.querySelector("[data-cancel-attempt]");
  assert.ok(button && !button.hidden && !button.disabled);
  button.click();
  await tick();
  assert.equal(document.querySelector("[name=name]").disabled, false);
  assert.equal(document.querySelector("[name=notes]").value, "הערה שנשמרת");
  assert.equal(drafts.get("supplier").pending, null);
  assert.equal(
    cancelled[0].path,
    "mutations/" + writes[0].body.mutationId + "/cancel",
  );
  assert.equal(cancelled[0].options.body.entity, writes[0].path);
  fill("name", "ספק אחרי תקלה");
  submit();
  await tick();
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0].body.mutationId, writes[1].body.mutationId);
  assert.equal(writes[1].body.data.name, "ספק אחרי תקלה");
});
test("offline cancellation unlocks editing across reload but prevents another write until the old attempt is fenced", async () => {
  const { ctx, drafts } = setup();
  let writes = 0;
  ctx.api.save = async () => {
    writes++;
    throw new ApiError("ניתוק", "NETWORK", 0);
  };
  ctx.api.request = async () => {
    throw new ApiError("ניתוק", "NETWORK", 0);
  };
  await supplierForm(ctx);
  fill("name", "עריכה גם בניתוק");
  submit();
  await tick();
  const original = structuredClone(drafts.get("supplier").pending);
  document.querySelector("[data-cancel-attempt]").click();
  await tick();
  assert.equal(document.querySelector("[name=name]").disabled, false);
  fill("notes", "עוד פרטים");
  await tick();
  await supplierForm(ctx);
  assert.equal(document.querySelector("[name=notes]").value, "עוד פרטים");
  assert.equal(document.querySelector("[name=name]").disabled, false);
  submit();
  await tick();
  assert.equal(writes, 1);
  assert.equal(
    drafts.get("supplier").cancelPending.mutationId,
    original.body.mutationId,
  );
  drafts.set("cash", { fields: { notes: "טיוטה אחרת" } });
  document.querySelector("[data-discard-draft]").click();
  await tick();
  assert.equal(drafts.has("supplier"), false);
  assert.deepEqual(drafts.get("cancelled-" + original.body.mutationId), {
    mutationId: original.body.mutationId,
    entity: original.path,
  });
  assert.equal(drafts.get("cash").fields.notes, "טיוטה אחרת");
});
test("a committed attempt preserves subsequent edits and requires opening the actual saved record before another save", async () => {
  const { ctx, drafts } = setup();
  let finishCancel,
    writes = 0;
  ctx.api.save = async () => {
    writes++;
    throw new ApiError("ניתוק", "NETWORK", 0);
  };
  ctx.api.request = async () =>
    new Promise((resolve) => {
      finishCancel = resolve;
    });
  await cashForm(ctx);
  fill("cash", "10");
  submit();
  await tick();
  const oldDate = drafts.get("cash").recordId;
  document.querySelector("[data-cancel-attempt]").click();
  await tick();
  fill("date", "2026-09-08");
  fill("cash", "25");
  finishCancel({
    status: "committed",
    path: "daily-cash/" + oldDate,
    record: {
      id: oldDate,
      date: oldDate,
      version: 1,
      cashAgorot: 1000,
      ravKavAgorot: null,
      notes: "",
    },
    relatedRecords: [],
  });
  await tick();
  assert.equal(document.querySelector("[name=cash]").value, "25");
  assert.equal(drafts.get("cash").conflictPath, "daily-cash/" + oldDate);
  assert.equal(drafts.get("cash").conflict, true);
  assert.match(
    document.querySelector("[data-form-error]").textContent,
    /כבר הושלמה/,
  );
  submit();
  await tick();
  assert.equal(writes, 1);
});
test("failure to persist cancellation keeps the immutable pending attempt and does not call the server", async () => {
  const { ctx, drafts } = setup();
  let calls = 0;
  ctx.api.save = async () => {
    throw new ApiError("ניתוק", "NETWORK", 0);
  };
  ctx.api.request = async () => {
    calls++;
    return { status: "cancelled" };
  };
  await supplierForm(ctx);
  fill("name", "טיוטה בטוחה");
  submit();
  await tick();
  const original = structuredClone(drafts.get("supplier").pending);
  const saveDraft = ctx.drafts.save;
  ctx.drafts.save = async (key, value) => {
    if (value.cancelPending) throw Error("QuotaExceededError");
    return saveDraft(key, value);
  };
  document.querySelector("[data-cancel-attempt]").click();
  await tick();
  assert.deepEqual(drafts.get("supplier").pending, original);
  assert.equal(document.querySelector("[name=name]").disabled, true);
  assert.equal(calls, 0);
});

test("deleting an unused supplier survives lost response and reuses the deletion identity", async () => {
  const { ctx, drafts } = setup();
  const record = { id: "supplier-unused", name: "ספק טעות", active: true, version: 3 };
  ctx.data.suppliers.push(record);
  const attempts = [];
  ctx.api.save = async pending => {
    attempts.push(structuredClone(pending));
    if (attempts.length === 1) throw new ApiError("לא התקבלה תשובה", "NETWORK", 0);
    return { record: { ...record, active: false, deletedAt: 123, version: 4 } };
  };
  await supplierForm(ctx, record);
  document.querySelector("[data-remove-supplier]").click();
  await tick();
  assert.match(document.body.textContent, /למחוק את הספק/);
  submit();
  await tick();
  assert.equal(attempts[0].method, "DELETE");
  assert.equal(attempts[0].path, "suppliers/" + record.id);
  assert.equal(attempts[0].body.expectedVersion, 3);
  assert.equal(drafts.get("supplier").operation, "delete");
  await supplierForm(ctx, record);
  submit();
  await tick();
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(drafts.has("supplier"), false);
});

test("supplier removal keeps invoice history and manual invoice excludes delivery notes", async () => {
  const { ctx, saved } = setup();
  const supplier = { ...ctx.data.suppliers[0], version: 1 };
  ctx.data.invoices.push({ supplierId: supplier.id, deletedAt: 123 });
  await supplierForm(ctx, supplier);
  document.querySelector("[data-remove-supplier]").click();
  assert.match(document.querySelector(".delete-form").textContent, /החשבוניות והצילומים שלו יישארו בהיסטוריה/);
  assert.equal(saved.length, 0);
  await invoiceForm(ctx);
  const options = [...document.querySelector('[name="documentType"]').options].map(o => o.value);
  assert.deepEqual(options, ["", "invoice", "credit"]);
  assert.equal(document.querySelector('[name="documentType"]').value, "invoice");
});

test("a supplier's bound identifiers are visible, survive an edit and reject a bad digit", async () => {
  const { ctx, saved } = setup();
  const record = {
    id: "supplier-globus",
    version: 1,
    name: "גלובוס",
    contact: "",
    notes: "",
    active: true,
    taxIds: ["513036434", "557904679"],
  };
  await supplierForm(ctx, record);
  assert.equal(
    document.querySelector("[name=taxIds]").value,
    "513036434, 557904679",
  );
  // Renaming carries them along instead of dropping what the matching relies on.
  fill("name", "גלובוס בע״מ");
  submit();
  await tick();
  assert.deepEqual(saved[0].body.data.taxIds, ["513036434", "557904679"]);
  assert.equal(saved[0].body.data.name, "גלובוס בע״מ");
  // A number that fails its check digit is named before anything is sent.
  await supplierForm(ctx, record);
  fill("taxIds", "513036435");
  submit();
  await tick();
  assert.equal(saved.length, 1);
  assert.match(
    document.querySelector("[data-form-error]").textContent,
    /513036435/,
  );
});

test("an invoice typed from a photograph is never saved before its pages are stored", async () => {
  const { ctx, drafts, saved } = setup();
  const pages = [{ name: "page.jpg", mime: "image/jpeg", data: "AQID" }];
  drafts.set("scan", { files: pages, attachmentIds: [] });
  const requests = [];
  let completeUpload = null;
  ctx.api.request = async (path, options) => {
    requests.push({ path, options });
    // The first attempt is the background one the scan screen started and
    // lost; the save has to notice and ask again.
    if (requests.length === 1) throw new ApiError("אין חיבור לרשת כרגע", "NETWORK", 0);
    return new Promise(resolve => { completeUpload = resolve; });
  };
  await openInvoiceForm(ctx, null, [], { fullEditor: true, fromScan: true });
  await tick();
  assert.equal(requests.length, 1, "the pages start going up as the form opens");
  assert.equal(drafts.get("invoice").fromScan, true);
  fill("supplierId", "supplier-001");
  fill("documentNumber", "PHOTO-1");
  fill("total", "100");
  fill("final", "100");
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(saved.length, 0, "nothing is written while the photograph is still on its way");
  assert.equal(requests.length, 2, "the save asks for the pages again");
  assert.match(document.querySelector("[type=submit]").textContent, /מסיים להעלות את הצילום/);
  completeUpload({ documents: [{ id: "c".repeat(64) }] });
  await tick();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].body.data.attachmentIds, ["c".repeat(64)], "the invoice carries the pages it was typed from");
  assert.equal(drafts.has("invoice"), false);
  assert.equal(drafts.has("scan"), false, "the photograph draft is cleared with the invoice");
});
