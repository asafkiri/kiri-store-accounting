import { $, field, select, icon, toast, formObject, errorText } from "./ui.js";
import {
  escapeHtml as e,
  money,
  moneyInput,
  parseMoney,
  today,
  methods,
  types,
  monthLabel,
  invoiceLabel,
  displayDate,
} from "./format.js";
import { pendingMutation } from "./api.js";
import { supplierPickerMarkup, bindSupplierPicker } from "./supplier-picker.js";
import { creditSignIssues } from "./credit.js";
import { isValidTaxId, normalizeTaxId } from "./tax-id.js";
import { hasDraftContent } from "./draft-activity.js";
import { quickInvoiceReview } from "./quick-invoice.js";
import { uploadScanPages } from "./scan-upload.js";
import {
  findDuplicateInvoice,
  duplicateShown,
  duplicateNotice,
} from "./duplicate-invoice.js";
import {
  cancellationFor,
  cancelAttempt,
  mergeAttemptResult,
} from "./attempts.js";

async function removeLinkedScan(ctx, draft) {
  const scan = await ctx.drafts.load("scan");
  if (scan?.attachmentIds?.length && scan.attachmentIds.every(id => draft.fields.attachmentIds?.includes(id)))
    await ctx.drafts.remove("scan");
}

export function bindDraft(ctx, form, key, draft, collect, onSubmit, options = {}) {
  const status = $("[data-draft-status]", form),
    submit = $("[type=submit]", form),
    error = $("[data-form-error]", form);
  const cancelButton = $("[data-cancel-attempt]", form),
    recovery = $("[data-cancellation-status]", form);
  const api = ctx.api;
  let disposed = false,
    cancellationPromise = null;
  const active = () => !disposed && form.isConnected && ctx.api === api;
  const persist = async (critical = false) => {
    try {
      if (hasDraftContent(key, draft)) await ctx.drafts.save(key, draft);
      else await ctx.drafts.remove(key);
      if (status) { status.textContent = "טיוטה שמורה במכשיר"; status.dataset.saved = "true"; }
    } catch {
      if (status) {
        status.dataset.saved = "false";
        status.textContent =
          "לא ניתן לשמור טיוטה במכשיר. השאר את החלון פתוח עד לשמירה בשרת.";
      }
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
      if (
        el !== submit &&
        el !== cancelButton &&
        !el.hasAttribute("data-safe-action")
      )
        el.disabled = Boolean(draft.pending);
    submit.textContent = draft.pending
      ? options.retryLabel || "נסה להשלים את השמירה"
      : submit.dataset.label;
    cancelButton.hidden = !draft.pending;
    cancelButton.disabled = submit.disabled;
    recovery.hidden = !draft.cancelPending;
    recovery.textContent =
      "אפשר לערוך או למחוק את הטיוטה. לפני שמירה חדשה נבדוק אם הניסיון הקודם כבר נשמר.";
    options.onLock?.();
  };
  const showConflict = () => {
    error.hidden = false;
    error.textContent =
      draft.conflictMessage ||
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
        if (options.reloadConflict) { await options.reloadConflict(); return; }
        const collection =
          key === "preferences" ? "settings" : key === "supplier"
            ? "suppliers"
            : key === "cash"
              ? "daily-cash"
              : "invoices";
        const path = draft.conflictPath || collection + "/" + draft.recordId;
        const current = await ctx.api.request(path);
        if (current.deletedAt)
          throw Error(
            "הרשומה נמחקה במכשיר אחר. הטיוטה שלך נשארת במכשיר לעיון.",
          );
        await ctx.drafts.save("conflict-" + crypto.randomUUID(), draft);
        await ctx.drafts.remove(key);
        ctx.mergeRecord(current, path);
        ctx.closeModal();
        await ctx.reopen(key, current.id);
      } catch (err) {
        toast(errorText(err), true);
        button.disabled = false;
      }
    };
    error.append(document.createElement("br"), button);
  };
  const resolveCancellation = () => {
    if (!draft.cancelPending) return Promise.resolve(null);
    if (cancellationPromise) return cancellationPromise;
    const attempt = draft.cancelPending;
    cancellationPromise = (async () => {
      const result = await cancelAttempt(ctx, attempt);
      if (!active()) return result;
      draft.cancelPending = null;
      if (result.status === "committed") {
        mergeAttemptResult(ctx, result);
        if (key === "cash" && draft.operation === "delete") {
          try { await ctx.drafts.remove(key); } catch { /* The receipt still makes retries safe. */ }
          disposed = true;
          ctx.setModalBusy(false);
          ctx.closeModal();
          ctx.render();
          toast(result.record.deletedAt ? "הסגירה כבר נמחקה והסיכומים עודכנו" : "המחיקה הקודמת הושלמה. בינתיים נרשמה סגירה חדשה בתאריך הזה.");
          ctx.refresh(false);
          return result;
        }
        draft.conflict = true;
        draft.conflictPath = result.path;
        draft.conflictMessage =
          "השמירה הקודמת כבר הושלמה בחנות. העריכות שלך נשארו בטיוטה; טען את הרשומה שנשמרה לפני שמירה נוספת.";
      }
      await persist(true);
      lock();
      if (draft.conflict) showConflict();
      return result;
    })().finally(() => {
      cancellationPromise = null;
    });
    return cancellationPromise;
  };
  if (!draft.restored) draft.initialFields ||= structuredClone(draft.fields);
  submit.dataset.label = submit.textContent;
  lock();
  persist();
  if (draft.conflict) showConflict();
  cancelButton.onclick = async () => {
    if (!draft.pending || submit.disabled) return;
    submit.disabled = true;
    cancelButton.disabled = true;
    const pending = draft.pending;
    draft.cancelPending = cancellationFor(pending);
    draft.pending = null;
    try {
      // Persist the unresolved identity before allowing fields to change.
      await persist(true);
    } catch (err) {
      draft.pending = pending;
      delete draft.cancelPending;
      error.hidden = false;
      error.textContent = errorText(err);
      submit.disabled = false;
      lock();
      return;
    }
    error.hidden = true;
    submit.disabled = false;
    lock();
    try {
      await resolveCancellation();
    } catch (err) {
      if (active()) {
        error.hidden = false;
        error.textContent = errorText(err);
      }
    }
  };
  const discard = form.querySelector("[data-discard-draft]");
  if (discard)
    discard.onclick = async () => {
      if (
        draft.pending ||
        submit.disabled ||
        (!options.skipDiscardConfirmation && !confirm(options.discardConfirmation || "למחוק את הטיוטה מהמכשיר? רשומות שכבר נשמרו בחנות יישארו."))
      )
        return;
      disposed = true;
      submit.disabled = true;
      discard.disabled = true;
      try {
        if (draft.cancelPending)
          await ctx.drafts.save(
            "cancelled-" + draft.cancelPending.mutationId,
            draft.cancelPending,
          );
        await ctx.drafts.remove(key);
        if (key === "invoice") await removeLinkedScan(ctx, draft);
        ctx.closeModal();
        ctx.render();
        if (draft.cancelPending) {
          toast("הטיוטה נמחקה. אפשר לבדוק את השמירה הקודמת בהגדרות.");
          ctx.refresh(false);
        }
      } catch (err) {
        disposed = false;
        submit.disabled = false;
        error.hidden = false;
        error.textContent = errorText(err);
        lock();
      }
    };
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (submit.disabled) return;
    error.hidden = true;
    submit.disabled = true;
    ctx.setModalBusy(true);
    try {
      if (draft.cancelPending) await resolveCancellation();
      if (!active()) return;
      if (draft.cancelPending)
        throw Error("יש לבדוק את השמירה הקודמת לפני שמירה חדשה.");
      if (draft.conflict)
        throw Error("יש לטעון את הגרסה העדכנית לפני שמירה נוספת.");
      if (!draft.pending) {
        draft.fields = collect();
        // The photograph opened the questions without waiting to be uploaded.
        // This is the step that cannot proceed without it: an invoice is never
        // saved without the pages it was typed from, and a failed background
        // upload is retried here, where the person is watching.
        if (key === "invoice" && draft.fromScan && !draft.fields.attachmentIds?.length) {
          // The draft status line belongs to the save-a-draft cycle, which
          // overwrites it; the button is the one place that stays put. lock()
          // restores its label as soon as the mutation exists.
          submit.textContent = "מסיים להעלות את הצילום…";
          draft.fields.attachmentIds = await uploadScanPages(ctx);
        }
        draft.pending = onSubmit(draft.fields);
        await persist(true);
      }
      lock();
      if (!active()) return;
      const result = await ctx.api.save(draft.pending);
      if (!active()) return;
      // A confirmed server write must never turn into a failed save because
      // local cleanup is unavailable. Keep the original pending identity on disk.
      try {
        await ctx.drafts.remove(key);
        if (key === "invoice") await removeLinkedScan(ctx, draft);
      } catch {
        ctx.draftWarning = "השמירה בחנות הושלמה. לא ניתן לנקות כרגע את הטיוטה במכשיר.";
      }
      if (!active()) return;
      for (const related of result.relatedRecords || [])
        ctx.mergeRecord(related.record, related.path);
      ctx.mergeRecord(result.record, draft.pending.path);
      disposed = true;
      ctx.setModalBusy(false);
      const deletingCash = key === "cash" && draft.operation === "delete";
      if (deletingCash) {
        ctx.closeModal();
        toast(result.record.deletedAt ? "הסגירה נמחקה והסיכומים עודכנו" : "המחיקה הקודמת הושלמה. בינתיים נרשמה סגירה חדשה בתאריך הזה.");
      }
      else if (options.onSaved) options.onSaved(result);
      else if (ctx.showSaved && ["invoice", "payment", "cash"].includes(key)) ctx.showSaved(key, result.record);
      else ctx.closeModal();
      ctx.render();
      if (!deletingCash && (!ctx.showSaved || !["invoice", "payment", "cash"].includes(key))) toast(
        result.supplierAction === "created"
          ? `נפתח ספק חדש: ${result.relatedRecords[0].record.name}. אפשר לערוך אותו דרך ניהול ספקים.`
          : key === "supplier" && draft.operation === "delete" ? "הספק הועבר לסל המחזור · ניתן לשחזר במשך 30 יום"
          : key === "supplier" && draft.operation === "restore" ? "הספק שוחזר"
          : key === "invoice" ? "החשבונית נשמרה · " + monthLabel((result.record.invoiceDate || draft.fields.invoiceDate)?.slice(0, 7))
          : "נשמר בחנות",
      );
      ctx.refresh(false);
    } catch (err) {
      if (!active()) return;
      error.hidden = false;
      error.textContent = errorText(err);
      if (err.status && err.status < 500 && ![408, 429].includes(err.status)) {
        draft.pending = null;
        if (err.code === "VERSION_CONFLICT") {
          draft.conflict = true;
        }
        lock();
        if (options.onError) await options.onError(err);
      }
      await persist();
      if (draft.conflict) showConflict();
      lock();
    } finally {
      submit.disabled = false;
      if (active()) ctx.setModalBusy(false);
      lock();
    }
  });
  return { persist, lock };
}
export const footer = (label, discardLabel = "מחק טיוטה") =>
  `<div class="form-error" role="alert" data-form-error hidden></div><footer class="form-footer"><small data-draft-status>שומר טיוטה…</small><p class="notice" role="status" data-cancellation-status hidden></p><button class="primary" type="submit">${e(label)}</button><button class="secondary" type="button" data-cancel-attempt hidden>בטל את הניסיון</button><button class="text-button danger" type="button" data-discard-draft>${e(discardLabel)}</button></footer>`;
