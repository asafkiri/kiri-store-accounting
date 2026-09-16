import { invoiceFolders, documentCards, periodPicker, statusTabs, summaryMoney, folderLocation, monthSections } from "./invoice-browser.js";
import { creditSignIssues } from "./credit.js";
import { recycleView } from "./recycle.js";
import { icon, empty, select, field } from "./ui.js";
import {
  escapeHtml as e,
  money,
  displayDate,
  today,
  monthLabel,
  methods,
  types,
  filterInvoices,
  totals,
} from "./format.js";
const act = (action, label, cls = "primary", glyph = "plus", extra = "") =>
  `<button class="${cls}" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ""}${e(label)}</button>`;
const creditNotice = (count) =>
  count
    ? `<div class="notice warning">יש ${count} זיכויים עם סכומים שאינם שליליים. פתח ותקן אותם כדי להציג סיכום נכון.</div>`
    : "";
const draftReminders = ctx => [
  ["scan", "יש צילום שלא הושלם"], ["invoice", "יש חשבונית שלא נשמרה"],
  ["payment", "יש רישום תשלום שלא הסתיים"], ["cash", "יש סגירת יום שלא נשמרה"],
].filter(([key]) => ctx.draftNames.includes(key)).map(([key, label]) =>
  `<button class="draft-banner" data-action="resume-draft" data-key="${key}">${label} · המשך מכאן ${icon("arrow")}</button>`).join("");

export function homeView(ctx) {
  const entries = [
    ['data-action="scan"', "צלם חשבונית", "צילום ומילוי הפרטים", "camera", "home-scan scan-primary"],
    ['data-route="invoices"', "חשבוניות ותשלומים", "מצא חשבונית וסמן ששילמת", "folder", "home-invoices"],
    ['data-route="cash"', "קופה ורב־קו", "רישום סגירת היום", "cash", "home-cash"],
    ['data-route="documents"', "שליחה לרואה החשבון", "כל צילומי החודש יחד", "share", "home-documents"],
  ];
  return `<div class="page-heading home-heading"><h1>מה עושים עכשיו?</h1></div><p class="page-intro">בחר פעולה כדי להתחיל</p>
    ${draftReminders(ctx)}<div class="home-actions">${entries.map(([action, title, description, glyph, cls]) =>
      `<button class="home-action ${cls}" ${action}><span class="home-action-icon">${icon(glyph)}</span><span><strong>${title}</strong><small>${description}</small></span>${icon("arrow")}</button>`).join("")}</div>`;
}

