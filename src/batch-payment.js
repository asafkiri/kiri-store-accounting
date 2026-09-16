import { $, field, icon, formObject } from "./ui.js";
import { escapeHtml as e, money, displayDate, monthLabel, today, methods } from "./format.js";
import { pendingMutation } from "./api.js";
import { bindDraft, footer, retainDraft } from "./forms.js";

// The candidates already arrive oldest first, the order a debt is settled in.
// Headings only say where one month ends and the next begins; they never
// reorder what is underneath, so "select all" still takes the oldest fifty.
function candidateMonths(candidates) {
  const months = new Map();
  for (const invoice of candidates) {
    const month = invoice.invoiceDate?.slice(0, 7) || "";
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(invoice);
  }
  return [...months];
}

export async function batchPaymentForm(ctx, supplierId) {
  const key = "payment", old = await ctx.drafts.load(key);
  const compatible = old?.batchSupplierId === supplierId;
  if (old && !compatible) await retainDraft(ctx, key, old);
  const candidates = ctx.data.invoices.filter(i => !i.deletedAt && i.status === "unpaid" && i.supplierId === supplierId)
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.id.localeCompare(b.id));
  if (!compatible && !candidates.length) {
    ctx.dialog("תשלום לספק", '<p>אין לספק הזה חשבוניות פתוחות לתשלום.</p>');
    return;
  }
  const draft = compatible ? { ...old, restored: true } : {
    batchSupplierId: supplierId, recordId: candidates[0].id, version: candidates[0].version, phase: "selection",
    candidates: candidates.map(i => ({ id: i.id, version: i.version, finalAgorot: i.finalAgorot, invoiceDate: i.invoiceDate, documentType: i.documentType })),
    fields: { selectedIds: [], method: "check", paymentDate: today(), checkNumber: "", checkDueDate: "", notes: "" },
  };
  const f = draft.fields;
  const supplier = ctx.data.suppliers.find(s => s.id === supplierId)?.name || "הספק";
  const root = ctx.dialog("תשלום לכמה חשבוניות", `<form class="batch-payment-form">
    <h3>${e(supplier)}</h3><div class="batch-total" role="status" aria-live="polite" data-batch-total></div>
    <section data-batch-phase="selection"><h3>על אילו חשבוניות שילמת?</h3><p class="muted">חשבוניות פתוחות מכל החודשים. אפשר לכלול גם זיכויים.</p>
    <button type="button" class="text-button" data-select-all>${draft.candidates.length > 50 ? "בחר 50 ראשונות" : "בחר הכול"}</button>
    <div class="batch-invoice-list">${candidateMonths(draft.candidates).map(([month, rows]) =>
      `<div class="batch-month"><div class="batch-month-heading"><strong>${e(monthLabel(month))}</strong><span>${e(rows.length === 1 ? "חשבונית אחת" : rows.length + " חשבוניות")} · ${e(money(rows.reduce((sum, i) => sum + i.finalAgorot, 0)))}</span><button type="button" class="text-button" data-select-month="${e(month)}">בחר את כל החודש</button></div>${rows.map(i =>
        `<label class="batch-invoice"><input type="checkbox" name="invoiceSelection" value="${e(i.id)}" ${f.selectedIds.includes(i.id) ? "checked" : ""}><span><strong>${e(displayDate(i.invoiceDate))}</strong>${i.documentType === "credit" ? '<small>חשבונית זיכוי</small>' : ""}</span><strong>${e(money(i.finalAgorot))}</strong></label>`).join("")}</div>`).join("")}</div>
    <p class="form-error" data-selection-error role="status"></p><button type="button" class="primary" data-batch-next>המשך לפרטי התשלום</button></section>
    <input type="hidden" name="method" value="${e(f.method)}">
    <section data-batch-phase="method"><h3>איך שילמת?</h3><div class="payment-methods">${Object.entries(methods).map(([value, label]) => `<button type="button" class="secondary" data-batch-method="${value}">${e(label)}</button>`).join("")}</div><button type="button" class="text-button" data-change-selection>שנה בחירת חשבוניות</button></section>
    <section data-batch-phase="details"><div class="payment-selected"><strong data-selected-method></strong><button type="button" class="text-button" data-change-method>שנה אמצעי תשלום</button></div>
    ${field("יום התשלום", "paymentDate", f.paymentDate, { type: "date", required: true })}
    <div data-batch-check>${field("מספר צ׳ק (רשות)", "checkNumber", f.checkNumber)}</div>
    <details class="payment-optional" open><summary>פרטים נוספים (רשות)</summary><div data-batch-due>${field("מועד פירעון הצ׳ק (רשות)", "checkDueDate", f.checkDueDate, { type: "date" })}</div>${field("הערה לתשלום (רשות)", "notes", f.notes)}</details>
    <p>פרטי התשלום יירשמו לכל החשבוניות שבחרת.</p><button type="button" class="text-button" data-change-selection>שנה בחירת חשבוניות</button></section>
    ${footer("אשר תשלום", "בטל את רישום התשלום")}</form>`);
  const form = $("form", root), submit = $("[type=submit]", form);
  // Keep continuation reachable while scrolling a long supplier history.
  $(".form-footer", form).prepend($("[data-batch-next]", form));
  const collect = () => {
    const { invoiceSelection, ...values } = formObject(form);
    return { ...values, selectedIds: [...form.querySelectorAll('[name="invoiceSelection"]:checked')].map(el => el.value) };
  };
  const selection = () => draft.candidates.filter(i => collect().selectedIds.includes(i.id));
  const update = () => {
    const chosen = selection(), total = chosen.reduce((sum, i) => sum + i.finalAgorot, 0);
    const phase = draft.pending ? "details" : draft.phase;
    form.querySelectorAll("[data-batch-phase]").forEach(el => { el.hidden = el.dataset.batchPhase !== phase; });
    $("[data-batch-total]", form).textContent = `${chosen.length} חשבוניות · סה״כ לתשלום ${money(total)}`;
    $("[data-selection-error]", form).textContent = chosen.length > 50 ? "אפשר לשלם עד 50 חשבוניות בכל פעם." : total < 0 ? "סך הזיכויים גבוה מסכום החשבוניות. יש לשנות את הבחירה." : "";
    $("[data-selection-error]", form).hidden = !$("[data-selection-error]", form).textContent;
    $("[data-batch-next]", form).disabled = Boolean(draft.pending) || !chosen.length || chosen.length > 50 || total < 0;
    $("[data-batch-next]", form).hidden = phase !== "selection";
    $("[data-batch-next]", form).textContent = chosen.length ? `המשך · ${chosen.length} חשבוניות · ${money(total)}` : "בחר חשבוניות כדי להמשיך";
    const check = form.elements.method.value === "check";
    $("[data-batch-check]", form).hidden = !check; $("[data-batch-due]", form).hidden = !check;
    form.elements.paymentDate.closest("label").querySelector("span").textContent = check ? "באיזה יום מסרת את הצ׳ק לספק?" : "באיזה יום שילמת?";
    $("[data-selected-method]", form).textContent = methods[form.elements.method.value];
    submit.hidden = phase !== "details";
    if (!draft.pending) { submit.textContent = `אשר תשלום · ${money(total)}`; submit.dataset.label = submit.textContent; }
  };
  const changePhase = phase => {
    if (draft.pending || ctx.modalBusy) return;
    draft.phase = phase;
    form.dispatchEvent(new Event("input", { bubbles: true }));
    update();
    root.scrollTop = 0;
  };
  $("[data-select-all]", form).onclick = () => {
    const boxes = [...form.querySelectorAll('[name="invoiceSelection"]')], all = boxes.slice(0, 50).every(el => el.checked);
    boxes.forEach((el, index) => { el.checked = !all && index < 50; });
    form.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // A month at a time: "all of August, plus two from September" is three taps.
  form.querySelectorAll("[data-select-month]").forEach(button => { button.onclick = () => {
    const ids = new Set(draft.candidates.filter(i => i.invoiceDate?.startsWith(button.dataset.selectMonth)).map(i => i.id));
    const boxes = [...form.querySelectorAll('[name="invoiceSelection"]')];
    const month = boxes.filter(el => ids.has(el.value)), all = month.every(el => el.checked);
    month.forEach(el => { el.checked = !all; });
    // The server takes fifty at a time; anything past that stays unticked.
    boxes.filter(el => el.checked).slice(50).forEach(el => { el.checked = false; });
    form.dispatchEvent(new Event("input", { bubbles: true }));
  }; });
  $("[data-batch-next]", form).onclick = () => changePhase("method");
  form.querySelectorAll("[data-change-selection]").forEach(el => { el.onclick = () => changePhase("selection"); });
  $("[data-change-method]", form).onclick = () => changePhase("method");
  form.querySelectorAll("[data-batch-method]").forEach(el => { el.onclick = () => {
    form.elements.method.value = el.dataset.batchMethod;
    changePhase("details");
  }; });
  form.addEventListener("input", update);
  ctx.modalBack = () => {
    if (ctx.modalBusy) return;
    if (draft.pending || draft.phase === "selection") ctx.closeModal();
    else changePhase(draft.phase === "details" ? "method" : "selection");
  };
  update();
  bindDraft(ctx, form, key, draft, collect, values => {
    const chosen = selection();
    if (!chosen.length || chosen.length > 50 || draft.phase !== "details") throw Error("יש לבחור חשבוניות ולאשר את פרטי התשלום.");
    draft.recordId = chosen[0].id; draft.version = chosen[0].version;
    return pendingMutation("invoices/" + draft.recordId + "/pay-batch", null, draft.version, "POST", {
      items: chosen.map(i => ({ id: i.id, expectedVersion: i.version })),
      totalAgorot: chosen.reduce((sum, i) => sum + i.finalAgorot, 0),
      payment: { method: values.method, paymentDate: values.paymentDate, checkNumber: values.method === "check" ? values.checkNumber : "",
        checkDueDate: values.method === "check" ? values.checkDueDate || null : null, notes: values.notes },
    });
  }, {
    onLock: update,
    reloadConflict: async () => {
      await ctx.drafts.save("conflict-" + crypto.randomUUID(), { ...draft, kind: "payment" });
      await ctx.refresh(false);
      if (ctx.syncError) throw Error("לא ניתן לרענן כרגע. הבחירה נשמרה בטיוטה.");
      await ctx.drafts.remove(key);
      await batchPaymentForm(ctx, supplierId);
    },
    onSaved: result => {
      const batch = result.batch || result.record.payment?.batch;
      const saved = ctx.dialog("התשלום נרשם", `<section class="save-confirmation" role="status"><span class="saved-mark">${icon("check")}</span><h3>התשלום ל${e(supplier)} נרשם</h3><p>${batch.invoiceIds.length} חשבוניות · ${e(money(batch.totalAgorot))}</p><p>אפשר לבדוק ולתקן כל חשבונית בפרטי התשלום שלה.</p></section><button class="primary" data-batch-done>סיום וחזרה</button>`);
      $("[data-batch-done]", saved).onclick = () => ctx.closeModal();
    },
  });
}