const textArea = (name, value, label) =>
  `<label class="field wide"><span>${e(label)}</span><textarea name="${name}" rows="2" maxlength="4000">${e(value)}</textarea></label>`;

export async function retainDraft(ctx, key, old) {
  let name = `saved-${key}-${old.recordId}`;
  if (await ctx.drafts.load(name)) name += "-" + crypto.randomUUID();
  await ctx.drafts.save(name, { ...old, kind: key });
}
async function matchingDraft(ctx, key, old, record, compatible = true) {
  if (!old || !hasDraftContent(key, old)) return null;
  // Legacy drafts have no mode. A nonzero version belongs to an existing record.
  const mode = old.mode || (old.version === 0 ? "new" : "edit");
  const matches = record ? old.recordId === record.id : mode === "new";
  const stale =
    record &&
    old.version !== record.version &&
    !old.pending &&
    !old.cancelPending;
  if (compatible && matches && !stale) return { ...old, mode, restored: true };
  await retainDraft(ctx, key, old);
  return null;
}
const staleNotice = (old, record, draft) =>
  old &&
  record &&
  old.recordId === record.id &&
  old.version !== record.version &&
  !draft.pending &&
  !draft.cancelPending
    ? '<div class="notice warning">הרשומה עודכנה מאז. מוצגת הגרסה העדכנית; הטיוטה הקודמת נשמרה לעיון בהגדרות וגיבוי.</div>'
    : "";

