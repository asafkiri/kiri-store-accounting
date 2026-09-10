import { $, field, select, icon, toast, formObject, errorText } from "./ui.js";
import {
  escapeHtml as e,
  money,
  moneyInput,
  parseMoney,
  today,
  methods,
  types,
} from "./format.js";
import { pendingMutation } from "./api.js";

function bindDraft(ctx, form, key, draft, collect, onSubmit) {
  const status = $("[data-draft-status]", form),
    submit = $("[type=submit]", form),
    error = $("[data-form-error]", form);
  const persist = async (critical = false) => {
    try {
      await ctx.drafts.save(key, draft);
      if (status) status.textContent = "טיוטה שמורה במכשיר";
    } catch {
      if (status)
        status.textContent =
          "לא ניתן לשמור טיוטה במכשיר. השאר את החלון פתוח עד לשמירה בשרת.";
      if (critical)
        throw Error(
          "אין מספיק מקום לשמירת טיוטה בטוחה במכשיר. יש לפנות מקום לפני שליחה.",
        );
    }
  };
  form.addEventListener("input", () => {
    if (!draft.pending) {
      draft.fields = collect();
      persist();
    }
  });
  form.addEventListener("change", () => {
    if (!draft.pending) {
      draft.fields = collect();
      persist();
    }
  });
  const lock = () => {
    for (const el of form.querySelectorAll("input,select,textarea,button"))
      if (el !== submit && !el.hasAttribute("data-safe-action"))
        el.disabled = Boolean(draft.pending);
    submit.textContent = draft.pending
      ? "נסה להשלים את השמירה"
      : submit.dataset.label;
  };
  const showConflict = () => {
    error.hidden = false;
    error.textContent =
      "הרשומה עודכנה מאז. הטיוטה שלך נשמרה; טען את הגרסה העדכנית לפני המשך עריכה.";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.dataset.safeAction = "";
    button.textContent = "טען את העדכון מהשרת";
    button.onclick = async () => {
      if (!confirm("הטיוטה הנוכחית תישמר לעיון, והגרסה מהשרת תיפתח. להמשיך?"))
        return;
      button.disabled = true;
      try {
        const collection =
          key === "supplier"
            ? "suppliers"
            : key === "cash"
              ? "daily-cash"
              : "invoices";
        const path = collection + "/" + draft.recordId;
        const current = await ctx.api.request(path);
        if (current.deletedAt)
          throw Error(
            "הרשומה נמחקה במכשיר אחר. הטיוטה שלך נשארת במכשיר לעיון.",
          );
        await ctx.drafts.save("conflict-" + crypto.randomUUID(), draft);
        await ctx.drafts.remove(key);
        ctx.mergeRecord(current, path);
        ctx.closeModal();
        await ctx.reopen(key, draft.recordId);
      } catch (err) {
        toast(errorText(err), true);
        button.disabled = false;
      }
    };
    error.append(document.createElement("br"), button);
  };
  submit.dataset.label = submit.textContent;
  lock();
  persist();
  if (draft.conflict) showConflict();
  const discard = form.querySelector("[data-discard-draft]");
  if (discard)
    discard.onclick = async () => {
      if (!draft.pending && confirm("למחוק את הטיוטה מהמכשיר?")) {
        await ctx.drafts.remove(key);
        ctx.closeModal();
        ctx.render();
      }
    };
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (submit.disabled) return;
    error.hidden = true;
    submit.disabled = true;
    ctx.setModalBusy(true);
    try {
      if (draft.conflict)
        throw Error("יש לטעון את הגרסה העדכנית לפני שמירה נוספת.");
      if (!draft.pending) {
        draft.fields = collect();
        draft.pending = onSubmit(draft.fields);
        await persist(true);
      }
      const result = await ctx.api.save(draft.pending);
      await ctx.drafts.remove(key);
      if (key === "invoice" && draft.fields.scanJobId) {
        const scan = await ctx.drafts.load("scan");
        if (scan?.jobId === draft.fields.scanJobId)
          await ctx.drafts.remove("scan");
      }
      ctx.mergeRecord(result.record, draft.pending.path);
      ctx.closeModal();
      ctx.render();
      toast("נשמר בחנות");
      ctx.refresh(false);
    } catch (err) {
      error.hidden = false;
      error.textContent = errorText(err);
      if (err.status && err.status < 500 && ![408, 429].includes(err.status)) {
        draft.pending = null;
        if (err.code === "VERSION_CONFLICT") {
          draft.conflict = true;
        }
      }
      await persist();
      if (draft.conflict) showConflict();
      lock();
    } finally {
      submit.disabled = false;
      ctx.setModalBusy(false);
    }
  });
  return { persist, lock };
}
const footer = (label) =>
  `<div class="form-error" role="alert" data-form-error hidden></div><footer class="form-footer"><small data-draft-status>שומר טיוטה…</small><button class="primary" type="submit">${e(label)}</button><button class="text-button danger" type="button" data-discard-draft>מחק טיוטה</button></footer>`;
