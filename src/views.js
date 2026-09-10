import { icon, empty, select, field } from "./ui.js";
import {
  escapeHtml as e,
  money,
  displayDate,
  today,
  methods,
  types,
  filterInvoices,
  totals,
} from "./format.js";
const act = (action, label, cls = "primary", glyph = "plus", extra = "") =>
  `<button class="${cls}" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ""}${e(label)}</button>`;
export function invoiceCards(items, ctx) {
  return (
    items
      .slice(0, ctx.limit)
      .map((i) => {
        const name =
          ctx.data.suppliers.find((s) => s.id === i.supplierId)?.name || "ספק";
        return `<article class="invoice-card"><button class="invoice-main" data-action="detail" data-id="${e(i.id)}"><div><span class="supplier-name">${e(name)}</span><span class="document-meta">${e(types[i.documentType])} ${e(i.documentNumber)} · ${e(displayDate(i.invoiceDate))}</span>${i.notes ? `<span class="invoice-note">${e(i.notes)}</span>` : ""}</div><strong class="amount">${e(money(i.finalAgorot))}</strong></button><div class="invoice-bottom"><span class="badge ${i.status === "paid" ? "paid" : "unpaid"}">${i.status === "paid" ? icon("check") + "שולם · " + e(methods[i.payment?.method] || "") : "לא שולם"}</span>${i.status === "paid" ? `<span class="muted small">${e(displayDate(i.payment?.paymentDate))}</span>` : act("pay", "סמן כשולם", "pay-button", "check", `data-id="${e(i.id)}"`)}</div></article>`;
      })
      .join("") +
    (items.length > ctx.limit
      ? act("more", `הצג עוד (${items.length - ctx.limit})`, "secondary", null)
      : "")
  );
}
function filters(ctx, { status = false, cash = false } = {}) {
  const f = ctx.filters;
  return `<details class="filter-panel" ${f.month || f.supplierId || f.from || f.to || f.method ? "open" : ""}><summary>סינון לפי תקופה${cash ? "" : " / ספק"}</summary><div class="filters">${field("חודש", "month", f.month || "", { type: "month" })}${field("מתאריך", "from", f.from || "", { type: "date" })}${field("עד תאריך", "to", f.to || "", { type: "date" })}${cash ? "" : select("ספק", "supplierId", f.supplierId || "", { "": "כל הספקים", ...Object.fromEntries(ctx.data.suppliers.map((s) => [s.id, s.name])) })}${cash ? "" : select("אמצעי תשלום", "method", f.method || "", { "": "כל האמצעים", ...methods })}${status ? select("מצב", "status", f.status || "", { "": "הכול", paid: "שולם", unpaid: "לא שולם" }) : ""}<button class="text-button" data-action="clear-filters">נקה סינון</button></div></details>`;
}
export function invoicesView(ctx) {
  const f = ctx.filters,
    items = filterInvoices(ctx.data.invoices, f, ctx.data.suppliers),
    allOpen = ctx.data.invoices.filter(
      (i) => !i.deletedAt && i.status === "unpaid",
    ),
    openSum = allOpen.reduce((n, i) => n + i.finalAgorot, 0);
  return `<div class="page-heading"><div><span class="eyebrow">חשבוניות ותשלומים</span><h1>${f.supplierId ? e(ctx.data.suppliers.find((s) => s.id === f.supplierId)?.name || "חשבוניות ספק") : "מה צריך לשלם?"}</h1></div>${act("refresh", "רענן", "icon-button", "refresh", 'aria-label="רענן נתונים"')}</div><div class="overview"><div><span>חשבוניות פתוחות</span><strong>${allOpen.length}</strong></div><div><span>סכום החשבוניות הפתוחות</span><strong>${e(money(openSum))}</strong></div></div><div class="main-actions">${act("invoice", "הוסף חשבונית")}${act("scan", "סרוק חשבונית", "secondary", "camera")}</div>${ctx.draftNames.includes("invoice") ? `<button class="draft-banner" data-action="invoice">יש טיוטת חשבונית במכשיר · המשך למלא ${icon("arrow")}</button>` : ""}<div class="tabs" role="group" aria-label="מצב חשבוניות">${[
    ["unpaid", "לא שולמו"],
    ["paid", "שולמו"],
    ["", "הכול"],
  ]
    .map(
      ([value, label]) =>
        `<button class="${(f.status || "") === value ? "active" : ""}" data-action="status" data-value="${value}" aria-pressed="${(f.status || "") === value}">${label}</button>`,
    )
    .join(
      "",
    )}</div><label class="search">${icon("search")}<input id="invoice-search" placeholder="חפש ספק, מספר חשבונית או הערה" value="${e(f.q || "")}" aria-label="חיפוש חשבוניות"></label>${filters(ctx)}<div class="list-heading"><span>${items.length} חשבוניות בתצוגה</span><span>${e(money(items.reduce((n, i) => n + i.finalAgorot, 0)))}</span></div><div class="invoice-list">${items.length ? invoiceCards(items, ctx) : empty(allOpen.length === 0 && f.status === "unpaid" ? "אין כרגע חשבוניות פתוחות" : "לא נמצאו חשבוניות בתצוגה הזאת", "אפשר להוסיף חשבונית או לשנות את הסינון.", act("invoice", "הוסף חשבונית ראשונה"))}</div>`;
}
export function suppliersView(ctx) {
  const q = (ctx.filters.q || "").toLowerCase(),
    suppliers = ctx.data.suppliers.filter(
      (s) =>
        !s.deletedAt &&
        [s.name, s.notes, s.contact].join(" ").toLowerCase().includes(q) &&
        (!ctx.filters.activeOnly || s.active),
    );
  return `<div class="page-heading"><div><span class="eyebrow">הספקים של החנות</span><h1>ספקים</h1></div>${act("supplier", "הוסף ספק", "primary", "plus")}</div><label class="search">${icon("search")}<input id="supplier-search" placeholder="חפש ספק" aria-label="חיפוש ספק" value="${e(ctx.filters.q || "")}"></label><label class="checkbox"><input id="active-only" type="checkbox" ${ctx.filters.activeOnly ? "checked" : ""}> הצג רק ספקים פעילים</label><div class="supplier-list">${
    suppliers.length
      ? suppliers
          .sort((a, b) => a.name.localeCompare(b.name, "he"))
          .map((s) => {
            const rows = ctx.data.invoices.filter(
              (i) =>
                !i.deletedAt && i.supplierId === s.id && i.status === "unpaid",
            );
            return `<article class="supplier-card"><div class="supplier-avatar">${e(s.name[0])}</div><div class="supplier-info"><h2>${e(s.name)}${s.active ? "" : " <small>לא פעיל</small>"}</h2><p>${rows.length} חשבוניות פתוחות · <strong>${e(money(rows.reduce((n, i) => n + i.finalAgorot, 0)))}</strong></p>${s.contact ? `<p class="muted">${e(s.contact)}</p>` : ""}${s.notes ? `<p class="muted">${e(s.notes)}</p>` : ""}<div class="row-actions">${act("supplier-invoices", "צפה בחשבוניות", "secondary", "invoice", `data-id="${e(s.id)}"`)}${act("supplier-edit", "ערוך ספק", "text-button", null, `data-id="${e(s.id)}"`)}</div></div></article>`;
          })
          .join("")
      : empty(
          "אין עדיין ספקים",
          "הוסף את הספק הראשון של החנות.",
          act("supplier", "הוסף ספק"),
        )
  }</div>`;
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
  return `<div class="page-heading"><div><span class="eyebrow">רישום יומי</span><h1>קופה ורב־קו</h1></div>${act("cash", "רשום סגירה", "primary", "plus")}</div><p class="muted">הקופה והרב־קו נרשמים בנפרד. הסכומים אינם מחוברים לחשבוניות.</p>${filters(ctx, { cash: true })}<div class="cash-totals"><div class="summary-card"><span>קופה בתקופה</span><strong>${e(money(sum("cashAgorot")))}</strong><small>${rows.filter((r) => r.cashAgorot !== null).length} רישומים</small></div><div class="summary-card"><span>רב־קו בתקופה</span><strong>${e(money(sum("ravKavAgorot")))}</strong><small>${rows.filter((r) => r.ravKavAgorot !== null).length} רישומים</small></div></div>${rows.length ? `<div class="list-heading"><span>${rows.length} ימי רישום</span>${act("cash-export", "ייצוא CSV", "text-button", "download")}</div><div class="cash-list">${rows.map((r) => `<button class="cash-row" data-action="cash-edit" data-id="${e(r.id)}"><strong>${e(displayDate(r.date))}</strong><span><small>קופה</small>${e(money(r.cashAgorot))}</span><span><small>רב־קו</small>${e(money(r.ravKavAgorot))}</span>${icon("arrow")}</button>`).join("")}</div>` : empty("אין עדיין רישומי סגירה בתקופה הזאת", "בסיום היום מזינים כל סכום בשדה שלו.", act("cash", "רשום סגירה ראשונה"))}`;
}
export function reportsView(ctx) {
  const items = filterInvoices(
      ctx.data.invoices,
      ctx.filters,
      ctx.data.suppliers,
    ),
    t = totals(items);
  return `<div class="page-heading"><div><span class="eyebrow">סיכום ועיון</span><h1>דוחות</h1></div>${act("invoice-export", "ייצוא CSV", "secondary", "download")}</div><p class="muted">סיכום לפי תאריך החשבונית. כלי עזר פנימי, אינו דוח רשמי לרשות המסים.</p>${filters(ctx, { status: true })}<div class="report-totals">${[
    ["לפני מע״מ", t.subtotal],
    ["מע״מ שנרשם", t.vat],
    ["כולל מע״מ", t.total],
    ["סופי לתשלום", t.final],
  ]
    .map(
      ([l, a]) =>
        `<div class="summary-card"><span>${l}</span><strong>${e(money(a))}</strong></div>`,
    )
    .join(
      "",
    )}</div>${t.unknownVat || t.unknownSubtotal ? `<div class="notice warning">הסיכום אינו מלא: ${t.unknownVat} חשבוניות ללא מע״מ ידוע; ${t.unknownSubtotal} ללא סכום לפני מע״מ. שדה חסר אינו אפס.</div>` : ""}<div class="row-actions">${act("print", "הדפס / שמור PDF", "secondary", null)}${act("report-scan", "בדיקה מול רואה החשבון", "text-button", null)}</div><div class="list-heading"><span>${items.length} חשבוניות בתקופה</span></div><div class="invoice-list">${items.length ? invoiceCards(items, ctx) : empty("אין חשבוניות בתקופה הזאת", "בחר חודש אחר או הוסף חשבונית.")}</div>`;
}
export function settingsView(ctx) {
  return `<div class="page-heading"><div><span class="eyebrow">המכשיר והנתונים</span><h1>הגדרות וגיבוי</h1></div></div><section class="settings-section"><h2>גיבוי הנתונים</h2><p>הורד גיבוי JSON של הספקים, החשבוניות, התשלומים והסגירות היומיות. קבצי הצילום עצמם נשארים בחנות ואפשר להורידם מכל חשבונית.</p>${act("backup", "הורד גיבוי מלא של הנתונים", "primary", "download")}</section><section class="settings-section"><h2>טיוטות במכשיר</h2><p>טיוטות שעדיין לא נשמרו בשרת נשמרות במכשיר הזה. רשומות ששמרת בשרת זמינות גם בטלפון אחר.</p><div class="row-actions">${
    [
      ["invoice", "חשבונית"],
      ["supplier", "ספק"],
      ["payment", "תשלום"],
      ["cash", "סגירה יומית"],
      ["scan", "סריקת חשבונית"],
      ["reportScan", "סריקת דוח"],
    ]
      .filter(([key]) => ctx.draftNames.includes(key))
      .map(([key, label]) =>
        act("resume-draft", label, "secondary", null, `data-key="${key}"`),
      )
      .join("") || '<span class="muted">אין טיוטות פתוחות</span>'
  }</div>${ctx.draftNames
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
  const nav = [
    ["invoices", "חשבוניות", "invoice"],
    ["suppliers", "ספקים", "suppliers"],
    ["cash", "קופה ורב־קו", "cash"],
    ["reports", "דוחות", "reports"],
  ];
  return `<div class="app-shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">ק</span><span>החשבונות<br><strong>של החנות</strong></span></div><nav aria-label="ניווט ראשי">${nav.map(([route, label, glyph]) => `<button data-route="${route}" class="${ctx.route === route ? "active" : ""}" ${ctx.route === route ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${label}</span></button>`).join("")}</nav><button class="settings-link ${ctx.route === "settings" ? "active" : ""}" data-route="settings">${icon("settings")} הגדרות וגיבוי</button></aside><div class="workspace"><header class="topbar"><span>החשבונות של החנות</span><div><span id="connection-status" class="connection">${ctx.loading ? "טוען…" : navigator.onLine ? "" : "אין חיבור לרשת"}</span><button class="icon-button" data-route="settings" aria-label="הגדרות וגיבוי">${icon("settings")}</button></div></header><main id="main" tabindex="-1">${{ invoices: invoicesView, suppliers: suppliersView, cash: cashView, reports: reportsView, settings: settingsView }[ctx.route](ctx)}</main><footer class="workspace-footer">${ctx.lastRefresh ? "נטען מהשרת · " + new Date(ctx.lastRefresh).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "ממתין לטעינת הנתונים"}</footer></div></div>`;
}
