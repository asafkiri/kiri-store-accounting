import { moneyInput, methods, types } from "./format.js";
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[\s]*[=+\-@\t\r]/.test(s) && !/^-\d+(?:\.\d{1,2})?$/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export function invoiceCsv(items, suppliers) {
  const names = new Map(suppliers.map((s) => [s.id, s.name]));
  const rows = [
    [
      "ספק",
      "מספר מסמך",
      "סוג",
      "תאריך חשבונית",
      "לפני מע״מ",
      "מע״מ",
      "כולל מע״מ",
      "לתשלום",
      "מצב",
      "אמצעי תשלום",
      "תאריך תשלום / מסירת צ׳ק",
      "מספר צ׳ק",
      "פירעון צ׳ק",
      "הערות",
      "הפחתות",
    ],
    ...items.map((i) => [
      names.get(i.supplierId),
      i.documentNumber,
      types[i.documentType],
      i.invoiceDate,
      moneyInput(i.subtotalAgorot),
      moneyInput(i.vatAgorot),
      moneyInput(i.totalAgorot),
      moneyInput(i.finalAgorot),
      i.status === "paid" ? "שולם" : "לא שולם",
      methods[i.payment?.method] || "",
      i.payment?.paymentDate || "",
      i.payment?.checkNumber || "",
      i.payment?.checkDueDate || "",
      i.notes,
      i.deductions
        .map(
          (d) =>
            `${d.label}: ${moneyInput(d.amountAgorot)} (${d.includedInTotal ? "כלול בסכום" : "נוסף"})`,
        )
        .join("; "),
    ]),
  ];
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
export function cashCsv(items) {
  return (
    "\uFEFF" +
    [
      ["תאריך", "קופה", "רב־קו", "הערות"],
      ...items.map((r) => [
        r.date,
        moneyInput(r.cashAgorot),
        moneyInput(r.ravKavAgorot),
        r.notes,
      ]),
    ]
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n")
  );
}
export async function download(content, name, type, { share = navigator.standalone } = {}) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const file = new File([blob], name, { type: blob.type });
  // Share is called from the user's click, before any await, in installed iOS.
  if (share && navigator.share && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (error) { if (error?.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(
    blob,
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
