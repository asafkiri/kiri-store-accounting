import { escapeHtml as e, money, displayDate, types, methods } from "./format.js";
import { icon } from "./ui.js";

export function invoiceDetails(invoice, supplier) {
  const paid = invoice.status === "paid", payment = invoice.payment, files = invoice.attachmentIds || [];
  const rows = [["לפני מע״מ", money(invoice.subtotalAgorot)], ["מע״מ", money(invoice.vatAgorot)], ["כולל מע״מ", money(invoice.totalAgorot)]];
  const rowList = rows => `<dl class="details-list">${rows.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl>`;
  return `<section class="invoice-hero"><h3>${e(supplier?.name || "ספק")}</h3><p>${e(types[invoice.documentType])} ${e(invoice.documentNumber)} · ${e(displayDate(invoice.invoiceDate))}</p>
    <span class="badge ${paid ? "paid" : "unpaid"}">${paid ? icon("check") + "שולם" : "טרם שולם"}</span><div class="invoice-hero-amount"><span>${invoice.documentType === "credit" ? "סכום הזיכוי" : "סכום לתשלום"}</span><strong>${e(money(invoice.finalAgorot))}</strong></div></section>
    <button class="primary invoice-detail-primary" data-detail-action="pay">${paid ? "תיקון פרטי התשלום" : "סמן ששילמתי"}</button>
    ${payment ? `<section class="payment-receipt"><h3>פרטי התשלום</h3>${rowList([
      ["אמצעי תשלום", methods[payment.method]], [payment.method === "check" ? "יום מסירת הצ׳ק לספק" : "יום התשלום", displayDate(payment.paymentDate)],
      ...(payment.method === "check" ? [["מספר צ׳ק", payment.checkNumber || "לא הוזן"], ...(payment.checkDueDate ? [["מועד פירעון", displayDate(payment.checkDueDate)]] : [])] : []),
    ])}${payment.notes ? `<p>${e(payment.notes)}</p>` : ""}</section>` : ""}
    ${invoice.notes ? `<div class="notice">${e(invoice.notes)}</div>` : ""}
    <section class="attachment-links"><h3>תמונות ומסמכים מצורפים</h3>${files.length ? files.map((id, index) => `<button class="secondary" data-open-document="${e(id)}">${icon("image")} ${files.length === 1 ? "הצג צילום חשבונית" : "הצג עמוד " + (index + 1)}</button>`).join("") + '<button class="secondary" data-detail-action="share-invoice">שתף את כל קבצי החשבונית</button>' : '<p>לא צורף צילום לחשבונית הזאת.</p>'}</section>
    <details class="invoice-extra"><summary>מע״מ ופירוט הסכומים</summary>${rowList(rows)}${(invoice.deductions || []).map(d => `<p>${e(d.label)} · ${e(money(d.amountAgorot))} · ${d.includedInTotal ? "כלולה בסכום" : "נוספת"}</p>`).join("")}</details>
    <div class="invoice-edit-actions"><button class="secondary" data-detail-action="edit">תקן פרטי חשבונית</button>${paid ? '<button class="text-button" data-detail-action="unpay">טעיתי — החשבונית לא שולמה</button>' : ""}
    <details><summary>מחיקת החשבונית</summary><button class="text-button danger" data-detail-action="delete">מחק חשבונית</button></details></div>`;
}
