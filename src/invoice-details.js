import { escapeHtml as e, money, displayDate, types, methods } from "./format.js";
import { icon } from "./ui.js";

// Viewing the paper is a daily action; removing a page belongs in More actions.
export function attachmentRows(invoice, label) {
  const files = invoice.attachmentIds || [];
  return files
    .map(
      (id, index) =>
        `<div class="attachment-row"><button class="secondary" data-open-document="${e(id)}">${icon("image")} ${e(label(index, files.length))}</button></div>`,
    )
    .join("");
}
export function attachmentRemovalRows(invoice) {
  return (invoice.attachmentIds || []).map((id, index) =>
    `<button class="text-button danger" data-delete-document="${e(id)}" data-invoice="${e(invoice.id)}" data-page="${index + 1}">${icon("trash")} העבר ${invoice.attachmentIds.length === 1 ? "צילום" : "עמוד " + (index + 1)} לסל המחזור</button>`).join("");
}
export function retentionNote(days) {
  if (!days) return "";
  const years = days % 365 === 0 ? days / 365 : 0;
  const period = !years
    ? days + " ימים"
    : years === 1
      ? "שנה"
      : years === 2
        ? "שנתיים"
        : years + " שנים";
  return `<p class="muted small">כל צילום נמחק מהמערכת ומהאחסון אוטומטית כעבור ${e(period)} מיום העלאתו. פרטי החשבונית נשארים.</p>`;
}

export function invoiceDetails(invoice, supplier, { retentionDays = 0 } = {}) {
  const paid = invoice.status === "paid", payment = invoice.payment, files = invoice.attachmentIds || [];
  const rows = [["לפני מע״מ", money(invoice.subtotalAgorot)], ["מע״מ", money(invoice.vatAgorot)], ["כולל מע״מ", money(invoice.totalAgorot)]];
  const rowList = rows => `<dl class="details-list">${rows.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl>`;
  return `<section class="invoice-hero" aria-label="סיכום החשבונית">
    <div class="invoice-identity-line"><div><span class="invoice-info-label">ספק${invoice.documentType && invoice.documentType !== "invoice" ? " · " + e(types[invoice.documentType]) : ""}</span><h3>${e(supplier?.name || "ספק")}</h3></div><span class="badge ${paid ? "paid" : "unpaid"}">${paid ? icon("check") + "שולם" : "טרם שולם"}</span></div>
    <div class="invoice-date-line"><span class="invoice-info-label">תאריך חשבונית</span><time datetime="${e(invoice.invoiceDate)}" dir="ltr">${e(displayDate(invoice.invoiceDate))}</time></div>
    <div class="invoice-hero-amount"><span>${invoice.documentType === "credit" ? "סכום הזיכוי" : paid ? "סכום החשבונית" : "סכום לתשלום"}</span><strong>${e(money(invoice.finalAgorot))}</strong></div></section>
    ${payment ? `<section class="payment-receipt"><h3>פרטי התשלום</h3>${rowList([
      ["אמצעי תשלום", methods[payment.method]], [payment.method === "check" ? "יום מסירת הצ׳ק לספק" : "יום התשלום", displayDate(payment.paymentDate)],
      ...(payment.batch ? [["נרשמה בתשלום משותף", `${payment.batch.invoiceIds.length} חשבוניות · ${money(payment.batch.totalAgorot)}`]] : []),
      ...(payment.method === "check" ? [["מספר צ׳ק", payment.checkNumber || "לא הוזן"], ...(payment.checkDueDate ? [["מועד פירעון", displayDate(payment.checkDueDate)]] : [])] : []),
    ])}${payment.notes ? `<p>${e(payment.notes)}</p>` : ""}</section>` : ""}
    ${invoice.notes ? `<div class="notice">${e(invoice.notes)}</div>` : ""}
    ${files.length ? `<section class="invoice-photo" data-invoice-photo aria-label="צילום החשבונית">
      <div class="invoice-photo-heading"><h3>צילום החשבונית</h3><span class="muted" data-photo-counter aria-live="polite">${files.length > 1 ? `עמוד 1 מתוך ${files.length}` : ""}</span></div>
      <div class="invoice-photo-stage" data-photo-stage aria-busy="true"><p role="status">טוען צילום…</p></div>
      ${files.length > 1 ? `<div class="invoice-photo-pages"><button class="secondary" data-photo-previous disabled>${icon("arrow")} הקודם</button><button class="secondary" data-photo-next>הבא ${icon("arrow")}</button></div>` : ""}
    </section>` : '<p class="invoice-no-photo muted">לא צורף צילום לחשבונית הזאת.</p>'}
    <div class="invoice-detail-actions">
      ${!paid ? '<button class="primary invoice-detail-primary" data-detail-action="pay">סמן ששילמתי</button>' : ""}
      <div class="invoice-secondary-actions">${files.length ? `<button class="secondary" data-detail-action="share-invoice">${icon("share")} שתף חשבונית</button>` : ""}${!paid ? '<button class="secondary" data-detail-action="pay-supplier">תשלום לכמה חשבוניות</button>' : ""}</div>
    </div>
    <details class="invoice-extra"><summary>מע״מ ופירוט הסכומים</summary>${rowList(rows)}${(invoice.deductions || []).map(d => `<p>${e(d.label)} · ${e(money(d.amountAgorot))} · ${d.includedInTotal ? "כלולה בסכום" : "נוספת"}</p>`).join("")}</details>
    <details class="invoice-edit-actions"><summary>פעולות נוספות</summary><div class="invoice-more-actions"><button class="secondary" data-detail-action="edit">תקן פרטי חשבונית</button>${paid ? '<button class="secondary" data-detail-action="pay">תיקון פרטי התשלום</button><button class="text-button" data-detail-action="unpay">טעיתי — החשבונית לא שולמה</button>' : ""}
    ${invoice.documentNumber?.trim() ? `<p class="muted">מספר חשבונית שמור: ${e(invoice.documentNumber)}</p>` : ""}
    ${attachmentRemovalRows(invoice)}<button class="text-button danger" data-detail-action="delete">מחק חשבונית</button><button class="secondary" data-detail-action="recycle">סל מחזור ושחזור</button>${files.length ? retentionNote(retentionDays) : ""}</div></details>`;
}