const textArea = (name, value, label) =>
  `<label class="field wide"><span>${e(label)}</span><textarea name="${name}" rows="2" maxlength="4000">${e(value)}</textarea></label>`;

export async function retainDraft(ctx, key, old) {
  let name = `saved-${key}-${old.recordId}`;
  if (await ctx.drafts.load(name)) name += "-" + crypto.randomUUID();
  await ctx.drafts.save(name, { ...old, kind: key });
}
async function matchingDraft(ctx, key, old, record, compatible = true) {
  if (!old) return null;
  // Legacy drafts have no mode. A nonzero version belongs to an existing record.
  const mode = old.mode || (old.version === 0 ? "new" : "edit");
  const matches = record ? old.recordId === record.id : mode === "new";
  const stale = record && old.version !== record.version && !old.pending;
  if (compatible && matches && !stale) return { ...old, mode };
  await retainDraft(ctx, key, old);
  return null;
}
const staleNotice = (old, record, draft) =>
  old &&
  record &&
  old.recordId === record.id &&
  old.version !== record.version &&
  !draft.pending
    ? '<div class="notice warning">הרשומה עודכנה מאז. מוצגת הגרסה העדכנית; הטיוטה הקודמת נשמרה לעיון בהגדרות וגיבוי.</div>'
    : "";

