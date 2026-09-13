import { $, field, icon, errorText } from "./ui.js";
import { escapeHtml as e, money, moneyInput, parseMoney, displayDate, types } from "./format.js";
import { supplierPickerMarkup, bindSupplierPicker } from "./supplier-picker.js";
import { draftPageBlob } from "./image-upload.js";
import { duplicateShown, duplicateNotice } from "./duplicate-invoice.js";
import { invoiceQuestions, typedSteps, deriveMissingAmounts, amountOrNull, validInvoiceDate, vatFromInclusive, expectedFinal } from "./quick-invoice-model.js";

// A new invoice is typed from the paper, one detail at a time, and shares the
// same durable mutation/retry binding as the full edit form, which remains
// available for saved invoices and behind the questions for the complex case.
export function quickInvoiceReview(ctx, draft, { bindDraft, footer, buildMutation, openEditor }) {
  draft.quick ||= { confirmed: {} };
  const q = draft.quick, f = draft.fields;
  q.confirmed ||= {};
  const rate = ctx.data.settings?.find(s => s.id === "accounting")?.defaultVatBasisPoints ?? 1800;
  const root = ctx.dialog("פרטי החשבונית", `<form class="quick-invoice" id="invoice-form"><div data-quick-content></div>${footer("אשר ושמור חשבונית")}</form>`);
  root.classList.add("quick-modal-content");
  const form = $("form", root), content = $("[data-quick-content]", form);
  let binding, current, supplierPicker, advancing = false;
  const error = $("[data-form-error]", form), submit = $("[type=submit]", form);
  const showError = err => { error.hidden = false; error.textContent = errorText(err); };
  const collect = () => f;
  const choice = (action, text, primary = false, hint = "") => `<button type="button" class="${primary ? "primary" : "secondary"} quick-choice" data-quick-choice="${e(action)}"><strong>${e(text)}</strong>${hint ? `<small>${e(hint)}</small>` : ""}</button>`;
  const input = (label, name, value, type = "text") => field(label, name, value, { type, wide: true });
  const row = (key, label, value) => `<button type="button" class="quick-summary-row" data-edit-question="${key}" aria-label="שנה ${e(label)}"><span>${e(label)} <small class="edit-caption">תקן</small></span><strong>${e(value)}</strong></button>`;
  const signed = value => value === null ? null : f.documentType === "credit" ? -Math.abs(value) : value;
  // The invoice already entered is named on the summary, where the amounts are
  // all in and the paper is still in hand, rather than after a refused save.
  const twin = () => duplicateShown(ctx.data.invoices, {
    supplierId: f.supplierId, documentType: f.documentType, invoiceDate: f.invoiceDate,
    totalAgorot: signed(amountOrNull(f.total)), vatAgorot: signed(amountOrNull(f.vat)),
  }, draft.recordId, draft.duplicateConflict);
  // The photograph is one tap away throughout the questions. Until its upload
  // lands it is opened from the device itself, so the offer never disappears
  // and looking at the paper again costs nothing.
  const photo = () => f.attachmentIds?.length
    ? `<button type="button" class="text-button quick-photo" data-open-document="${e(f.attachmentIds[0])}" data-safe-action>${icon("image")} הצג חשבונית</button>`
    : draft.fromScan
      ? `<button type="button" class="text-button quick-photo" data-quick-photo data-safe-action>${icon("image")} הצג חשבונית</button>`
      : "";
  const showPhotographedPage = async () => {
    try {
      const scan = await ctx.drafts.load("scan");
      const page = scan?.files?.[0];
      if (page) ctx.previewBlob(draftPageBlob(page));
    } catch (err) { showError(err); }
  };
  const adjustment = () => {
    const reduction = parseMoney(q.paymentReduction || "0");
    if (reduction < 0) throw Error("יש להזין הפחתה של אפס או יותר.");
    const base = parseMoney(q.paymentBaseFinal ?? f.final);
    if (f.documentType !== "credit" && reduction > base) throw Error("ההפחתה גדולה מהסכום לתשלום.");
    f.deductions = f.deductions.filter(d => !d.paymentOnly);
    if (reduction) f.deductions.push({ label: "הפחתה מהתשלום (ללא שינוי במע״מ)", amount: moneyInput(reduction), included: "no", paymentOnly: true });
    f.final = moneyInput(f.documentType === "credit" ? Math.abs(base) + reduction : base - reduction);
  };
  const render = () => {
    deriveMissingAmounts(draft);
    const questions = invoiceQuestions(draft);
    current = draft.pending || draft.cancelPending || draft.conflict ? null : q.editing || questions[0];
    ctx.modalBack = q.editing ? () => { delete q.editing; render(); } : null;
    submit.hidden = Boolean(current);
    $("[data-discard-draft]", form).textContent = "בטל את קליטת החשבונית";
    if (!current) {
      q.paymentBaseFinal ??= f.final;
      const existing = twin();
      content.innerHTML = `<div class="quick-summary-heading">${photo()}<button type="button" class="text-button quick-full-editor" data-full-invoice>עריכה מפורטת</button></div>
        ${duplicateNotice(existing, { supplierName: ctx.data.suppliers.find(s => s.id === existing?.supplierId)?.name || f.supplierName, allowed: Boolean(f.duplicateAllowed) })}
        <div class="quick-summary-grid">
        ${row("supplierName", "ספק", f.supplierName)}${row("documentType", "סוג", types[f.documentType])}
        ${row("documentNumber", "מספר חשבונית", f.documentNumber?.trim() || "ללא מספר")}${row("invoiceDate", "תאריך", displayDate(f.invoiceDate))}
        </div><div class="quick-total">${row("totalAgorot", "סכום החשבונית", money(signed(amountOrNull(f.total))))}</div>
        <details class="quick-amount-details"><summary>מע״מ ופירוט הסכומים</summary>${row("subtotalAgorot", "לפני מע״מ", money(signed(amountOrNull(f.subtotal))))}${row("vatAgorot", "מע״מ", money(signed(amountOrNull(f.vat))))}</details>
        ${f.deductions.filter(d => !d.paymentOnly).length ? `<details class="quick-deductions"><summary>הפחתות במסמך (${f.deductions.filter(d => !d.paymentOnly).length})</summary>${f.deductions.map((d, i) => d.paymentOnly ? "" : row("deduction:" + i, d.label, money(amountOrNull(d.amount)) + (d.included === "yes" ? " · כלולה" : " · נוספת"))).join("")}</details>` : ""}
        <details class="quick-extras" ${q.paymentReduction || f.notes ? "open" : ""}><summary>הפחתה מהתשלום או הערה (רשות)</summary><div class="quick-reduction"><label for="payment-reduction">הפחתה מהתשלום <small>בלי שינוי במע״מ</small></label><input id="payment-reduction" name="paymentReduction" inputmode="decimal" value="${e(q.paymentReduction || "")}" placeholder="0.00" aria-label="הפחתה מהתשלום בשקלים"></div>
        <label class="quick-notes"><span>הערה לחשבונית</span><textarea name="notes" rows="1" maxlength="4000" placeholder="רשות">${e(f.notes)}</textarea></label>
        </details>
        <div class="quick-payable"><span>${f.documentType === "credit" ? "סכום הזיכוי" : "לתשלום"}</span><strong data-quick-final>${e(money(signed(amountOrNull(f.final))))}</strong><button type="button" class="text-button" data-edit-question="finalAgorot">שנה</button></div>
        ${q.confirmed.arithmetic ? '<p class="small warning">נשמרים הסכומים שאישרת, למרות הפער בחיבור המע״מ.</p>' : ""}`;
      $("[name=notes]", form).oninput = ev => { f.notes = ev.target.value; };
      $("[name=paymentReduction]", form).oninput = ev => {
        q.paymentReduction = ev.target.value;
        try { adjustment(); error.hidden = true; $("[data-quick-final]", form).textContent = money(signed(amountOrNull(f.final))); }
        catch (err) { showError(err); }
      };
    } else {
      const titles = { supplierName: "מי הספק?", documentNumber: "מה מספר החשבונית?", invoiceDate: "מה תאריך החשבונית?", documentType: "איזו חשבונית זאת?", totalAgorot: "מה הסכום כולל מע״מ?", vatAgorot: "כמה מע״מ יש בחשבונית?", subtotalAgorot: "מה הסכום לפני מע״מ?", finalAgorot: "מה הסכום הסופי לתשלום?", arithmetic: "הסכומים אינם מסתכמים", finalArithmetic: "מה הסכום לתשלום?" };
      let body = "", footerButton = true;
      const fieldName = { documentNumber: "documentNumber", invoiceDate: "invoiceDate", totalAgorot: "total", subtotalAgorot: "subtotal", finalAgorot: "final" }[current];
      const label = { documentNumber: "מספר החשבונית", invoiceDate: "תאריך החשבונית", totalAgorot: "הסכום כולל מע״מ", subtotalAgorot: "הסכום לפני מע״מ", finalAgorot: "הסכום לתשלום" }[current];
      if (fieldName) body = input(label, fieldName, f[fieldName], current === "invoiceDate" ? "date" : "text");
      if (current === "invoiceDate" && !q.editing) body = '<p class="muted">מולא תאריך היום. אם בחשבונית רשום תאריך אחר, שנה אותו.</p>' + body;
      if (current === "supplierName") body = supplierPickerMarkup(f);
      if (current === "documentType") {
        body = choice("invoice", "חשבונית", true) + choice("credit", "חשבונית זיכוי");
        footerButton = false;
      }
      // The VAT is typed as printed; the rate is a shortcut that shows what it
      // would give, so a mixed-rate invoice is never rounded into the rate.
      if (current === "vatAgorot") {
        const calculated = amountOrNull(f.total) === null ? null : vatFromInclusive(parseMoney(f.total), rate);
        body = input("המע״מ כפי שרשום בחשבונית", "vat", f.vat) + choice("vat-manual", "אשר סכום", true) +
          choice("vat-rate", `חשב לפי ${rate / 100}%`, false, calculated ? `${money(calculated.vatAgorot)} מתוך הסכום הכולל` : "") + choice("vat-zero", "אין מע״מ · 0%");
        footerButton = false;
      }
      if (current.startsWith("deduction:")) {
        const d = f.deductions[Number(current.split(":")[1])];
        body = input("סיבת ההפחתה", "deductionLabel", d.label) + input("סכום ההפחתה", "deductionAmount", d.amount) +
          choice("deduction-yes", "כבר כלולה בסכום החשבונית", true) + choice("deduction-no", "צריך להפחית בנוסף");
        footerButton = false;
      }
      if (current === "arithmetic") {
        body = `<p>לפני מע״מ ${e(money(amountOrNull(f.subtotal)))} + מע״מ ${e(money(amountOrNull(f.vat)))} אינם שווים לסכום הכולל ${e(money(amountOrNull(f.total)))}.</p>` +
          choice("arithmetic-keep", "בדקתי — כך רשום בחשבונית", true) + choice("arithmetic-vat", "תקן את המע״מ") + choice("arithmetic-total", "תקן את הסכום הכולל");
        footerButton = false;
      }
      if (current === "finalArithmetic") {
        body = `<p>הסכום הסופי הוא ${e(money(signed(amountOrNull(f.final))))}. לפי סכום החשבונית וההפחתות מתקבל ${e(money(expectedFinal(draft)))}.</p>` +
          choice("final-calculate", "חשב לפי הסכום וההפחתות", true) + choice("final-keep", "בדקתי — השאר את הסכום הסופי");
        footerButton = false;
      }
      const left = questions.filter(k => typedSteps.includes(k)).length;
      const progress = q.editing ? "שינוי פרט" : left ? `שאלה ${typedSteps.length - left + 1} מתוך ${typedSteps.length}` : "בדיקה נוספת";
      content.innerHTML = `<div class="quick-progress"><span>${progress}</span>${photo()}</div><section class="quick-question" aria-live="polite"><h3 tabindex="-1">${e(titles[current] || "איך לחשב את ההפחתה?")}</h3>${body}${footerButton ? choice("next", "אשר והמשך", true) : ""}${q.editing ? `<button type="button" class="text-button" data-quick-choice="back-summary">${questions.length ? "חזרה לשאלות" : "חזרה לסיכום"}</button>` : ""}<button type="button" class="text-button quick-full-editor" data-full-invoice>עריכה מפורטת של החשבונית</button></section>`;
      if (current === "supplierName") supplierPicker = bindSupplierPicker(ctx, form, draft, {
        collect: () => { f.supplierId = form.elements.supplierId.value; f.supplierName = form.elements.supplierName.value; return f; },
        persist: () => binding?.persist(),
        onSelect: () => void answer("next"),
      });
      content.querySelectorAll("input").forEach(el => el.addEventListener("input", () => {
        if (el.name in f && el.name !== "supplierId") f[el.name] = el.value;
      }));
      $("h3", content)?.focus({ preventScroll: true });
    }
    binding?.lock();
    const modal = root.closest("dialog");
    if (modal) modal.scrollTop = 0;
  };
  const answer = async action => {
    if (advancing || draft.pending) return;
    advancing = true; error.hidden = true;
    // A detail typed over is a different invoice from the one the store
    // refused, so its refusal stops speaking for what is in the form now.
    delete draft.duplicateConflict;
    const key = current;
    try {
      if (action === "back-summary") { delete q.editing; render(); return; }
      if (action.startsWith("arithmetic-") && action !== "arithmetic-keep") {
        q.editing = action === "arithmetic-vat" ? "vatAgorot" : "totalAgorot"; render(); return;
      }
      if (key === "supplierName") {
        f.supplierName = form.elements.supplierName.value.trim(); f.supplierId = form.elements.supplierId.value;
        if (!f.supplierId || draft.supplierConflict) throw Error("בחר ספק קיים או אשר פתיחת ספק חדש.");
      }
      if (key === "invoiceDate" && !validInvoiceDate(f.invoiceDate)) throw Error("יש להזין תאריך תקין.");
      if (key === "documentType") {
        if (!["invoice", "credit"].includes(action)) throw Error("בחר חשבונית או חשבונית זיכוי.");
        f.documentType = action;
        for (const field of ["subtotal", "vat", "total", "final"]) if (amountOrNull(f[field]) !== null) f[field] = moneyInput(Math.abs(parseMoney(f[field])));
        delete q.confirmed.finalArithmetic;
      }
      if (["totalAgorot", "subtotalAgorot", "finalAgorot"].includes(key)) {
        const name = { totalAgorot: "total", subtotalAgorot: "subtotal", finalAgorot: "final" }[key];
        parseMoney(f[name], key === "subtotalAgorot");
        if (key === "finalAgorot") {
          const reduction = parseMoney(q.paymentReduction || "0");
          q.paymentBaseFinal = moneyInput(parseMoney(f.final) + (f.documentType === "credit" ? -reduction : reduction));
          q.finalDerived = false; adjustment();
        }
        delete q.confirmed.arithmetic;
        delete q.confirmed.finalArithmetic;
      }
      if (key === "vatAgorot") {
        // Enter in the typed box confirms what was typed.
        if (action === "next" && form.elements.vat?.value.trim()) action = "vat-manual";
        if (action === "vat-manual" && amountOrNull(f.total) !== null && parseMoney(form.elements.vat.value) > Math.abs(parseMoney(f.total)))
          throw Error("המע״מ גדול מהסכום הכולל. בדוק את שני הסכומים.");
        if (["vat-rate", "vat-zero"].includes(action)) {
          const values = vatFromInclusive(parseMoney(f.total), action === "vat-zero" ? 0 : rate);
          f.vat = moneyInput(values.vatAgorot);
          f.subtotal = moneyInput(values.subtotalAgorot); q.confirmed.subtotalAgorot = true;
        } else if (action === "vat-manual") f.vat = moneyInput(Math.abs(parseMoney(form.elements.vat.value)));
        else throw Error("הקלד את המע״מ שרשום בחשבונית, או בחר חישוב לפי האחוז.");
        delete q.confirmed.arithmetic;
      }
      if (key.startsWith("deduction:")) {
        const d = f.deductions[Number(key.split(":")[1])];
        d.label = form.elements.deductionLabel.value.trim();
        if (!d.label) throw Error("יש להזין סיבה להפחתה.");
        d.amount = moneyInput(parseMoney(form.elements.deductionAmount.value));
        d.included = action === "deduction-yes" ? "yes" : "no";
        if (q.finalDerived) f.final = "";
        delete q.confirmed.finalArithmetic;
      }
      if (key === "finalArithmetic" && action === "final-calculate") {
        const expected = expectedFinal(draft);
        f.final = moneyInput(f.documentType === "credit" ? Math.abs(expected) : expected);
        q.finalDerived = true;
        delete q.paymentBaseFinal;
      }
      q.confirmed[key] = true;
      delete q.editing;
      deriveMissingAmounts(draft);
      await binding.persist(true);
      if (form.isConnected) render();
    } catch (err) { showError(err); }
    finally { advancing = false; }
  };
  render();
  binding = bindDraft(ctx, form, "invoice", draft, collect, () => {
    if (current || invoiceQuestions(draft).length) throw Error("יש להשלים את הפרטים לפני שמירה.");
    adjustment();
    return buildMutation({ ...f, review: "on" });
  }, { onError: async err => {
    if (["SUPPLIER_EXISTS", "SUPPLIER_CHANGED", "SUPPLIER_MISSING"].includes(err.code)) {
      draft.supplierConflict = err.details?.supplierId ? { id: err.details.supplierId } : null;
      f.supplierId = ""; q.editing = "supplierName"; render(); await supplierPicker?.recover(err);
    }
    // The store keeps the same guard, and sees the invoices this device has not
    // synced yet. Its refusal opens the same choice the summary offers.
    if (err.code === "DUPLICATE_INVOICE_DETAILS") {
      draft.duplicateConflict = err.details?.invoiceId || "";
      render();
    }
  } });
  form.addEventListener("submit", ev => {
    if (current) { ev.preventDefault(); ev.stopImmediatePropagation(); void answer("next"); }
  }, true);
  form.addEventListener("click", ev => {
    const choice = ev.target.closest("[data-quick-choice]"), edit = ev.target.closest("[data-edit-question]");
    if (choice) void answer(choice.dataset.quickChoice);
    if (ev.target.closest("[data-quick-photo]")) void showPhotographedPage();
    if (ev.target.closest("[data-confirm-duplicate]") && !draft.pending) {
      f.duplicateAllowed = true; error.hidden = true; render(); void binding.persist();
    }
    if (edit && !draft.pending) { q.editing = edit.dataset.editQuestion; error.hidden = true; render(); }
    if (ev.target.closest("[data-full-invoice]") && !draft.pending)
      void binding.persist(true).then(openEditor).catch(showError);
  });
}
