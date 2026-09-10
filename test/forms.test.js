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
