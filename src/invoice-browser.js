import { escapeHtml as e, money, displayDate, totals, types, today, monthLabel } from "./format.js";
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
    `<button class="${value === v ? "active" : ""}" data-action="status" data-value="${v}" aria-pressed="${value === v}">${label}</button>`).join("")}</div>`;
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

export function documentCards(items) {
  return items.map(i => `<article class="document-card">
    <div class="document-card-heading">${icon("invoice")}<div><strong>${e(types[i.documentType] || "חשבונית")} ${e(i.documentNumber)}</strong><span class="document-meta">${e(displayDate(i.invoiceDate))} · ${e(money(i.finalAgorot))}</span></div><span class="badge ${i.status === "paid" ? "paid" : "unpaid"}">${i.status === "paid" ? "שולם" : "לתשלום"}</span></div>
    <div class="document-pages">${(i.attachmentIds || []).map((id, index) => `<button class="secondary" data-open-document="${e(id)}">${icon("image")} ${i.attachmentIds.length === 1 ? "פתח צילום / PDF" : "עמוד / קובץ " + (index + 1)}</button>`).join("")}</div>
    <button class="text-button" data-action="detail" data-id="${e(i.id)}">פרטי החשבונית והתשלום</button>
  </article>`).join("");
}

export function invoiceFolders(items, ctx, renderCards, { photos = false } = {}) {
  const groups = groupInvoices(items), supplierMap = new Map(ctx.data.suppliers.map(s => [s.id, s]));
  const limit = ctx.limit || 80;
  let rendered = 0;
  const isOpen = (key, fallback) => ctx.folderState?.[key] ?? fallback;
  const html = groups.map(([month, suppliers], monthIndex) => {
    const monthItems = [...suppliers.values()].flat();
    const monthKey = `${photos ? "photos" : "invoices"}:${month}`;
    const supplierRows = [...suppliers].sort(([a], [b]) => (supplierMap.get(a)?.name || "ספק").localeCompare(supplierMap.get(b)?.name || "ספק", "he"));
    return `<details class="month-folder" data-folder="${e(monthKey)}" ${isOpen(monthKey, monthIndex === 0 || Boolean(ctx.filters.q || ctx.filters.supplierId)) ? "open" : ""}>
      <summary><span class="folder-symbol">${icon("folder")}</span><span class="folder-title"><strong>${e(monthLabel(month))}</strong><small>${suppliers.size} ספקים · ${monthItems.length} חשבוניות${photos ? " עם צילומים" : ""}</small></span><span class="folder-total">${e(summaryMoney(totals(monthItems).final))}</span>${icon("arrow")}</summary>
      <div class="month-content">${supplierRows.map(([id, rows]) => {
        const supplier = supplierMap.get(id), key = monthKey + ":" + id;
        const remaining = Math.max(0, limit - rendered), visible = rows.slice(0, remaining);
        rendered += visible.length;
        const open = rows.filter(i => i.status === "unpaid").length;
        return `<details class="supplier-folder" data-folder="${e(key)}" ${isOpen(key, Boolean(ctx.filters.q || ctx.filters.supplierId) || suppliers.size === 1) ? "open" : ""}>
          <summary><span class="supplier-avatar">${e((supplier?.name || "ס")[0])}</span><span class="folder-title"><strong>${e(supplier?.name || "ספק")}</strong><small>${rows.length} חשבוניות · ${open ? open + " לתשלום" : "הכול שולם"}</small></span><span class="folder-total">${e(summaryMoney(totals(rows).final))}</span>${icon("arrow")}</summary>
          <div class="supplier-content">${!photos && supplier && !supplier.deletedAt ? `<div class="supplier-tools"><button class="text-button" data-action="supplier-edit" data-id="${e(id)}">פרטי ספק ועריכה</button></div>` : ""}<div class="invoice-list">${renderCards(visible, { ...ctx, limit: Number.MAX_SAFE_INTEGER })}</div>${visible.length < rows.length ? '<button class="secondary" data-action="more">הצג עוד חשבוניות</button>' : ""}</div>
        </details>`;
      }).join("")}</div>
    </details>`;
  }).join("");
  return `<div class="invoice-folders">${html}</div>`;
}
