import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  invoiceForm,
  paymentForm,
  cashForm,
  supplierForm,
} from "../src/forms.js";
import { ApiError } from "../src/api.js";
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
test("AI form presents uncertain fields without saving automatically", async () => {
  const { ctx, saved } = setup();
  const scan = {
    id: "scan-unit-id",
    attachmentIds: [],
    result: {
      supplierName: "ספק בדיקה",
      documentNumber: "A-2",
      invoiceDate: "2026-09-10",
      documentType: "invoice",
      subtotalAgorot: null,
      vatAgorot: null,
      totalAgorot: 999,
      finalAgorot: null,
      deductions: [],
      uncertainFields: ["vatAgorot", "finalAgorot"],
      needsReview: true,
      warnings: [],
    },
  };
  await invoiceForm(ctx, null, scan);
  assert.equal(saved.length, 0);
  assert.equal(document.querySelector("[name=vat]").value, "");
  assert.equal(document.querySelector("[name=final]").value, "");
  assert.ok(document.querySelector("[name=vat]").closest(".uncertain"));
  assert.match(document.body.textContent, /נקרא/);
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
  fill("paymentDate", "2026-09-10");
  fill("checkDueDate", "2026-09-30");
  submit();
  await tick();
  assert.equal(saved[0].body.payment.paymentDate, "2026-09-10");
  assert.equal(saved[0].body.payment.checkDueDate, "2026-09-30");
  assert.equal(saved[0].body.payment.method, "check");
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
  scanJobId: null,
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
  assert.equal(drafts.get("invoice").version, 2);
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
test("AI review marks supplier and unknown document type, requiring an explicit document choice", async () => {
  const { ctx, saved } = setup();
  await invoiceForm(ctx, null, {
    id: "unknown-type",
    attachmentIds: [],
    result: {
      supplierName: "ספק בדיקה",
      documentNumber: "a",
      invoiceDate: "2026-09-10",
      documentType: null,
      subtotalAgorot: null,
      vatAgorot: null,
      totalAgorot: 100,
      finalAgorot: 100,
      deductions: [],
      uncertainFields: ["supplierName", "documentType"],
      needsReview: true,
      warnings: [],
    },
  });
  const select = document.querySelector("[name=documentType]");
  assert.equal(select.value, "");
  assert.equal(select.required, true);
  assert.ok(select.closest(".uncertain"));
  assert.ok(document.querySelector("[name=supplierId]").closest(".uncertain"));
  document.querySelector("[name=review]").checked = true;
  submit();
  await tick();
  assert.equal(saved.length, 0);
  assert.match(
    document.querySelector("[data-form-error]").textContent,
    /סוג מסמך/,
  );
});

const supplierScan = (name, uncertainFields = []) => ({
  id: "new-supplier-scan",
  attachmentIds: [],
  result: {
    supplierName: name,
    documentNumber: "new-1001",
    invoiceDate: "2026-09-10",
    documentType: "invoice",
    subtotalAgorot: null,
    vatAgorot: null,
    totalAgorot: 1200,
    finalAgorot: 1200,
    deductions: [],
    uncertainFields,
    needsReview: !!uncertainFields.length,
    warnings: [],
  },
});
const supplierAction = (name) =>
  document.querySelector(`[data-supplier-action="${name}"]`);

test("changing a pending supplier clears its stale option and choosing an existing one cancels creation", async () => {
  const { ctx, drafts, saved } = setup();
  await invoiceForm(ctx, null, supplierScan("שם חדש"));
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
  await invoiceForm(ctx, null, supplierScan("מרינה"));
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
  await invoiceForm(ctx, null, supplierScan("מרינה"));
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
  await invoiceForm(ctx, null, supplierScan("מרינה"));
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
  await invoiceForm(ctx, null, supplierScan("מרינה"));
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
  await invoiceForm(ctx, null, supplierScan("חדש לביטול"));
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
  assert.deepEqual(saved[0].body.data.newSupplier, { name: "ספק ידני חדש" });
});

test("uncertain or missing scanned supplier name starts empty and visibly requires review", async () => {
  for (const name of [null, "ספק בדיקה"]) {
    const { ctx } = setup();
    await invoiceForm(ctx, null, supplierScan(name, ["supplierName"]));
    assert.equal(document.querySelector("[name=supplierName]").value, "");
    assert.equal(document.querySelector("[name=supplierId]").value, "");
    assert.ok(
      document.querySelector("[name=supplierName]").closest(".uncertain"),
    );
    assert.match(
      document.querySelector("[data-supplier-picker]").textContent,
      /דורש בדיקה/,
    );
    fill("supplierName", "שם שהוקלד");
    assert.ok(supplierAction("create"));
  }
});

test("new supplier save after network loss replays the same invoice mutation and supplier ID after reload", async () => {
  const { ctx, drafts } = setup();
  const attempts = [];
  ctx.api.save = async (p) => {
    attempts.push(structuredClone(p));
    if (attempts.length === 1) throw new ApiError("ניתוק", "NETWORK", 0);
    return { record: { id: p.path.split("/")[1] } };
  };
  await invoiceForm(ctx, null, supplierScan("ספק לניתוק"));
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
  await invoiceForm(ctx, null, supplierScan("מרינה"));
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
