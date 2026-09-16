import { escapeHtml as e, money, displayDate, types, today, monthLabel } from "./format.js";
import { icon, field } from "./ui.js";

export const summaryMoney = value => value === null ? "נדרש תיקון זיכוי" : money(value);
// One period mode at a time. Native date inputs need min-width:0 on iOS.
export function periodPicker(ctx) {
  const f = ctx.filters, range = f.periodMode === "range" || f.from || f.to;
  return `<section class="period-picker filters" aria-label="בחירת תקופה">
    <div class="period-heading"><strong>${range ? "טווח תאריכים" : "בחירת חודש"}</strong><button class="text-button" data-action="period-mode" data-value="${range ? "month" : "range"}">${range ? "בחירה לפי חודש" : "בחירת טווח תאריכים"}</button></div>
    ${range ? `<div class="date-range">${field("מתאריך", "from", f.from || "", { type: "date" })}${field("עד תאריך", "to", f.to || "", { type: "date" })}</div>`
      : field("חודש להצגה", "month", f.month || today().slice(0, 7), { type: "month" })}
    ${f.from && f.to && f.from > f.to ? '<p class="form-error" role="alert">תאריך הסיום צריך להיות אחרי תאריך ההתחלה.</p>' : ""}
  </section>`;
}

export function statusTabs(value = "") {
  return `<div class="tabs" role="group" aria-label="מצב חשבוניות">${[["", "הכול"], ["unpaid", "לתשלום"], ["paid", "שולמו"]].map(([v, label]) =>
    `<button class="status-${v || "all"} ${value === v ? "active" : ""}" data-action="status" data-value="${v}" aria-pressed="${value === v}">${label}</button>`).join("")}</div>`;
}

export function groupInvoices(items) {
  const months = new Map();
  for (const invoice of items) {
    const month = invoice.invoiceDate?.slice(0, 7) || "";
    if (!months.has(month)) months.set(month, new Map());
    const suppliers = months.get(month);
    if (!suppliers.has(invoice.supplierId)) suppliers.set(invoice.supplierId, []);
    suppliers.get(invoice.supplierId).push(invoice);
  }
  return [...months].sort(([a], [b]) => b.localeCompare(a));
}

export function documentCards(items, ctx = {}) {
  return items.map(i => `<article class="document-card status-${i.status === "paid" ? "paid" : "unpaid"}">
    <button class="document-card-heading" data-action="documents" data-id="${e(i.id)}">${icon("invoice")}<div><strong>${ctx.folderPath?.supplierId ? e(displayDate(i.invoiceDate)) : e(ctx.data?.suppliers.find(s => s.id === i.supplierId)?.name || "ספק")}</strong>${!ctx.folderPath?.supplierId ? `<span class="document-meta">${e(displayDate(i.invoiceDate))}</span>` : ""}<span class="document-meta">${e(money(i.finalAgorot))} · ${i.attachmentIds.length} קבצים</span>${i.documentType && i.documentType !== "invoice" ? `<span class="document-meta">${e(types[i.documentType])}</span>` : ""}</div><span class="badge ${i.status === "paid" ? "paid" : "unpaid"}">${i.status === "paid" ? "שולם" : "לתשלום"}</span>${icon("arrow")}</button>
  </article>`).join("");
}

export function folderLocation(ctx) {
  const path = ctx.folderPath || {};
  if (!path.month) return "";
  const supplier = ctx.data.suppliers.find(s => s.id === path.supplierId);
  // Standing in a supplier's folder already answers the first question the
  // intake asks, so the camera opens from here with that answer filled in. A
  // supplier in the recycle bin is not offered new invoices.
  const addHere = path.supplierId && supplier && !supplier.deletedAt
    ? `<button class="secondary folder-add" data-action="scan" data-supplier="${e(supplier.id)}">${icon("camera")} צלם חשבונית ל${e(supplier.name)}</button>`
    : "";
  return `<section class="folder-location" aria-label="התיקייה הנוכחית">
    <h1 tabindex="-1" data-folder-heading>${e(path.supplierId ? supplier?.name || "ספק" : monthLabel(path.month))}</h1>
    <p>${path.supplierId ? e(monthLabel(path.month)) : "בחר ספק"}</p>${addHere}
  </section>`;
}

// Only the current directory is rendered. A large earlier month can never
// consume another folder's page limit or leave hidden, nested invoice cards.
export function invoiceFolders(items, ctx, renderCards, { photos = false } = {}) {
  const path = ctx.folderPath || {}, supplierMap = new Map(ctx.data.suppliers.map(s => [s.id, s]));
  const visible = path.month ? items.filter(i => i.invoiceDate?.startsWith(path.month)) : items;
  const groups = groupInvoices(visible);
  const folder = (action, value, label, description, glyph, cls) => `<button class="folder-row ${cls}" data-action="${action}" data-value="${e(value)}" aria-label="פתח ${e(label)}">
    <span class="folder-symbol">${icon(glyph)}</span><span class="folder-title"><strong>${e(label)}</strong><small>${e(description)}</small></span>${icon("arrow")}</button>`;
  let body;
  if (!path.month) {
    body = groups.map(([month, suppliers]) => {
      const rows = [...suppliers.values()].flat();
      return folder("folder-month", month, monthLabel(month), `${suppliers.size} ספקים · ${rows.length} חשבוניות${photos ? " עם צילומים" : ""}`, "folder", "month-folder");
    }).join("");
  } else if (!path.supplierId) {
    body = [...(groups[0]?.[1] || [])].sort(([a], [b]) => (supplierMap.get(a)?.name || "ספק").localeCompare(supplierMap.get(b)?.name || "ספק", "he")).map(([id, rows]) => {
      const unpaid = rows.filter(i => i.status === "unpaid").length;
      return folder("folder-supplier", id, supplierMap.get(id)?.name || "ספק", `${rows.length} חשבוניות · ${unpaid ? unpaid + " לתשלום" : "הכול שולם"}`, "suppliers", "supplier-folder");
    }).join("");
  } else {
    const rows = visible.filter(i => i.supplierId === path.supplierId);
    const limit = ctx.limit || 80;
    body = `<div class="invoice-list">${renderCards(rows.slice(0, limit), { ...ctx, limit: Number.MAX_SAFE_INTEGER })}</div>${rows.length > limit ? '<button class="secondary" data-action="more">הצג עוד חשבוניות</button>' : ""}${!rows.length ? '<p class="notice">אין חשבוניות שמתאימות לסינון בתיקייה הזאת.</p>' : ""}`;
  }
  return `<div class="invoice-folders ${!path.supplierId && body ? "folder-list" : ""}">${body || '<p class="notice">אין חשבוניות שמתאימות לסינון בתיקייה הזאת.</p>'}</div>`;
}
