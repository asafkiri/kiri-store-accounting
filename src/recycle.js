import { escapeHtml as e, money, displayDate } from "./format.js";
import { icon } from "./ui.js";
export const restoreDeadline = record => record.restoreUntil ?? (record.deletedAt + 30 * 86400000);
export function recycleView(ctx) {
  const now = Date.now();
  const invoices = ctx.data.invoices.filter(i => i.deletedAt && restoreDeadline(i) > now).sort((a, b) => b.deletedAt - a.deletedAt);
  const photos = ctx.data.invoices.filter(i => !i.deletedAt).flatMap(i => (i.attachmentTrash || [])
    .filter(p => p.restoreUntil > now).map(p => ({ invoice: i, ...p }))).sort((a, b) => b.deletedAt - a.deletedAt);
  const identity = i => `${ctx.data.suppliers.find(s => s.id === i.supplierId)?.name || "ספק"} · ${displayDate(i.invoiceDate)} · ${money(i.finalAgorot)}`;
  const deadline = stamp => `ניתן לשחזר עד ${new Date(stamp).toLocaleDateString("he-IL")}`;
  return `<div class="page-heading"><h1>סל מחזור</h1></div><p class="page-intro">חשבוניות וצילומים נשמרים כאן ל־30 יום. שחזור מחזיר אותם למקום שממנו נמחקו.</p>
    <button class="secondary" data-route="supplier-trash">${icon("suppliers")} ספקים שנמחקו</button>
    <section class="recycle-section"><h2>חשבוניות שנמחקו (${invoices.length})</h2>${invoices.map(i => `<article class="trash-card"><div><h3>${e(identity(i))}</h3><p>${i.status === "paid" ? "שולמה" : "לא שולמה"} · ${(i.attachmentIds || []).length} קבצים מצורפים</p><p class="muted">${e(deadline(restoreDeadline(i)))}</p></div><button class="secondary" data-action="restore-invoice" data-id="${e(i.id)}">${icon("refresh")} שחזר חשבונית</button></article>`).join("") || '<p class="muted">אין חשבוניות בסל המחזור.</p>'}</section>
    <section class="recycle-section"><h2>צילומים שנמחקו (${photos.length})</h2>${photos.map(p => `<article class="trash-card"><div><h3>${e(identity(p.invoice))}</h3><p>צילום עמוד ${Math.max(0, (p.invoice.attachmentOrder || []).indexOf(p.id)) + 1}</p><p class="muted">${e(deadline(p.restoreUntil))}</p></div><div class="row-actions"><button class="secondary" data-action="preview-recycled-photo" data-id="${e(p.id)}" data-open-document="${e(p.id)}">${icon("image")} הצג צילום</button><button class="secondary" data-action="restore-photo" data-id="${e(p.invoice.id)}" data-document="${e(p.id)}">${icon("refresh")} שחזר צילום</button></div></article>`).join("") || '<p class="muted">אין צילומים שנמחקו בנפרד. צילומי חשבונית שנמחקה חוזרים יחד עם שחזורה.</p>'}</section>`;
}
