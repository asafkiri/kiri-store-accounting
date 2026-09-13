import { invoiceFolders, documentCards, periodPicker, statusTabs, summaryMoney, folderLocation } from "./invoice-browser.js";
import { creditSignIssues } from "./credit.js";
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
  invoiceLabel,
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
    <button class="secondary" data-route="settings">${icon("settings")} הגדרות וגיבוי</button></div>`;
}
export function invoiceCards(items, ctx) {
  return (
    items
      .slice(0, ctx.limit)
      .map((i) => {
        const name =
          ctx.data.suppliers.find((s) => s.id === i.supplierId)?.name || "ספק";
        return `<article class="invoice-card status-${i.status === "paid" ? "paid" : "unpaid"}"><button class="invoice-main" data-action="detail" data-id="${e(i.id)}"><div><span class="supplier-name">${e(name)}</span><span class="document-meta">${e(invoiceLabel(i))} · ${e(displayDate(i.invoiceDate))}</span>${i.attachmentIds?.length ? `<span class="document-meta">${i.attachmentIds.length === 1 ? "מסמך מצורף" : i.attachmentIds.length + " מסמכים מצורפים"}</span>` : ""}${i.payment?.method === "check" ? `<span class="check-reference">צ׳ק ${e(i.payment.checkNumber || "ללא מספר")} · נמסר ${e(displayDate(i.payment.paymentDate))}${i.payment.checkDueDate ? " · פירעון " + e(displayDate(i.payment.checkDueDate)) : ""}</span>` : ""}${creditSignIssues(i).length ? '<span class="badge unpaid">זיכוי דורש תיקון</span>' : ""}${i.notes ? `<span class="invoice-note">${e(i.notes)}</span>` : ""}</div><strong class="amount">${e(money(i.finalAgorot))}</strong></button><div class="invoice-bottom"><span class="badge ${i.status === "paid" ? "paid" : "unpaid"}">${i.status === "paid" ? icon("check") + "שולם · " + e(methods[i.payment?.method] || "") : "לא שולם"}</span>${i.attachmentIds?.length ? act("documents", "צילומי החשבונית", "text-button attachment-shortcut", "image", `data-id="${e(i.id)}"`) : ""}${i.status === "paid" ? `<span class="muted small">${e(displayDate(i.payment?.paymentDate))}</span>` : act("pay", "סמן כשולם", "pay-button", "check", `data-id="${e(i.id)}"`)}</div></article>`;
      })
      .join("") +
    (items.length > ctx.limit
      ? act("more", `הצג עוד (${items.length - ctx.limit})`, "secondary", null)
      : "")
  );
}
function filters(ctx, { status = false, period = true } = {}) {
  const f = ctx.filters;
  return `<details class="filter-panel" ${f.supplierId || f.method || (status && f.status) || (period && (f.from || f.to || f.month)) ? "open" : ""}><summary>${period ? "אפשרויות סינון נוספות" : "סינון לפי ספק או תשלום"}</summary><div class="filters advanced-filters">${period ? field("חודש מסוים", "month", f.month || "", { type: "month" }) + `<div class="date-range">${field("מתאריך", "from", f.from || "", { type: "date" })}${field("עד תאריך", "to", f.to || "", { type: "date" })}</div>` : ""}${select("ספק", "supplierId", f.supplierId || "", { "": "כל הספקים", ...Object.fromEntries(ctx.data.suppliers.filter(s => !s.deletedAt).map(s => [s.id, s.name])) })}${select("אמצעי תשלום", "method", f.method || "", { "": "כל האמצעים", ...methods })}${status ? select("מצב", "status", f.status || "", { "": "הכול", paid: "שולם", unpaid: "לא שולם" }) : ""}<button class="text-button" data-action="clear-filters">נקה סינון</button></div></details>`;
}
const searchBox = (ctx, id, label) => `<label class="search">${icon("search")}<input id="${id}" placeholder="${label}" value="${e(ctx.filters.q || "")}" aria-label="${label}"></label>`;
export function invoicesView(ctx) {
  const f = ctx.filters, path = ctx.folderPath || {}, inFolder = Boolean(path.month);
  const items = filterInvoices(ctx.data.invoices, { ...f, ...(path.month ? { month: path.month } : {}), ...(path.supplierId ? { supplierId: path.supplierId } : {}) }, ctx.data.suppliers);
  const allOpen = ctx.data.invoices.filter(i => !i.deletedAt && i.status === "unpaid");
  const openTotals = totals(allOpen), itemTotals = totals(items);
  return `<div class="page-heading"><div><h1>חשבוניות</h1></div>${act("refresh", "רענן", "icon-button", "refresh", 'aria-label="רענן נתונים"')}</div>
    ${!inFolder ? `<section class="invoice-entry" aria-label="הוספת חשבונית"><button class="primary scan-primary" data-action="scan">${icon("camera")}<span><strong>צלם חשבונית</strong><small>המצלמה נפתחת בלחיצה</small></span>${icon("plus")}</button><div class="entry-secondary">${act("invoice", "הוספה ידנית", "text-button", null)}${act("manage-suppliers", "ניהול ספקים", "text-button", "suppliers")}</div></section>` : ""}
    ${draftReminders(ctx)}
    ${!inFolder ? `<button class="payable-summary" data-action="open-unpaid"><span><strong>${allOpen.length ? (allOpen.length === 1 ? "חשבונית אחת לתשלום" : allOpen.length + " חשבוניות לתשלום") : "אין כרגע חשבוניות פתוחות"}</strong><small>בכל החודשים</small></span><strong>${e(summaryMoney(openTotals.final))}</strong>${icon("arrow")}</button><button class="secondary check-search-link" data-route="checks">${icon("search")} חיפוש צ׳ק — למי הוא נמסר?</button>` : ""}
    ${folderLocation(ctx)}
    ${!inFolder ? '<div class="section-label browser-heading"><h2>בחר תיקיית חודש</h2></div>' : ""}
    ${statusTabs(f.status)}${searchBox(ctx, "invoice-search", "חפש ספק, חשבונית או צ׳ק")}${filters(ctx)}${creditNotice(itemTotals.invalidCredits || openTotals.invalidCredits)}
    <div class="list-heading"><span>${items.length} חשבוניות</span><span>${e(summaryMoney(itemTotals.final))}</span></div>
    ${items.length || inFolder ? invoiceFolders(items, ctx, invoiceCards) : empty(f.q || f.month || f.supplierId || f.status ? "אין חשבוניות שמתאימות לסינון" : "כאן יישמרו החשבוניות שלך", f.q || f.month || f.supplierId || f.status ? "אפשר לנקות את הסינון ולראות את כל החשבוניות." : "סרוק חשבונית, בדוק את הפרטים ושמור. היא תופיע בחודש ובספק המתאימים.", f.q || f.month || f.supplierId || f.status ? act("clear-filters", "הצג את כל החשבוניות", "secondary", null) : "")}`;
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
  const items = filterInvoices(ctx.data.invoices, { ...ctx.filters, ...(path.month ? { month: path.month } : {}), ...(path.supplierId ? { supplierId: path.supplierId } : {}) }, ctx.data.suppliers).filter(i => i.attachmentIds?.length);
  const monthInvoices = path.month ? ctx.data.invoices.filter(i => !i.deletedAt && i.invoiceDate?.startsWith(path.month) && i.attachmentIds?.length) : [];
  return `<div class="page-heading"><h1>צילומי חשבוניות</h1>${!path.month ? act("scan", "צלם", "secondary", "camera") : ""}</div>
    ${folderLocation(ctx)}${!path.month ? '<p class="page-intro">בחר חודש, אחר כך ספק וחשבונית. מתוך החודש אפשר לשתף את כל הצילומים עם רואה החשבון.</p>' : ""}
    ${path.month && monthInvoices.length ? `<section class="month-share"><strong>שליחה לרואה החשבון</strong><p>${monthInvoices.length} חשבוניות עם צילומים · כל הספקים בחודש ${e(monthLabel(path.month))}</p>${act("share-month", "שתף את כל צילומי החודש", "primary", "share", `data-month="${e(path.month)}"`)}</section>` : ""}
    ${searchBox(ctx, "invoice-search", "חפש ספק או מספר חשבונית")}<div class="list-heading"><span>${items.length} חשבוניות עם צילומים בתצוגה</span></div>
    ${items.length || path.month ? invoiceFolders(items, ctx, documentCards, { photos: true }) : empty("אין עדיין צילומי חשבוניות בתצוגה", ctx.filters.q ? "נסה שם ספק או מספר חשבונית אחר." : "אחרי סריקה, בדיקת הפרטים ושמירת החשבונית — הצילומים שלה יופיעו כאן.")}`;
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
  return `<div class="app-shell" data-section="${e(ctx.route)}" data-paid-color="${e(ctx.paidColor || "green")}"><aside class="sidebar"><div class="brand"><span class="brand-mark">ק</span><span>החשבונות<br><strong>של החנות</strong></span></div><nav aria-label="ניווט ראשי">${nav.map(([route, label, glyph]) => `<button data-route="${route}" class="${selected === route ? "active" : ""}" ${selected === route ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span></button>`).join("")}</nav></aside><div class="workspace"><header class="topbar">${ctx.route === "home" ? '<span class="topbar-brand">החשבונות של החנות</span>' : `<button class="secondary app-back" data-action="back">חזור</button><button class="secondary" data-route="home">${icon("home")} בית</button>`}<span id="connection-status" class="connection" role="status">${ctx.loading ? "טוען…" : navigator.onLine ? "" : "אין חיבור לרשת"}</span></header>${ctx.draftWarning ? `<p class="notice warning" role="status">${e(ctx.draftWarning)}</p>` : ""}<main id="main" tabindex="-1">${content}</main><footer class="workspace-footer">${ctx.lastRefresh ? "נטען מהשרת · " + new Date(ctx.lastRefresh).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "ממתין לטעינת הנתונים"}</footer></div></div>`;
}