export async function supplierForm(ctx, record = null) {
  const key = "supplier",
    old = await ctx.drafts.load(key);
  if (["delete", "restore"].includes(old?.operation) && record?.id === old.recordId)
    return supplierRemovalForm(ctx, record || ctx.data.suppliers.find(s => s.id === old.recordId), old);
  const draft = (await matchingDraft(ctx, key, old, record)) || {
    mode: record ? "edit" : "new",
    recordId: record?.id || crypto.randomUUID(),
    version: record?.version || 0,
    fields: {
      name: record?.name || "",
      contact: record?.contact || "",
      notes: record?.notes || "",
      active: record?.active === false ? "no" : "yes",
      taxIds: (record?.taxIds || []).join(", "),
    },
  };
  const f = draft.fields;
  const root = ctx.dialog(
    record ? "עריכת ספק" : "הוספת ספק",
    `${staleNotice(old, record, draft)}<form id="supplier-form"><div class="form-grid">${field("שם הספק", "name", f.name, { required: true, wide: true })}${field("פרטי קשר (רשות)", "contact", f.contact, { wide: true })}${field("מספרי ח.פ / ע.מ (רשות)", "taxIds", f.taxIds, { wide: true, hint: "לפי המספרים האלה חשבוניות סרוקות משויכות לספק הזה. הם נוספים לבד כשמאשרים סריקה. אפשר להפריד בפסיק." })}${textArea("notes", f.notes, "הערות")}${select("מצב ספק", "active", f.active, { yes: "פעיל", no: "לא פעיל — נשאר בהיסטוריה" }, { wide: true })}</div>${footer("שמור ספק", record ? "בטל את שינויי הטיוטה" : "מחק טיוטה")}${record ? `<section class="supplier-removal"><button class="text-button danger" type="button" data-remove-supplier>מחק ספק מהחנות</button><p class="small muted">הספק יעבור לסל המחזור ל־30 יום. החשבוניות שלו יישארו בהיסטוריה.</p></section>` : ""}</form>`,
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
          taxIds: parseTaxIds(values.taxIds),
        },
        draft.version,
      ),
  );
  const remove = form.querySelector("[data-remove-supplier]");
  if (remove) remove.onclick = async () => {
    if (draft.pending || draft.cancelPending || draft.conflict || form.querySelector("[type=submit]").disabled) return;
    try { await supplierRemovalForm(ctx, record); }
    catch (err) { toast(errorText(err), true); }
  };
}
export async function supplierRemovalForm(ctx, record, existing = null, operation = "delete") {
  const draft = existing || { operation, mode: "edit", recordId: record.id, version: record.version, fields: { name: record.name } };
  const restore = draft.operation === "restore";
  const root = ctx.dialog(restore ? "שחזור ספק" : "מחיקת ספק", `<form class="delete-form"><p>${restore ? "לשחזר את הספק" : "האם אתה בטוח שברצונך למחוק את הספק"} <strong>${e(draft.fields.name)}</strong>?</p><p class="muted">${restore ? "הספק יחזור לרשימת הספקים." : "הספק יוסר מהרשימה ויהיה ניתן לשחזר אותו מסל המחזור במשך 30 יום. החשבוניות והצילומים שלו יישארו בהיסטוריה."}</p>${footer(restore ? "כן, שחזר ספק" : "כן, מחק ספק", "לא, חזור")}</form>`);
  bindDraft(ctx, root.querySelector("form"), "supplier", draft, () => draft.fields,
    () => pendingMutation("suppliers/" + draft.recordId + (restore ? "/restore" : ""), null, draft.version, restore ? "POST" : "DELETE"), { skipDiscardConfirmation: true });
}