export function moreView() {
  return `<div class="page-heading"><h1>אפשרויות נוספות</h1></div><div class="more-actions">
    <button class="secondary" data-action="manage-suppliers">${icon("suppliers")} ניהול ספקים</button>
    <button class="secondary" data-route="checks">${icon("search")} חיפוש צ׳ק — למי הוא נמסר?</button>
    <button class="secondary" data-route="reports">${icon("reports")} סיכומים ודוחות</button>
    <button class="secondary" data-route="recycle">${icon("trash")} סל מחזור</button>
    <button class="secondary" data-route="settings">${icon("settings")} הגדרות וגיבוי</button></div>`;
}
export function invoiceCards(items, ctx) {
  return (
    items
      .slice(0, ctx.limit)
      .map((i) => {
        const name =
          ctx.data.suppliers.find((s) => s.id === i.supplierId)?.name || "ספק";
        // Every row on a screen already narrowed to one supplier says the same
        // name; the date is what tells them apart, so it takes the headline.
        const inSupplier =
          ctx.folderPath?.supplierId === i.supplierId ||
          ctx.filters?.supplierId === i.supplierId;
        const paid = i.status === "paid";
        return `<article class="invoice-card status-${paid ? "paid" : "unpaid"}"><button class="invoice-main" data-action="detail" data-id="${e(i.id)}" aria-label="פתח ${e(types[i.documentType] || "חשבונית")} של ${e(name)}, ${e(displayDate(i.invoiceDate))}, ${e(money(i.finalAgorot))}, ${paid ? "שולם" : "לא שולם"}"><span class="invoice-identity"><span class="supplier-name">${e(inSupplier ? displayDate(i.invoiceDate) : name)}</span>${!inSupplier ? `<span class="document-meta">${e(displayDate(i.invoiceDate))}</span>` : ""}${i.documentType && i.documentType !== "invoice" ? `<span class="document-meta">${e(types[i.documentType])}</span>` : ""}${i.attachmentIds?.length ? `<span class="document-meta attachment-indicator">${icon("image")}${i.attachmentIds.length === 1 ? "מסמך מצורף" : i.attachmentIds.length + " מסמכים מצורפים"}</span>` : ""}${ctx.route === "checks" && i.payment?.method === "check" ? `<span class="check-reference">צ׳ק ${e(i.payment.checkNumber || "ללא מספר")} · נמסר ${e(displayDate(i.payment.paymentDate))}</span>` : ""}${creditSignIssues(i).length ? '<span class="badge unpaid">זיכוי דורש תיקון</span>' : ""}</span><span class="invoice-values"><strong class="amount">${e(money(i.finalAgorot))}</strong><span class="badge ${paid ? "paid" : "unpaid"}">${paid ? icon("check") + "שולם" : "לא שולם"}</span></span>${icon("arrow")}</button></article>`;
      })
      .join("") +
    (items.length > ctx.limit
      ? act("more", `הצג עוד (${items.length - ctx.limit})`, "secondary", null)
      : "")
  );
}
function filters(ctx, { status = false, period = true, invoiceActions = false } = {}) {
  const f = ctx.filters;
  const active = f.supplierId || f.method || f.status || (period && (f.from || f.to || f.month));
  return `<details class="filter-panel ${invoiceActions ? "invoice-options" : ""}" ${(invoiceActions ? f.optionsOpen : active) ? "open" : ""}><summary>${invoiceActions ? "אפשרויות נוספות" : period ? "אפשרויות סינון נוספות" : "סינון לפי ספק או תשלום"}${invoiceActions && active ? '<span class="filter-active">סינון פעיל</span>' : ""}</summary>${invoiceActions ? `<div class="invoice-options-actions">${act("invoice", "הוספה ידנית", "secondary", "plus")}${act("manage-suppliers", "ניהול ספקים", "text-button", "suppliers")}<button class="text-button" data-route="checks">${icon("search")} חיפוש צ׳ק — למי הוא נמסר?</button>${act("refresh", "רענן נתונים", "text-button", "refresh")}</div><h2 class="filter-title">סינון החשבוניות</h2>` : ""}<div class="filters advanced-filters">${period ? field("חודש מסוים", "month", f.month || "", { type: "month" }) + `<div class="date-range">${field("מתאריך", "from", f.from || "", { type: "date" })}${field("עד תאריך", "to", f.to || "", { type: "date" })}</div>` : ""}${select("ספק", "supplierId", f.supplierId || "", { "": "כל הספקים", ...Object.fromEntries(ctx.data.suppliers.filter(s => !s.deletedAt).map(s => [s.id, s.name])) })}${select("אמצעי תשלום", "method", f.method || "", { "": "כל האמצעים", ...methods })}${status ? select("מצב", "status", f.status || "", { "": "הכול", paid: "שולם", unpaid: "לא שולם" }) : ""}<button class="text-button" data-action="clear-filters">נקה סינון</button></div></details>`;
}
const searchBox = (ctx, id, label) => `<div class="search">${icon("search")}<input id="${id}" placeholder="${label}" value="${e(ctx.filters.q || "")}" aria-label="${label}">${ctx.filters.q ? `<button class="icon-button clear-search" data-action="clear-search" aria-label="נקה חיפוש">${icon("close")}</button>` : ""}</div>`;
export function invoicesView(ctx) {
  const f = ctx.filters, path = ctx.folderPath || {}, inFolder = Boolean(path.month);
  // Everything still open for one supplier, across every month: a flat list
  // like a search, but laid out month by month so the eye can find the sets.
  const owing = f.view === "supplier-open" && !f.q?.trim();
  const searching = Boolean(f.q?.trim()), direct = searching || f.view === "list" || owing;
  const items = filterInvoices(ctx.data.invoices, { ...f, ...(path.month ? { month: path.month } : {}), ...(path.supplierId ? { supplierId: path.supplierId } : {}) }, ctx.data.suppliers);
  const allOpen = ctx.data.invoices.filter(i => !i.deletedAt && i.status === "unpaid");
  const paymentSupplier = path.supplierId || f.supplierId || (direct && items.length && items.every(i => i.supplierId === items[0].supplierId) ? items[0].supplierId : null);
  const openTotals = totals(allOpen), itemTotals = totals(items);
  const owingSupplier = owing ? ctx.data.suppliers.find(s => s.id === f.supplierId) : null;
  // The screen opens on what is still owed, but the tabs above it can widen it;
  // the subtitle has to keep saying what is actually on the screen.
  const owingScope = f.status === "unpaid" ? "כל מה שעוד לא שולם" : f.status === "paid" ? "מה שכבר שולם" : "כל החשבוניות";
  return `${inFolder ? folderLocation(ctx) : owing
      ? `<section class="folder-location" aria-label="התיקייה הנוכחית"><h1 tabindex="-1" data-folder-heading>${e(owingSupplier?.name || "ספק")}</h1><p>${owingScope} · כל החודשים</p></section>`
      : `<div class="page-heading"><h1>${f.view === "list" ? "חשבוניות בכל החודשים" : "חשבוניות"}</h1></div>`}
    ${searchBox(ctx, "invoice-search", "חפש ספק, תאריך או סכום")}
    ${draftReminders(ctx)}
    ${!inFolder && !direct ? `<button class="payable-summary payable-compact" data-action="open-unpaid"><span><strong>${allOpen.length ? (allOpen.length === 1 ? "חשבונית אחת לתשלום" : allOpen.length + " חשבוניות לתשלום") : "אין כרגע חשבוניות פתוחות"}</strong><small>בכל החודשים · ${e(summaryMoney(openTotals.final))}</small></span>${icon("arrow")}</button>` : ""}
    ${path.supplierId || direct ? statusTabs(f.status) : ""}
    ${paymentSupplier && allOpen.some(i => i.supplierId === paymentSupplier) ? act("batch-payment", "בחר חשבוניות לתשלום יחד", "primary batch-payment-entry", "check", `data-id="${e(paymentSupplier)}"`) : ""}
    ${filters(ctx, { invoiceActions: true, status: !path.supplierId && !direct })}${creditNotice(itemTotals.invalidCredits || openTotals.invalidCredits)}
    ${direct || path.supplierId ? `<div class="list-heading" role="status"><span>${searching ? "תוצאות חיפוש · " : ""}${items.length} חשבוניות</span><span>${e(summaryMoney(itemTotals.final))}</span></div>` : ""}
    ${items.length || (inFolder && !direct) ? owing ? `<div class="invoice-list">${monthSections(items, ctx, invoiceCards)}</div>` : direct ? `<div class="invoice-list">${invoiceCards(items, ctx)}</div>` : invoiceFolders(items, ctx, invoiceCards) : empty(searching || f.month || f.supplierId || f.status ? "אין חשבוניות שמתאימות לסינון" : "כאן יישמרו החשבוניות שלך", searching || f.month || f.supplierId || f.status ? "אפשר לנקות את הסינון ולראות את כל החשבוניות." : "צלם חשבונית ממסך הבית, מלא את הפרטים ושמור.", searching || f.month || f.supplierId || f.status ? act("clear-filters", "נקה חיפוש וסינון", "secondary", null) : "")}`;
}
export function suppliersView(ctx) {
  const q = (ctx.filters.q || "").toLowerCase();
  const suppliers = ctx.data.suppliers.filter(s => !s.deletedAt && [s.name, s.notes, s.contact].join(" ").toLowerCase().includes(q) && (!ctx.filters.activeOnly || s.active));
  return `<button class="text-button back-link" data-route="invoices">חזרה לחשבוניות</button><div class="page-heading"><h1>ניהול ספקים</h1>${act("supplier", "הוסף ספק", "secondary", "plus")}</div>${searchBox(ctx, "supplier-search", "חפש ספק")}<button class="text-button recycle-link" data-route="supplier-trash">${icon("trash")} סל מחזור (${recycledSuppliers(ctx).length})</button><label class="checkbox"><input id="active-only" type="checkbox" ${ctx.filters.activeOnly ? "checked" : ""}> הצג רק ספקים פעילים</label><div class="supplier-list">${suppliers.length ? suppliers.sort((a, b) => a.name.localeCompare(b.name, "he")).map(s => {
    const rows = ctx.data.invoices.filter(i => !i.deletedAt && i.supplierId === s.id && i.status === "unpaid");
    return `<article class="supplier-card"><div class="supplier-avatar">${e(s.name[0])}</div><div class="supplier-info"><h2>${e(s.name)}${s.active ? "" : " <small>לא פעיל</small>"}</h2><p>${rows.length} חשבוניות לתשלום · <strong>${e(summaryMoney(totals(rows).final))}</strong></p>${s.contact ? `<p class="muted">${e(s.contact)}</p>` : ""}<div class="row-actions">${act("supplier-invoices", "חשבוניות הספק", "secondary", "invoice", `data-id="${e(s.id)}"`)}${act("supplier-edit", "ערוך / הסר ספק", "text-button", null, `data-id="${e(s.id)}"`)}</div></div></article>`;
  }).join("") : empty("אין ספקים בתצוגה הזאת", "אפשר להוסיף ספק כאן, או בזמן שמירת החשבונית.", act("supplier", "הוסף ספק", "secondary"))}</div>`;
}
const recycleDeadline = s => s.restoreUntil ?? s.deletedAt + 30 * 24 * 60 * 60 * 1000;
const recycledSuppliers = ctx => ctx.data.suppliers.filter(s => s.deletedAt && recycleDeadline(s) > Date.now());
export function supplierTrashView(ctx) {
  const rows = recycledSuppliers(ctx).sort((a, b) => b.deletedAt - a.deletedAt);
  return `<button class="text-button back-link" data-route="suppliers">חזרה לספקים</button><div class="page-heading"><h1>סל מחזור · ספקים</h1></div><p class="page-intro">אפשר לשחזר ספק במשך 30 יום ממחיקתו. החשבוניות והצילומים נשארים בהיסטוריה.</p>${rows.length ? rows.map(s => `<article class="trash-card"><div><h2>${e(s.name)}</h2><p class="small muted">ניתן לשחזר עד ${e(new Date(recycleDeadline(s)).toLocaleDateString("he-IL"))} · עוד ${Math.ceil((recycleDeadline(s) - Date.now()) / 86400000)} ימים</p></div>${act("supplier-restore", "שחזר ספק", "secondary", "refresh", `data-id="${e(s.id)}"`)}</article>`).join("") : empty("סל המחזור ריק", "ספקים שנמחקו יוצגו כאן למשך 30 יום.")}`;
}
export function documentsView(ctx) {
  const path = ctx.folderPath || {};
  const searching = Boolean(ctx.filters.q?.trim());
  const items = filterInvoices(ctx.data.invoices, { ...ctx.filters, ...(path.month ? { month: path.month } : {}), ...(path.supplierId ? { supplierId: path.supplierId } : {}) }, ctx.data.suppliers).filter(i => i.attachmentIds?.length);
  const monthInvoices = path.month ? ctx.data.invoices.filter(i => !i.deletedAt && i.invoiceDate?.startsWith(path.month) && i.attachmentIds?.length) : [];
  return `${path.month ? folderLocation(ctx) : `<div class="page-heading"><h1>צילומי חשבוניות</h1>${act("scan", "צלם", "secondary", "camera")}</div><p class="page-intro">בחר חודש לשליחה לרואה החשבון.</p>`}
    ${path.month && monthInvoices.length ? `<section class="month-share"><strong>שליחה לרואה החשבון</strong><p>${monthInvoices.length} חשבוניות · כל הספקים בחודש ${e(monthLabel(path.month))} · PDF אחד לכל חשבונית</p>${act("share-month", "שתף את חשבוניות החודש ב־PDF", "primary", "share", `data-month="${e(path.month)}"`)}</section>` : ""}
    ${searchBox(ctx, "invoice-search", "חפש ספק, תאריך או סכום")}<div class="list-heading"><span>${items.length} חשבוניות עם צילומים בתצוגה</span></div>
    ${items.length || (path.month && !searching) ? searching ? `<div class="invoice-list">${documentCards(items, ctx)}</div>` : invoiceFolders(items, ctx, documentCards, { photos: true }) : empty(searching ? "לא נמצאו צילומים שמתאימים לחיפוש" : "אין עדיין צילומי חשבוניות בתצוגה", searching ? "נסה ספק, תאריך או סכום אחר." : "אחרי צילום, מילוי הפרטים ושמירת החשבונית — הצילומים שלה יופיעו כאן.")}`;
}
export function checksView(ctx) {
  const q = (ctx.filters.q || "").trim().replace(/\s/g, "").toLowerCase();
  const items = filterInvoices(ctx.data.invoices, { status: "paid", method: "check" }, ctx.data.suppliers)
    .filter(i => !q || String(i.payment.checkNumber || "").replace(/\s/g, "").toLowerCase().includes(q));
  return `<button class="text-button back-link" data-route="invoices">חזרה לחשבוניות</button><div class="page-heading"><h1>חיפוש צ׳ק</h1></div><p class="page-intro">למי הצ׳ק נמסר? החיפוש כולל את כל החודשים והספקים.</p>
    ${searchBox(ctx, "check-search", "הקלד מספר צ׳ק, גם חלק ממנו")}
    <div class="list-heading"><span>${items.length} חשבוניות ששולמו בצ׳ק${q ? " ומתאימות לחיפוש" : ""}</span></div>
    <div class="invoice-list">${items.length ? invoiceCards(items, ctx) : empty("לא נמצא צ׳ק מתאים", "נסה מספר אחר. אפשר לחפש צ׳ק רק אם המספר שלו הוזן בפרטי התשלום.")}</div>`;
}
export function cashView(ctx) {
  const f = ctx.filters,
    rows = ctx.data.dailyCash
      .filter(
        (r) =>
          !r.deletedAt &&
          (!f.month || r.date.startsWith(f.month)) &&
          (!f.from || r.date >= f.from) &&
          (!f.to || r.date <= f.to),
      )
      .sort((a, b) => b.date.localeCompare(a.date));
  const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  return `<div class="page-heading"><div><h1>קופה ורב־קו</h1></div>${act("cash", "רשום סגירה", "primary", "plus")}</div><p class="muted">רושמים את סגירת היום: קופה ורב־קו, כל סכום בנפרד.</p>${periodPicker(ctx)}<div class="cash-totals"><div class="summary-card"><span>קופה בתקופה</span><strong>${e(money(sum("cashAgorot")))}</strong><small>${rows.filter((r) => r.cashAgorot !== null).length} רישומים</small></div><div class="summary-card"><span>רב־קו בתקופה</span><strong>${e(money(sum("ravKavAgorot")))}</strong><small>${rows.filter((r) => r.ravKavAgorot !== null).length} רישומים</small></div></div>${rows.length ? `<div class="list-heading"><span>${rows.length} ימי רישום</span>${act("cash-export", "ייצוא CSV", "text-button", "download")}</div><div class="cash-list">${rows.map((r) => `<button class="cash-row" data-action="cash-edit" data-id="${e(r.id)}"><strong>${e(displayDate(r.date))}</strong><span><small>קופה</small>${e(money(r.cashAgorot))}</span><span><small>רב־קו</small>${e(money(r.ravKavAgorot))}</span>${icon("arrow")}</button>`).join("")}</div>` : empty("אין עדיין רישומי סגירה בתקופה הזאת", "בסיום היום מזינים כל סכום בשדה שלו.", act("cash", "רשום סגירה ראשונה"))}`;
}
export function reportsView(ctx) {
  const items = filterInvoices(ctx.data.invoices, ctx.filters, ctx.data.suppliers), t = totals(items);
  const paid = items.filter(i => i.status === "paid"), unpaid = items.filter(i => i.status !== "paid");
  const supplierMap = new Map(ctx.data.suppliers.map(s => [s.id, s.name]));
  const supplierIds = [...new Set(items.map(i => i.supplierId))].sort((a, b) => (supplierMap.get(a) || "").localeCompare(supplierMap.get(b) || "", "he"));
  return `<div class="page-heading"><h1>סיכום חודשי</h1></div><p class="page-intro">כמה נרשם בחשבוניות, מה שולם ומה עוד לתשלום. לפי תאריך החשבונית.</p>${periodPicker(ctx)}${filters(ctx, { status: true, period: false })}
    <div class="report-overview"><span>${items.length} חשבוניות · ${e(ctx.filters.month ? monthLabel(ctx.filters.month) : `${ctx.filters.from ? displayDate(ctx.filters.from) : "מההתחלה"} — ${ctx.filters.to ? displayDate(ctx.filters.to) : "עד היום"}`)}</span><strong>${e(summaryMoney(t.final))}</strong><small>סכום סופי לאחר הפחתות וזיכויים</small></div>
    <div class="cash-totals"><div class="summary-card"><span>שולם</span><strong>${e(summaryMoney(totals(paid).final))}</strong><small>${paid.length} חשבוניות</small></div><div class="summary-card"><span>נותר לתשלום</span><strong>${e(summaryMoney(totals(unpaid).final))}</strong><small>${unpaid.length} חשבוניות</small></div></div>
    ${creditNotice(t.invalidCredits)}
    <section class="report-section"><h2>פירוט לפי ספק</h2>${items.length ? `<div class="report-suppliers">${supplierIds.map(id => {
      const rows = items.filter(i => i.supplierId === id), due = rows.filter(i => i.status === "unpaid");
      return `<button class="report-supplier-row" data-action="report-supplier" data-id="${e(id)}"><span><strong>${e(supplierMap.get(id) || "ספק")}</strong><small>${rows.length} חשבוניות</small></span><span><strong>${e(summaryMoney(totals(rows).final))}</strong><small>${due.length ? "לתשלום: " + e(summaryMoney(totals(due).final)) : "הכול שולם"}</small></span>${icon("arrow")}</button>`;
    }).join("")}</div>` : '<p class="muted">אין חשבוניות בתקופה הזאת. אפשר לבחור חודש אחר.</p>'}</section>
    <section class="report-section"><h2>סכומים ומע״מ</h2><dl class="vat-summary"><div><dt>לפני מע״מ</dt><dd>${e(summaryMoney(t.subtotal))}</dd></div><div><dt>מע״מ שנרשם</dt><dd>${e(summaryMoney(t.vat))}</dd></div><div><dt>כולל מע״מ</dt><dd>${e(summaryMoney(t.total))}</dd></div></dl>${t.unknownVat || t.unknownSubtotal ? `<div class="notice warning">הסיכום אינו מלא: ${t.unknownVat} חשבוניות ללא מע״מ ידוע; ${t.unknownSubtotal} ללא סכום לפני מע״מ.</div>` : ""}</section>
    <section class="report-section report-export"><h2>ייצוא ושמירת הסיכום</h2><p class="muted small">הייצוא כולל את החשבוניות בתקופה שבחרת.</p><div class="row-actions">${act("invoice-export", "הורד לאקסל (CSV)", "secondary", "download")}${act("print", "הדפס / שמור PDF", "secondary", null)}</div></section>`;
}
export function settingsView(ctx) {
  return `<div class="page-heading"><div><span class="eyebrow">המכשיר והנתונים</span><h1>הגדרות וגיבוי</h1></div></div><section class="settings-section"><h2>השלמת מע״מ בסריקה</h2><p>ברירת המחדל: <strong>${(ctx.data.settings?.find(s => s.id === "accounting")?.defaultVatBasisPoints ?? 1800) / 100}%</strong>. החישוב מוצע רק כשצריך אישור שלך.</p>${act("vat-preferences", "שנה שיעור מע״מ", "secondary", null)}</section><section class="settings-section"><h2>צבע הסימון „שולם”</h2><p>בחר צבע מוכר לך. המילה „שולם” תופיע תמיד לצד הצבע. הבחירה נשמרת במכשיר הזה.</p><div class="paid-color-options" role="group" aria-label="צבע הסימון שולם"><button class="secondary" data-action="paid-color" data-value="green" aria-pressed="${ctx.paidColor !== "red"}">ירוק · שולם</button><button class="secondary" data-action="paid-color" data-value="red" aria-pressed="${ctx.paidColor === "red"}">אדום · כמו באקסל</button></div></section><section class="settings-section"><h2>גיבוי הנתונים</h2><p>הורד גיבוי JSON של הספקים, החשבוניות, התשלומים והסגירות היומיות. קבצי הצילום עצמם זמינים במסך צילומי חשבוניות, לפי חודש וספק.</p>${act("backup", "הורד גיבוי מלא של הנתונים", "primary", "download")}</section><section class="settings-section"><h2>טיוטות במכשיר</h2><p>טיוטות נשמרות במכשיר הזה. אם תשובת השמירה לא התקבלה, אפשר לבדוק כאן אם הפעולה נשמרה בחנות.</p><div class="row-actions">${
    [
      ["invoice", "חשבונית"],
      ["supplier", "ספק"],
      ["payment", "תשלום"],
      ["cash", "סגירה יומית"],
      ["scan", "צילום חשבונית"],
      ["preferences", "הגדרת מע״מ"],
    ]
      .filter(([key]) => ctx.draftNames.includes(key))
      .map(([key, label]) =>
        act("resume-draft", label, "secondary", null, `data-key="${key}"`),
      )
      .join("") || '<span class="muted">אין טיוטות פתוחות</span>'
  }</div>${ctx.draftNames
    .filter((k) => k.startsWith("cancelled-"))
    .map((key) =>
      act(
        "check-cancelled",
        "בדוק שמירה שבוטלה",
        "secondary",
        null,
        `data-key="${e(key)}"`,
      ),
    )
    .join("")}${ctx.draftNames
    .filter((k) => k.startsWith("saved-"))
    .map((key) =>
      act(
        "saved-draft",
        "טיוטה קודמת שנשמרה",
        "secondary",
        null,
        `data-key="${e(key)}"`,
      ),
    )
    .join("")}${ctx.draftNames
    .filter((k) => k.startsWith("conflict-"))
    .map((key) =>
      act(
        "conflict-draft",
        "טיוטה מעריכה שהתנגשה",
        "text-button",
        null,
        `data-key="${e(key)}"`,
      ),
    )
    .join(
      "",
    )}</section><section class="settings-section"><h2>פתיחה ממסך הבית</h2><p>באייפון: שיתוף ← הוסף למסך הבית. באנדרואיד: תפריט הדפדפן ← הוסף למסך הבית.</p></section><section class="settings-section"><h2>יציאה מהחשבון</h2><p>בפתיחה רגילה נשארים מחוברים. יציאה מוחקת את הטיוטות במכשיר הזה ודורשת SMS בכניסה הבאה.</p>${act("logout", "צא מהחשבון", "secondary", null)}</section>`;
}
export function shell(ctx) {
  const view = {
    home: homeView,
    more: moreView,
    invoices: invoicesView,
    checks: checksView,
    suppliers: suppliersView,
    documents: documentsView,
    "supplier-trash": supplierTrashView,
    recycle: recycleView,
    cash: cashView,
    reports: reportsView,
    settings: settingsView,
  }[ctx.route];
  const content =
    ctx.route !== "settings" && ctx.syncError
      ? `<div class="empty" role="alert"><h1>לא התקבל עדכון מהשרת</h1><p>יש לנסות שוב כדי לראות אילו חשבוניות עדיין פתוחות ואת הסכומים העדכניים.</p>${act("refresh", "נסה שוב")}</div>`
      : ctx.route !== "settings" && !ctx.lastRefresh
        ? '<div class="empty" role="status"><h1>טוען את נתוני החנות…</h1><p>החשבוניות והסכומים יוצגו אחרי קבלת הנתונים מהשרת.</p></div>'
        : view(ctx);

  const nav = [
    ["home", "בית", "home"],
    ["more", "עוד אפשרויות", "settings"],
  ];
  const selected = ["home", "more"].includes(ctx.route) ? ctx.route : null;
  const inFolder = ["invoices", "documents"].includes(ctx.route) && ctx.folderPath?.month;
  const inList = ctx.route === "invoices" && !inFolder && ["list", "supplier-open"].includes(ctx.filters.view);
  // A supplier's open invoices are reached from inside a month, so Back returns
  // there rather than to the months — the label must not promise otherwise.
  const backLabel = inFolder ? (ctx.folderPath.supplierId ? "חזרה לספקים" : "חזרה לחודשים")
    : inList ? (ctx.filters.view === "supplier-open" ? "חזור" : "חזרה לחודשים") : "חזור";
  // Back sits with Home at the bottom of the phone, where the thumb already
  // rests, rather than at the top corner. It keeps its place on Home too — a
  // bar whose buttons move between screens is harder to learn than a button
  // that is simply unavailable — and nothing else in the bar answers to a
  // mis-tap, so aiming for Back can no longer land on Home.
  const back = `<button class="app-back" data-action="${inFolder ? "folder-back" : inList ? "archive" : "back"}"${ctx.route === "home" ? " disabled" : ""}>${icon("arrow")}<span>${e(ctx.route === "home" ? "חזור" : backLabel)}</span></button>`;
  return `<div class="app-shell" data-section="${e(ctx.route)}" data-paid-color="${e(ctx.paidColor || "green")}"><aside class="sidebar"><div class="brand"><span class="brand-mark">ק</span><span>החשבונות<br><strong>של החנות</strong></span></div><nav aria-label="ניווט ראשי">${back}${nav.map(([route, label, glyph]) => `<button data-route="${route}" class="${selected === route ? "active" : ""}" ${selected === route ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span></button>`).join("")}</nav></aside><div class="workspace"><header class="topbar"><span class="topbar-brand">החשבונות של החנות</span><span id="connection-status" class="connection" role="status">${ctx.loading ? "טוען…" : navigator.onLine ? "" : "אין חיבור לרשת"}</span></header>${ctx.draftWarning ? `<p class="notice warning" role="status">${e(ctx.draftWarning)}</p>` : ""}<main id="main" tabindex="-1">${content}</main><footer class="workspace-footer">${ctx.lastRefresh ? "נטען מהשרת · " + new Date(ctx.lastRefresh).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "ממתין לטעינת הנתונים"}</footer></div></div>`;
}
