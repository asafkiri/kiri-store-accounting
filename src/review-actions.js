import { validInvoiceDate } from "./quick-invoice-model.js";

export function reviewFields(draft) {
  return [
    ["documentNumber", "מספר חשבונית"], ["supplierName", "ספק"], ["invoiceDate", "תאריך"],
    ["subtotalAgorot", "לפני מע״מ"], ["vatAgorot", "מע״מ"], ["totalAgorot", "סכום כולל"],
    ["finalAgorot", "סופי לתשלום"], ["documentType", "סוג חשבונית"],
    ...draft.fields.deductions.map((d, i) => ["deduction:" + i, d.label || "הפחתה"]),
  ];
}

// These hints only choose which edit buttons to display. They never change or
// acknowledge an extracted value. Unclassified notes keep an explicit picker.
export function warningFields(warning, draft) {
  const text = String(warning || "");
  const matches = new Set();
  if (/מספר (?:ה)?(?:חשבונית|מסמך)|invoice number/iu.test(text)) matches.add("documentNumber");
  if (/תאריך|date/iu.test(text)) matches.add("invoiceDate");
  if (/שם (?:ה)?ספק|זהות (?:ה)?ספק|ח[.״"]?פ|ע[.״"]?מ|supplier/iu.test(text)) matches.add("supplierName");
  if (/לפני מע[״"]?מ|subtotal/iu.test(text)) matches.add("subtotalAgorot");
  if (/מע[״"]?מ|\bvat\b/iu.test(text)) matches.add("vatAgorot");
  if (/סכום (?:ה)?(?:חשבונית|כולל)|סכום כולל|total/iu.test(text)) matches.add("totalAgorot");
  if (/סופי|לתשלום|final/iu.test(text)) matches.add("finalAgorot");
  if (/סוג (?:ה)?מסמך|תעודת משלוח|קבלה|חשבונית זיכוי/iu.test(text)) matches.add("documentType");
  if (/הפחת|הנח|ניכוי|עיגול/iu.test(text)) draft.fields.deductions.forEach((_, i) => matches.add("deduction:" + i));
  return reviewFields(draft).filter(([key]) => matches.has(key)).slice(0, 3);
}

export function warningDates(warning) {
  const candidates = [];
  for (const match of String(warning || "").matchAll(/\b(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[./](\d{1,2})[./](\d{4}))\b/g)) {
    const date = match[1] ? `${match[1]}-${match[2]}-${match[3]}` : `${match[6]}-${match[5].padStart(2, "0")}-${match[4].padStart(2, "0")}`;
    if (validInvoiceDate(date) && !candidates.includes(date)) candidates.push(date);
  }
  return candidates.slice(0, 3);
}