export async function preferencesForm(ctx) {
  const record = ctx.data.settings?.find(s => s.id === "accounting");
  const old = await ctx.drafts.load("preferences");
  const draft = old || { recordId: "accounting", version: record?.version || 0, fields: { rate: String((record?.defaultVatBasisPoints ?? 1800) / 100) } };
  const root = ctx.dialog("ברירת מחדל למע״מ", `<form>${field("שיעור מע״מ באחוזים", "rate", draft.fields.rate, { required: true })}<p class="small muted">יוצע כשהמע״מ לא נקלט בסריקה. החישוב מתבצע רק אחרי בחירה שלך.</p>${footer("שמור הגדרה")}</form>`);
  bindDraft(ctx, $("form", root), "preferences", draft, () => formObject($("form", root)), values => {
    const rate = parseMoney(values.rate);
    if (rate < 0 || rate > 10000) throw Error("יש לבחור שיעור בין 0 ל־100 אחוזים.");
    return pendingMutation("settings/accounting", { defaultVatBasisPoints: rate }, draft.version);
  });
}
// A wrong identifier would keep sending a supplier's invoices to the wrong
// place, so the field is editable and its check digit is verified before the
// save leaves, naming the number that failed rather than the whole field.
export function parseTaxIds(value) {
  const ids = [];
  for (const token of String(value || "").split(/[,;\s]+/).filter(Boolean)) {
    if (!isValidTaxId(token))
      throw Error(`מספר ח.פ/ע.מ אינו תקין: ${token}. יש לבדוק את הספרות.`);
    const id = normalizeTaxId(token);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
export function invoiceMutation(
  draft,
  values,
  record = null,
  knownInvoices = [],
) {
      if (!["invoice", "credit"].includes(values.documentType) && !(record && values.documentType === record.documentType))
        throw Error("יש לבחור סוג מסמך לפי התעודה.");
      if (values.deductions.some((d) => d.included === "unknown"))
        throw Error("יש לבדוק אם כל הפחתה כבר כלולה בסכום המסמך.");
      if (!values.supplierId || draft.supplierConflict)
        throw Error("יש לבחור ספק או לאשר פתיחת ספק חדש לפני השמירה.");
      const pending = pendingMutation(
        "invoices/" + draft.recordId,
        {
          supplierId: values.supplierId,
          ...(draft.newSupplier
            ? {
                newSupplier: {
                  name: draft.newSupplier.name,
                  taxIds: draft.newSupplier.taxIds || [],
                },
              }
            : {}),
          ...(draft.reactivateSupplier
            ? {
                reactivateSupplier: {
                  expectedVersion: draft.reactivateSupplier.expectedVersion,
                },
              }
            : {}),
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
          attachmentIds: draft.fields.attachmentIds,
          source: "manual",
          reviewConfirmed: values.review === "on",
          ...(values.duplicateAllowed ? { duplicateAllowed: true } : {}),
        },
        draft.version,
      );
      if (pending.body.data.documentType === "credit") {
        for (const key of ["subtotalAgorot", "vatAgorot", "totalAgorot", "finalAgorot"])
          if (pending.body.data[key] !== null) pending.body.data[key] = -Math.abs(pending.body.data[key]) || 0;
      }
      if (creditSignIssues(pending.body.data).length)
        throw Error(
          "סכום הזיכוי והסכום הסופי חייבים להיות גדולים מאפס.",
        );
      // Checked on the finished figures, signs and all, so it asks exactly what
      // the store asks. The store refuses this too; here it is caught before
      // the save, where the invoice already entered can still be pointed at.
      // An invoice with nothing to be told apart from keeps its own claim, so a
      // permission given and then edited away does not follow it around.
      const twin = findDuplicateInvoice(knownInvoices, pending.body.data, record?.id || draft.recordId);
      if (!twin && !draft.duplicateConflict)
        delete pending.body.data.duplicateAllowed;
      else if (twin && !pending.body.data.duplicateAllowed)
        throw Error(
          "כנראה כבר קלטת את החשבונית הזאת. אם זו בכל זאת חשבונית אחרת, אשר זאת בהודעה שבטופס.",
        );
      return pending;
}

export async function invoiceForm(
  ctx,
  record = null,
  manualAttachments = [],
  options = {},
) {
  const key = "invoice",
    old = await ctx.drafts.load(key);
  let draft = await matchingDraft(ctx, key, old, record, !manualAttachments.length);
  if (!draft) {
    draft = {
      mode: record ? "edit" : "new",
      recordId: record?.id || crypto.randomUUID(),
      version: record?.version || 0,
      fields: {
        // Only a brand-new draft is seeded: an intake already under way keeps
        // whichever supplier it was typed with.
        supplierId: record?.supplierId || options.supplier?.id || "",
        supplierName: record
          ? ctx.data.suppliers.find((s) => s.id === record.supplierId)?.name || ""
          : options.supplier?.name || "",
        documentNumber: record?.documentNumber || "",
        // An invoice already told apart from its twin is not asked about again
        // when it is edited or paid.
        duplicateAllowed: Boolean(record?.duplicateAllowed),
        invoiceDate: record?.invoiceDate || today(),
        documentType: record?.documentType || "invoice",
        subtotal: moneyInput(record?.subtotalAgorot),
        vat: moneyInput(record?.vatAgorot),
        total: moneyInput(record?.totalAgorot),
        final: moneyInput(record?.finalAgorot),
        notes: record?.notes || "",
        deductions: (record?.deductions || []).map((d) => ({
          label: d.label || "",
          amount: moneyInput(d.amountAgorot),
          included:
            d.includedInTotal === null
              ? "unknown"
              : d.includedInTotal
                ? "yes"
                : "no",
        })),
        attachmentIds: record?.attachmentIds || manualAttachments,
        source: "manual",
      },
      fromScan: Boolean(options.fromScan),
    };
  }
  const f = draft.fields;
  // The pages are recorded on the draft the moment they land, so the summary
  // can offer the photograph and the save has nothing left to wait for. This
  // joins the upload the scan screen already started; it never starts a second.
  if (draft.fromScan && !f.attachmentIds?.length)
    void uploadScanPages(ctx)
      .then(ids => { if (ids.length && !f.attachmentIds?.length) f.attachmentIds = ids; })
      .catch(() => {});
  if (f.supplierName === undefined)
    f.supplierName =
      draft.newSupplier?.name ||
      ctx.data.suppliers.find((s) => s.id === f.supplierId)?.name ||
      "";
  // A new invoice is a short run of questions typed from the paper; a resumed
  // draft stays in the flow it began in. The full form edits saved invoices
  // and stays behind the questions for the complex case.
  if (!record && !options.fullEditor && (options.quick || draft.quick)) return quickInvoiceReview(ctx, draft, {
    bindDraft, footer, buildMutation: values => invoiceMutation(draft, values, null, ctx.data.invoices),
    // An empty form saves no draft, so the supplier the folder supplied has to
    // travel with the request for the detailed editor too.
    openEditor: () => invoiceForm(ctx, null, [], { fullEditor: true, supplier: options.supplier }),
  });
  // A new invoice is typed in the order it is read off the paper. Editing a
  // saved one is almost always a correction of one number or of the payment, so
  // those come first and the rest — the supplier, the date, the kind of
  // document — waits behind a fold instead of standing between him and the
  // number he came to fix.
  const editing = Boolean(record);
  const identity = `${supplierPickerMarkup(f)}
      ${field("מספר חשבונית (רשות)", "documentNumber", f.documentNumber)}${field("תאריך החשבונית", "invoiceDate", f.invoiceDate, { type: "date", required: true })}
      ${select("סוג מסמך", "documentType", f.documentType, { "": "בחר סוג מסמך", invoice: "חשבונית", credit: "חשבונית זיכוי", ...(record && !["invoice", "credit"].includes(record.documentType) ? { [record.documentType]: types[record.documentType] + " (רישום קיים)" } : {}) }, { wide: true, required: true })}${field("לפני מע״מ (רשות)", "subtotal", f.subtotal)}`;
  const vatField = field("מע״מ כפי שרשום", "vat", f.vat, { hint: "לא ידוע? השאר ריק. 0 רק כשאין מע״מ." });
  const totalField = field("סכום כולל מע״מ", "total", f.total, { required: true, wide: true });
  const finalField = field("סכום סופי לתשלום", "final", f.final, { required: true, wide: true });
  const calculateButton = '<button type="button" class="text-button wide" id="calculate-final">מלא לפי הסכום וההפחתות שהזנתי</button>';
  const notesArea = textArea("notes", f.notes, "הערות (רשות)");
  const deductionsSection = `<section class="deductions"><div class="section-label"><h3>הפחתות וניכויים</h3><button type="button" class="text-button" id="add-deduction">${icon("plus")} הוסף שורה</button></div><div id="deductions-list"></div><small>סמן אם ההפחתה כבר כלולה בסכום המסמך, כדי שלא תרד פעמיים.</small></section>`;
  const notices = `<div class="notice warning wide" data-credit-notice hidden>הזן את גובה הזיכוי כמספר חיובי. לדוגמה: 30 ₪ יירשמו כהפחתה של 30 ₪ לפי סוג המסמך.</div>
    <div id="arithmetic-note" class="notice warning" hidden></div>
    <div data-duplicate-slot></div>`;
  const attachments = f.attachmentIds.length ? `<div class="attachment-links"><strong>המסמך המצורף</strong>${f.attachmentIds.map((id, i) => `<button type="button" class="secondary" data-open-document="${e(id)}">פתח עמוד / קובץ ${i + 1}</button>`).join("")}</div>` : "";
  // The payment is the other half of what gets corrected — a method chosen by
  // mistake, a check whose number was never written down, an invoice that was
  // never paid at all — so the way to it sits on this screen rather than back
  // in a menu he has to find again.
  const paid = record?.status === "paid", payment = record?.payment;
  const paymentSummary = paid && payment
    ? `שולם ב${methods[payment.method] || ""} · ${displayDate(payment.paymentDate)}${payment.method === "check" ? " · צ׳ק " + (payment.checkNumber || "ללא מספר") : ""}`
    : "החשבונית עדיין לא סומנה כשולמה";
  const paymentSection = editing ? `<section class="edit-payment"><h3>התשלום</h3>
    <button type="button" class="secondary edit-payment-row" data-edit-payment><span><strong>${e(paymentSummary)}</strong><small>${paid ? "שינוי אמצעי התשלום, יום התשלום או פרטי הצ׳ק" : "סימון ששולמה ורישום פרטי התשלום"}</small></span>${icon("arrow")}</button>
    ${paid ? '<button type="button" class="text-button" data-edit-unpay>טעיתי — החשבונית לא שולמה</button>' : ""}</section>` : "";
  const review = '<label class="checkbox"><input name="review" type="checkbox" required> בדקתי את הפרטים ואת הסכום לתשלום</label>';
  const body = editing
    ? `<div class="form-grid">${totalField}${vatField}</div><div data-final-slot><div class="form-grid">${finalField}${calculateButton}</div></div>${notices}
    ${paymentSection}
    <details class="edit-rest"><summary>שאר פרטי החשבונית</summary><div class="form-grid">${identity}</div>${deductionsSection}<div class="form-grid">${notesArea}</div>${attachments}</details>`
    : `<div class="form-grid">${identity}${vatField}${totalField}</div>${deductionsSection}<div class="form-grid">${finalField}${calculateButton}${notesArea}</div>${notices}${attachments}`;
  const root = ctx.dialog(
    record ? "עריכת חשבונית" : "הוספת חשבונית",
    `${staleNotice(old, record, draft)}<form id="invoice-form">${body}${review}${footer("שמור חשבונית")}</form>`,
  );
  const form = $("form", root);
  const renderDeductions = () => {
    $("#deductions-list", form).innerHTML = f.deductions
      .map(
        (d, i) =>
          `<div class="deduction-row" data-index="${i}">${field("סיבת ההפחתה", "deduction-label-" + i, d.label, { required: true })}${field("סכום", "deduction-amount-" + i, d.amount, { required: true })}${select("כלולה בסכום המסמך?", "deduction-included-" + i, d.included, { unknown: "יש לבדוק", yes: "כן, כבר כלולה", no: "לא, להפחית בנוסף" })}<button class="icon-button danger" type="button" aria-label="הסר הפחתה" data-remove-deduction="${i}">${icon("close")}</button></div>`,
      )
      .join("");
  };
  renderDeductions();
  const creditNoticeElement = $("[data-credit-notice]", form);
  // The warning belongs beside the amounts it is about. While the kind of
  // document is being chosen that is right under the chooser; when editing, the
  // chooser is folded away and the notice stays up with the amounts.
  if (!editing) form.elements.documentType.closest(".field").after(creditNoticeElement);
  const creditNotice = () => {
    const isCredit = form.elements.documentType.value === "credit";
    creditNoticeElement.hidden = !isCredit;
    for (const name of ["subtotal", "vat", "total", "final"]) {
      const input = form.elements[name];
      input.inputMode = "decimal";
      if (isCredit && !draft.pending && input.value.trim()) {
        try { input.value = moneyInput(Math.abs(parseMoney(input.value))); }
        catch { /* Leave an incomplete entry for the user to finish. */ }
      }
    }
  };
  creditNotice();
  form.elements.documentType.addEventListener("input", creditNotice);
  form.elements.documentType.addEventListener("change", creditNotice);
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
  let supplierPicker;
  const binding = bindDraft(
    ctx,
    form,
    key,
    draft,
    collect,
    (values) => invoiceMutation(draft, values, record, ctx.data.invoices),
    {
      onError: async (err) => {
        if (["SUPPLIER_EXISTS", "SUPPLIER_CHANGED"].includes(err.code))
          await supplierPicker.recover(err);
        if (err.code === "DUPLICATE_INVOICE_DETAILS") {
          draft.duplicateConflict = err.details?.invoiceId || "";
          showDuplicate();
        }
      },
    },
  );
  supplierPicker = bindSupplierPicker(ctx, form, draft, {
    collect,
    persist: binding.persist,
  });
  // The same invoice, typed a second time, differs from this one in nothing a
  // person would notice, so it is named while the amounts are being typed.
  const showDuplicate = () => {
    const values = collect();
    let candidate = null;
    try {
      const sign = (amount) =>
        amount === null || values.documentType !== "credit"
          ? amount
          : -Math.abs(amount);
      candidate = {
        supplierId: values.supplierId,
        documentType: values.documentType,
        invoiceDate: values.invoiceDate,
        totalAgorot: sign(parseMoney(values.total, true)),
        vatAgorot: sign(parseMoney(values.vat, true)),
      };
    } catch {
      /* A half-typed amount names nothing yet. */
    }
    const twin = duplicateShown(
      ctx.data.invoices,
      candidate,
      record?.id || draft.recordId,
      draft.duplicateConflict,
    );
    $("[data-duplicate-slot]", form).innerHTML = duplicateNotice(twin, {
      supplierName:
        ctx.data.suppliers.find((s) => s.id === twin?.supplierId)?.name || "",
      allowed: Boolean(f.duplicateAllowed),
    });
  };
  $("#add-deduction", form).onclick = () => {
    Object.assign(f, collect());
    if (f.deductions.length >= 30) return;
    f.deductions.push({ label: "", amount: "", included: "no" });
    renderDeductions();
    syncFinal();
    draft.fields = f;
    binding.persist();
  };
  form.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-remove-deduction]");
    if (b) {
      Object.assign(f, collect());
      f.deductions.splice(Number(b.dataset.removeDeduction), 1);
      renderDeductions();
      syncFinal();
      draft.fields = f;
      binding.persist();
    }
    if (ev.target.closest("[data-confirm-duplicate]") && !draft.pending) {
      Object.assign(f, collect(), { duplicateAllowed: true });
      draft.fields = f;
      showDuplicate();
      binding.persist();
    }
  });
  $("#calculate-final", form).onclick = () => {
    try {
      const values = collect();
      if (values.deductions.some((d) => d.included === "unknown"))
        throw Error("בדוק קודם אם ההפחתות כלולות בסכום.");
      const calculated =
        (values.documentType === "credit" ? -Math.abs(parseMoney(values.total)) : parseMoney(values.total)) -
        values.deductions
          .filter((d) => d.included === "no")
          .reduce((sum, d) => sum + parseMoney(d.amount), 0);
      if (
        form.elements.final.value &&
        !confirm("לעדכן את הסכום הסופי ל־" + money(calculated) + "?")
      )
        return;
      form.elements.final.value = moneyInput(values.documentType === "credit" ? Math.abs(calculated) : calculated);
      form.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  // Two amount fields holding the same number are two chances to get it wrong.
  // While nothing is deducted, the amount to pay is the document's amount, so
  // one field is shown and the other follows it. An invoice whose two amounts
  // already differ keeps both: that difference is real and is not overwritten.
  const finalSlot = $("[data-final-slot]", form);
  let mirrorFinal = editing && !f.deductions.length && f.total.trim() !== "" && f.final.trim() === f.total.trim();
  const syncFinal = () => {
    if (!finalSlot) return;
    if (mirrorFinal && f.deductions.length) mirrorFinal = false;
    finalSlot.hidden = mirrorFinal;
    if (mirrorFinal) form.elements.final.value = form.elements.total.value;
  };
  syncFinal();
  if (editing) {
    $("[data-edit-payment]", form).onclick = () => {
      if (draft.pending || ctx.modalBusy) return;
      // Whatever was typed here is already in the draft, so the way back finds
      // it again; the invoice itself is re-read in case the payment changed it.
      const current = () => ctx.data.invoices.find(i => i.id === record.id) || record;
      paymentForm(ctx, current(), { onBack: () => invoiceForm(ctx, current(), [], options) });
    };
    const unpayButton = $("[data-edit-unpay]", form);
    if (unpayButton) unpayButton.onclick = () => {
      if (draft.pending || ctx.modalBusy) return;
      void ctx.unpay?.(record.id);
    };
    // He came here from the invoice, so Back belongs to the invoice — not out
    // of everything, which is what it used to do from the detailed editor.
    if (options.onBack) ctx.modalBack = () => {
      if (ctx.modalBusy) return;
      if (draft.pending) { ctx.closeModal(); return; }
      options.onBack();
    };
  }
  // A required field folded out of sight cannot be focused, and the browser
  // then refuses the save without saying why. The fold opens for it.
  form.addEventListener("invalid", ev => { ev.target.closest("details")?.setAttribute("open", ""); }, true);
  form.addEventListener("input", () => {
    syncFinal();
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
    // A detail typed over is a different invoice from the one the store
    // refused, so its refusal stops speaking for what is in the form now.
    delete draft.duplicateConflict;
    showDuplicate();
  });
  showDuplicate();
}
export async function paymentForm(ctx, record, { onBack = null } = {}) {
  const key = "payment",
    savedDraft = await ctx.drafts.load(key),
    old = savedDraft?.batchSupplierId ? null : savedDraft;
  if (savedDraft?.batchSupplierId) await retainDraft(ctx, key, savedDraft);
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
  const supplier = ctx.data.suppliers.find(s => s.id === record.supplierId)?.name || "הספק";
  const root = ctx.dialog(
    // Reached from the edit screen, this is a correction, not a first marking.
    record.status === "paid" ? "עדכון פרטי התשלום" : "סימון חשבונית כשולמה",
    `<form class="payment-form"><div class="payment-amount"><span><strong>${e(supplier)}</strong> · ${e(invoiceLabel(record))}</span><strong>${e(money(record.finalAgorot))}</strong></div>
      <input type="hidden" name="method" value="${e(f.method)}">
      <section data-payment-methods><h3>איך שילמת?</h3><div class="payment-methods">${Object.entries(methods).map(([value, label]) => `<button type="button" class="secondary" data-payment-method="${value}" aria-pressed="${value === f.method}">${e(label)}</button>`).join("")}</div></section>
      <section data-payment-details><div class="payment-selected"><strong data-selected-method></strong><button type="button" class="text-button" data-change-method>שנה אמצעי תשלום</button></div>
      <div class="form-grid">${field("באיזה יום מסרת את הצ׳ק?", "paymentDate", f.paymentDate, { type: "date", required: true, wide: true })}
      <div class="notice wide" id="check-notice">תאריך המסירה לספק נשמר כתאריך התשלום.</div><div id="check-fields" class="wide">${field("מספר צ׳ק (רשות)", "checkNumber", f.checkNumber)}</div>
      <details class="payment-optional wide" open><summary>פרטים נוספים (רשות)</summary><div data-check-due>${field("מועד פירעון הצ׳ק (רשות)", "checkDueDate", f.checkDueDate, { type: "date" })}</div>${textArea("notes", f.notes, "הערה לתשלום (רשות)")}</details></div></section>
      ${footer(record.status === "paid" ? "עדכן פרטי תשלום" : "אשר תשלום", "בטל את רישום התשלום")}</form>`,
  );
  const form = $("form", root),
    update = () => {
      const check = form.elements.method.value === "check";
      $("#check-fields", form).hidden = !check;
      $("#check-notice", form).hidden = !check;
      $("[data-check-due]", form).hidden = !check;
      form.elements.paymentDate.closest("label").querySelector("span").textContent = check ? "באיזה יום מסרת את הצ׳ק?" : "באיזה יום שילמת?";
      $("[data-selected-method]", form).textContent = methods[form.elements.method.value];
      form.querySelectorAll("[data-payment-method]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.paymentMethod === form.elements.method.value)));
      const choosing = !draft.paymentDetails && !draft.restored && record.status !== "paid" && !draft.pending;
      $("[data-payment-methods]", form).hidden = !choosing;
      $("[data-payment-details]", form).hidden = choosing;
      $("[type=submit]", form).hidden = choosing;
    };
  update();
  form.elements.method.addEventListener("change", update);
  form.querySelectorAll("[data-payment-method]").forEach(b => {
    b.onclick = () => {
      if (draft.pending || b.disabled) return;
      form.elements.method.value = b.dataset.paymentMethod;
      draft.paymentDetails = true;
      form.dispatchEvent(new Event("input", { bubbles: true }));
      update();
      $("[data-payment-details]", form).scrollIntoView?.({ block: "nearest" });
    };
  });
  $("[data-change-method]", form).onclick = () => {
    if (draft.pending) return;
    $("[data-payment-methods]", form).hidden = false;
    $("[data-payment-details]", form).hidden = true;
    $("[type=submit]", form).hidden = true;
  };
  ctx.modalBack = () => {
    if (ctx.modalBusy) return;
    if (draft.pending) { ctx.closeModal(); return; }
    // Back retreats to the method chooser only when that chooser was a step he
    // actually came through. Correcting a payment already recorded opens on the
    // details, so Back there means back out, not into a question he never saw.
    if (draft.paymentDetails && !$("[data-payment-details]", form).hidden) $("[data-change-method]", form).click();
    else if (onBack) onBack();
    else ctx.closeModal();
  };
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
export async function cashForm(ctx, record = null, resumeDate = null) {
  const key = "cash",
    old = await ctx.drafts.load(key);
  const targetDate = record?.id || resumeDate || today();
  if (old?.operation === "delete" && old.recordId === targetDate && (record || resumeDate))
    return cashRemovalForm(ctx, record, old);
  // A deleted day can be entered again, but never prefill its old amounts.
  if (record?.deletedAt) record = null;
  const draft = (await matchingDraft(
    ctx,
    key,
    old,
    record,
    old?.recordId === targetDate,
  )) || {
    mode: record ? "edit" : "new",
    recordId: targetDate,
    version: record?.version || 0,
    fields: {
      date: targetDate,
      cash: moneyInput(record?.cashAgorot),
      ravKav: moneyInput(record?.ravKavAgorot),
      notes: record?.notes || "",
    },
  };
  const f = draft.fields;
  const root = ctx.dialog(
    record ? "עריכת סגירה יומית" : "רישום סגירה יומית",
    `${staleNotice(old, record, draft)}<form><p class="muted">שני סכומים נפרדים. הקופה אינה כוללת רב־קו.</p><div class="form-grid">${field("תאריך", "date", f.date, { type: "date", required: true, wide: true })}${field("קופה", "cash", f.cash, { wide: true })}${field("רב־קו", "ravKav", f.ravKav, { wide: true })}${textArea("notes", f.notes, "הערה (רשות)")}</div>${footer("שמור סגירה יומית", record ? "בטל שינויים שלא נשמרו" : "מחק טיוטה")}${record ? '<section class="supplier-removal"><button class="text-button danger" type="button" data-remove-cash>מחק סגירה מהחנות</button><p class="small muted">הסגירה תוסר מהרשימה ומהסיכומים.</p></section>' : ""}</form>`,
  );
  const form = $("form", root);
  if (draft.version) form.elements.date.readOnly = true;
  bindDraft(
    ctx,
    form,
    key,
    draft,
    () => {
      const values = formObject(form);
      if (!draft.version && !draft.pending && values.date)
        draft.recordId = values.date;
      return values;
    },
    (values) => {
      const existing = ctx.data.dailyCash.find((r) => r.id === values.date);
      if (draft.version && values.date !== draft.recordId)
        throw Error("לרישום בתאריך אחר יש לפתוח סגירה יומית חדשה.");
      if (existing && !existing.deletedAt && (!draft.version || existing.id !== draft.recordId))
        throw Error("כבר קיימת סגירה בתאריך הזה. יש לפתוח אותה לעריכה.");
      const replaceDeleted = existing?.deletedAt && !draft.version;
      draft.recordId = values.date;
      return pendingMutation(
        "daily-cash/" + values.date + (replaceDeleted ? "/restore" : ""),
        {
          date: values.date,
          cashAgorot: parseMoney(values.cash, true),
          ravKavAgorot: parseMoney(values.ravKav, true),
          notes: values.notes,
        },
        replaceDeleted ? existing.version : draft.version,
        replaceDeleted ? "POST" : "PUT",
      );
    },
    { discardConfirmation: record ? "לבטל את השינויים שלא נשמרו? הסגירה השמורה תישאר בחנות." : undefined },
  );
  const remove = form.querySelector("[data-remove-cash]");
  if (remove) remove.onclick = async () => {
    if (draft.pending || draft.cancelPending || draft.conflict || form.querySelector("[type=submit]").disabled) return;
    try {
      // Keep any unsaved edits for review before the delete attempt takes over.
      if (hasDraftContent(key, draft)) await retainDraft(ctx, key, draft);
      await cashRemovalForm(ctx, record);
    } catch (err) { toast(errorText(err), true); }
  };
}

async function cashRemovalForm(ctx, record, existing = null) {
  const draft = existing || {
    operation: "delete", mode: "edit", recordId: record.id, version: record.version,
    fields: { date: record.date, cash: moneyInput(record.cashAgorot), ravKav: moneyInput(record.ravKavAgorot) },
  };
  const root = ctx.dialog("מחיקת סגירה יומית", `<form class="delete-form"><p>למחוק את הסגירה של <strong>${e(displayDate(draft.fields.date))}</strong>?</p><p>קופה: ${e(draft.fields.cash || "לא הוזן")} · רב־קו: ${e(draft.fields.ravKav || "לא הוזן")}</p><p class="muted">הסגירה תימחק מהחנות ותוסר מהרשימה ומהסיכומים בכל המכשירים.</p>${footer("כן, מחק סגירה", "לא, חזור")}</form>`);
  bindDraft(ctx, root.querySelector("form"), "cash", draft, () => draft.fields,
    () => pendingMutation("daily-cash/" + draft.recordId, null, draft.version, "DELETE"),
    { skipDiscardConfirmation: true, retryLabel: "נסה שוב למחוק" });
}