export async function supplierForm(ctx, record = null) {
  const key = "supplier",
    old = await ctx.drafts.load(key);
  const draft = (await matchingDraft(ctx, key, old, record)) || {
    mode: record ? "edit" : "new",
    recordId: record?.id || crypto.randomUUID(),
    version: record?.version || 0,
    fields: {
      name: record?.name || "",
      contact: record?.contact || "",
      notes: record?.notes || "",
      active: record?.active === false ? "no" : "yes",
    },
  };
  const f = draft.fields;
  const root = ctx.dialog(
    record ? "עריכת ספק" : "הוספת ספק",
    `${staleNotice(old, record, draft)}<form id="supplier-form"><div class="form-grid">${field("שם הספק", "name", f.name, { required: true, wide: true })}${field("פרטי קשר (רשות)", "contact", f.contact, { wide: true })}${textArea("notes", f.notes, "הערות")}${select("מצב ספק", "active", f.active, { yes: "פעיל", no: "לא פעיל — נשאר בהיסטוריה" }, { wide: true })}</div>${footer("שמור ספק")}</form>`,
  );
  const form = $("form", root);
  bindDraft(
    ctx,
    form,
    key,
    draft,
    () => formObject(form),
    (values) =>
      pendingMutation(
        "suppliers/" + draft.recordId,
        {
          name: values.name,
          contact: values.contact,
          notes: values.notes,
          active: values.active === "yes",
        },
        draft.version,
      ),
  );
}
export async function invoiceForm(
  ctx,
  record = null,
  scan = null,
  manualAttachments = [],
) {
  const key = "invoice",
    old = await ctx.drafts.load(key);
  let draft = await matchingDraft(
    ctx,
    key,
    old,
    record,
    (!scan || old?.scan?.id === scan.id) && !manualAttachments.length,
  );
  if (!draft) {
    const r = scan?.result;
    draft = {
      mode: record ? "edit" : "new",
      recordId: record?.id || crypto.randomUUID(),
      version: record?.version || 0,
      scan: scan || null,
      fields: {
        supplierId:
          record?.supplierId ||
          ctx.data.suppliers.find((s) => s.name === r?.supplierName)?.id ||
          "",
        documentNumber: record?.documentNumber || r?.documentNumber || "",
        invoiceDate: record?.invoiceDate || (r ? r.invoiceDate || "" : today()),
        documentType:
          record?.documentType || (r ? r.documentType || "" : "invoice"),
        subtotal: moneyInput(
          record ? record.subtotalAgorot : r?.subtotalAgorot,
        ),
        vat: moneyInput(record ? record.vatAgorot : r?.vatAgorot),
        total: moneyInput(record ? record.totalAgorot : r?.totalAgorot),
        final: moneyInput(record ? record.finalAgorot : r?.finalAgorot),
        notes: record?.notes || "",
        deductions: (record?.deductions || r?.deductions || []).map((d) => ({
          label: d.label || "",
          amount: moneyInput(d.amountAgorot),
          included:
            d.includedInTotal === null
              ? "unknown"
              : d.includedInTotal
                ? "yes"
                : "no",
        })),
        attachmentIds:
          record?.attachmentIds || scan?.attachmentIds || manualAttachments,
        source: record?.source || (scan ? "ai" : "manual"),
        scanJobId: record?.scanJobId || scan?.id || null,
      },
    };
  }
  const f = draft.fields,
    r = draft.scan?.result;
  const uncertain = (k) =>
    Boolean(r && (r[k] == null || r.uncertainFields?.includes(k)));
  const read = (k, m = false) =>
    r ? (r[k] === null ? "לא זוהה" : m ? money(r[k]) : r[k]) : "";
  const supplierOptions = {
    "": "בחר ספק",
    ...Object.fromEntries(
      ctx.data.suppliers
        .filter((s) => s.active || s.id === f.supplierId)
        .map((s) => [s.id, s.name]),
    ),
  };
  const root = ctx.dialog(
    record ? "עריכת חשבונית" : r ? "בדיקת החשבונית שנסרקה" : "הוספת חשבונית",
    `${staleNotice(old, record, draft)}<form id="invoice-form">
    ${r ? `<div class="notice ${r.needsReview ? "warning" : ""}"><strong>${r.needsReview ? "יש שדות שדורשים בדיקה" : "הסריקה מוכנה לבדיקה"}</strong><p>ליד השדות מופיע מה נקרא. הערכים בתיבות הם אלה שיישמרו.</p>${r.warnings.map((w) => `<p>${e(w)}</p>`).join("")}</div>` : ""}
    <div class="form-grid">${r ? `<p class="read-value wide">ספק שנקרא: ${e(r.supplierName || "לא זוהה")} · סוג: ${e(types[r.documentType] || "לא זוהה")}</p>` : ""}${select("ספק", "supplierId", f.supplierId, supplierOptions, { wide: true, required: true, uncertain: uncertain("supplierName"), read: read("supplierName") })}<button type="button" class="text-button wide" id="invoice-new-supplier">${icon("plus")} הוסף ספק חדש</button>
      ${field("מספר חשבונית / תעודה", "documentNumber", f.documentNumber, { required: true, read: read("documentNumber"), uncertain: uncertain("documentNumber") })}${field("תאריך המסמך", "invoiceDate", f.invoiceDate, { type: "date", required: true, read: read("invoiceDate"), uncertain: uncertain("invoiceDate") })}
      ${select("סוג מסמך", "documentType", f.documentType, { "": "בחר סוג מסמך", ...types }, { wide: true, required: true, uncertain: uncertain("documentType"), read: r ? types[r.documentType] || "לא זוהה" : "" })}${field("לפני מע״מ (רשות)", "subtotal", f.subtotal, { read: read("subtotalAgorot", true), uncertain: uncertain("subtotalAgorot") })}${field("מע״מ כפי שרשום", "vat", f.vat, { read: read("vatAgorot", true), uncertain: uncertain("vatAgorot"), hint: "לא ידוע? השאר ריק. 0 רק כשאין מע״מ." })}
      ${field("סכום כולל מע״מ", "total", f.total, { required: true, read: read("totalAgorot", true), uncertain: uncertain("totalAgorot"), wide: true })}
    </div><section class="deductions"><div class="section-label"><h3>הפחתות וניכויים</h3><button type="button" class="text-button" id="add-deduction">${icon("plus")} הוסף שורה</button></div><div id="deductions-list"></div><small>סמן אם ההפחתה כבר כלולה בסכום המסמך, כדי שלא תרד פעמיים.</small></section>
    <div class="form-grid">${field("סכום סופי לתשלום", "final", f.final, { required: true, wide: true, read: read("finalAgorot", true), uncertain: uncertain("finalAgorot") })}<button type="button" class="text-button wide" id="calculate-final">מלא לפי הסכום וההפחתות שהזנתי</button>${textArea("notes", f.notes, "הערות (רשות)")}</div>
    <div id="arithmetic-note" class="notice warning" hidden></div>
    ${f.attachmentIds.length ? `<div class="attachment-links"><strong>המסמך המצורף</strong>${f.attachmentIds.map((id, i) => `<button type="button" class="secondary" data-open-document="${e(id)}">פתח עמוד / קובץ ${i + 1}</button>`).join("")}</div>` : ""}
    <label class="checkbox"><input name="review" type="checkbox" required> בדקתי את הפרטים ואת הסכום לתשלום</label>${footer("שמור חשבונית")}</form>`,
  );
  const form = $("form", root);
  const renderDeductions = () => {
    $("#deductions-list", form).innerHTML = f.deductions
      .map(
        (d, i) =>
          `<div class="deduction-row" data-index="${i}">${field("סיבת ההפחתה", "deduction-label-" + i, d.label, { required: true })}${field("סכום", "deduction-amount-" + i, d.amount, { required: true })}${select("כלולה בסכום המסמך?", "deduction-included-" + i, d.included, { unknown: "יש לבדוק", yes: "כן, כבר כלולה", no: "לא, להפחית בנוסף" })}<button class="icon-button danger" type="button" aria-label="הסר הפחתה" data-remove-deduction="${i}">${icon("close")}</button>${r?.deductions[i] ? `<small class="wide read-value">נקרא: ${e(r.deductions[i].label || "לא זוהה")} · ${e(money(r.deductions[i].amountAgorot))} · ${r.deductions[i].includedInTotal === null ? "לא ידוע אם כלולה" : r.deductions[i].includedInTotal ? "כלולה בסכום" : "נוספת"}</small>` : ""}</div>`,
      )
      .join("");
  };
  renderDeductions();
  const collect = () => {
    const values = formObject(form);
    return {
      ...f,
      ...values,
      deductions: f.deductions.map((_, i) => ({
        label: values["deduction-label-" + i],
        amount: values["deduction-amount-" + i],
        included: values["deduction-included-" + i],
      })),
    };
  };
  const binding = bindDraft(ctx, form, key, draft, collect, (values) => {
    if (!Object.hasOwn(types, values.documentType))
      throw Error("יש לבחור סוג מסמך לפי התעודה.");
    if (values.deductions.some((d) => d.included === "unknown"))
      throw Error("יש לבדוק אם כל הפחתה כבר כלולה בסכום המסמך.");
    return pendingMutation(
      "invoices/" + draft.recordId,
      {
        supplierId: values.supplierId,
        documentNumber: values.documentNumber,
        invoiceDate: values.invoiceDate,
        documentType: values.documentType,
        subtotalAgorot: parseMoney(values.subtotal, true),
        vatAgorot: parseMoney(values.vat, true),
        totalAgorot: parseMoney(values.total),
        finalAgorot: parseMoney(values.final),
        deductions: values.deductions.map((d) => ({
          label: d.label,
          amountAgorot: parseMoney(d.amount),
          includedInTotal: d.included === "yes",
        })),
        notes: values.notes,
        attachmentIds: f.attachmentIds,
        source: f.source,
        scanJobId: f.scanJobId,
        reviewConfirmed: values.review === "on",
      },
      draft.version,
    );
  });
  $("#add-deduction", form).onclick = () => {
    Object.assign(f, collect());
    if (f.deductions.length >= 30) return;
    f.deductions.push({ label: "", amount: "", included: "no" });
    renderDeductions();
    draft.fields = f;
    binding.persist();
  };
  form.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-remove-deduction]");
    if (b) {
      Object.assign(f, collect());
      f.deductions.splice(Number(b.dataset.removeDeduction), 1);
      renderDeductions();
      draft.fields = f;
      binding.persist();
    }
  });
  $("#calculate-final", form).onclick = () => {
    try {
      const values = collect();
      if (values.deductions.some((d) => d.included === "unknown"))
        throw Error("בדוק קודם אם ההפחתות כלולות בסכום.");
      const calculated =
        parseMoney(values.total) -
        values.deductions
          .filter((d) => d.included === "no")
          .reduce((sum, d) => sum + parseMoney(d.amount), 0);
      if (
        form.elements.final.value &&
        !confirm("לעדכן את הסכום הסופי ל־" + money(calculated) + "?")
      )
        return;
      form.elements.final.value = moneyInput(calculated);
      form.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("#invoice-new-supplier", form).onclick = async () => {
    draft.fields = collect();
    await binding.persist();
    await supplierForm(ctx);
  };
  form.addEventListener("input", () => {
    try {
      const values = collect(),
        s = parseMoney(values.subtotal, true),
        vat = parseMoney(values.vat, true),
        total = parseMoney(values.total, true);
      const note = $("#arithmetic-note", form);
      note.hidden = !(
        s !== null &&
        vat !== null &&
        total !== null &&
        s + vat !== total
      );
      note.textContent =
        "לפני מע״מ + מע״מ אינם שווים לסכום הכולל. בדוק מול המסמך; המספרים לא שונו.";
    } catch {}
  });
}
export async function paymentForm(ctx, record) {
  const key = "payment",
    old = await ctx.drafts.load(key);
  if (old && old.recordId !== record.id)
    await ctx.drafts.save("saved-payment-" + old.recordId, {
      ...old,
      kind: "payment",
    });
  const draft =
    old?.recordId === record.id
      ? old
      : {
          recordId: record.id,
          version: record.version,
          fields: {
            method: record.payment?.method || "check",
            paymentDate: record.payment?.paymentDate || today(),
            checkNumber: record.payment?.checkNumber || "",
            checkDueDate: record.payment?.checkDueDate || "",
            notes: record.payment?.notes || "",
          },
        };
  const f = draft.fields;
  const root = ctx.dialog(
    "סימון חשבונית כשולמה",
    `<form><div class="payment-amount"><span>חשבונית ${e(record.documentNumber)}</span><strong>${e(money(record.finalAgorot))}</strong></div><div class="form-grid">${select("אמצעי תשלום", "method", f.method, methods, { wide: true })}${field("תאריך תשלום / מסירת צ׳ק", "paymentDate", f.paymentDate, { type: "date", required: true, wide: true })}<div class="notice wide" id="check-notice">בצ׳ק: זה היום שבו מסרת את הצ׳ק לספק.</div><div id="check-fields" class="form-grid wide">${field("מספר צ׳ק (רשות)", "checkNumber", f.checkNumber)}${field("מועד פירעון (רשות)", "checkDueDate", f.checkDueDate, { type: "date" })}</div>${textArea("notes", f.notes, "הערה לתשלום (רשות)")}</div>${footer(record.status === "paid" ? "עדכן פרטי תשלום" : "אשר תשלום")}</form>`,
  );
  const form = $("form", root),
    update = () => {
      const check = form.elements.method.value === "check";
      $("#check-fields", form).hidden = !check;
      $("#check-notice", form).hidden = !check;
    };
  update();
  form.elements.method.addEventListener("change", update);
  bindDraft(
    ctx,
    form,
    key,
    draft,
    () => formObject(form),
    (values) =>
      pendingMutation(
        "invoices/" + record.id + "/pay",
        null,
        draft.version,
        "POST",
        {
          payment: {
            method: values.method,
            paymentDate: values.paymentDate,
            checkNumber: values.method === "check" ? values.checkNumber : "",
            checkDueDate:
              values.method === "check" ? values.checkDueDate || null : null,
            notes: values.notes,
          },
        },
      ),
  );
}
export async function cashForm(ctx, record = null) {
  const key = "cash",
    old = await ctx.drafts.load(key);
  if (old && record && old.recordId !== record.id)
    await ctx.drafts.save("saved-cash-" + old.recordId, {
      ...old,
      kind: "cash",
    });
  let draft =
    old && (!record || old.recordId === record.id)
      ? old
      : {
          recordId: record?.id || today(),
          version: record?.version || 0,
          fields: {
            date: record?.date || today(),
            cash: moneyInput(record?.cashAgorot),
            ravKav: moneyInput(record?.ravKavAgorot),
            notes: record?.notes || "",
          },
        };
  const f = draft.fields;
  const root = ctx.dialog(
    "רישום סגירה יומית",
    `<form><p class="muted">שני סכומים נפרדים. הקופה אינה כוללת רב־קו.</p><div class="form-grid">${field("תאריך", "date", f.date, { type: "date", required: true, wide: true })}${field("קופה", "cash", f.cash, { wide: true })}${field("רב־קו", "ravKav", f.ravKav, { wide: true })}${textArea("notes", f.notes, "הערה (רשות)")}</div>${footer("שמור סגירה יומית")}</form>`,
  );
  const form = $("form", root);
  if (draft.version) form.elements.date.readOnly = true;
  bindDraft(
    ctx,
    form,
    key,
    draft,
    () => formObject(form),
    (values) => {
      const existing = ctx.data.dailyCash.find((r) => r.id === values.date);
      if (existing && existing.id !== draft.recordId)
        throw Error("כבר קיימת סגירה בתאריך הזה. יש לפתוח אותה לעריכה.");
      draft.recordId = values.date;
      return pendingMutation(
        "daily-cash/" + values.date,
        {
          date: values.date,
          cashAgorot: parseMoney(values.cash, true),
          ravKavAgorot: parseMoney(values.ravKav, true),
          notes: values.notes,
        },
        existing?.id === draft.recordId ? draft.version : 0,
      );
    },
  );
}
