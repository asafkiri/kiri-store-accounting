import { previewDocument } from "./preview.js";
import { mountInvoicePhoto } from "./invoice-photo.js";
import { batchPaymentForm } from "./batch-payment.js";
import { shareDocuments } from "./document-sharing.js";
import { createNavigation } from "./navigation.js";
import { invoiceDetails, attachmentRows, attachmentRemovalRows, retentionNote } from "./invoice-details.js";
import {
  initializeAuth,
  onAuthStateChanged,
  signOut,
  sendCode,
  authMessage,
} from "./auth.js";
import { Api, pendingMutation } from "./api.js";
import { Drafts } from "./drafts.js";
import { actionableDraftNames } from "./draft-activity.js";
import { $, icon, toast, errorText } from "./ui.js";
import { settleDiscardedAttempts } from "./attempts.js";
import {
  escapeHtml as e,
  money,
  displayDate,
  today,
  methods,
  types,
  filterInvoices,
  monthRange,
  monthLabel,
  invoiceLabel,
} from "./format.js";
import { shell } from "./views.js";
import {
  supplierForm,
  supplierRemovalForm,
  preferencesForm,
  invoiceForm,
  paymentForm,
  cashForm,
  retainDraft,
} from "./forms.js";
import { scanDialog } from "./scan.js";
import { invoiceCsv, cashCsv, download } from "./export.js";
const ctx = {
  route: "home",
  filters: {},
  folderPath: {},
  limit: 80,
  data: { suppliers: [], invoices: [], dailyCash: [], settings: [] },
  version: 0,
  lastRefresh: 0,
  loading: false,
  modalBusy: false,
  draftNames: [],
  epoch: 0,
  // How long the service keeps a photo. The server reports it with every sync;
  // until then the app makes no promise about deletion dates.
  retentionDays: 0,
};
try { ctx.paidColor = window.localStorage.getItem("ksa-paid-color") === "red" ? "red" : "green"; }
catch { ctx.paidColor = "green"; }
document.documentElement.dataset.paidColor = ctx.paidColor;
const sizeDialogs = () => document.documentElement.style.setProperty("--app-visible-height", `${window.visualViewport?.height || window.innerHeight}px`);
window.visualViewport?.addEventListener("resize", sizeDialogs);
sizeDialogs();
const routePositions = new Map();
const pageSnapshot = () => ({ route: ctx.route, filters: ctx.filters, folderPath: ctx.folderPath, limit: ctx.limit, scrollY: window.scrollY });
const samePath = (a = {}, b = {}) => (a?.month || "") === (b?.month || "") && (a?.supplierId || "") === (b?.supplierId || "");
const restorePage = state => {
  const { scrollY, ...page } = state;
  Object.assign(ctx, page);
  ctx.render();
  const main = $("#main");
  main?.focus({ preventScroll: true });
  window.scrollTo(0, scrollY || 0);
  window.requestAnimationFrame?.(() => {
    // A late layout pass must not steal focus from someone already typing,
    // or restore the scroll position of a page they have since left.
    if ($("#main") === main && document.activeElement === main)
      window.scrollTo(0, scrollY || 0);
  });
};
const navigation = createNavigation({
  window, snapshot: pageSnapshot, restore: restorePage,
  blocked: () => ctx.modalBusy,
  dismissOverlay: () => {
    const preview = $(".preview-dialog[open]");
    if (preview) { preview.close(); return true; }
    if ($("#modal").open) { ctx.backModal(); return true; }
    return false;
  },
});
let auth,
  unsubscribe,
  codeSession,
  loginBusy = false;
ctx.dialog = (title, body) => {
  ctx.disposeModal?.();
  ctx.disposeModal = null;
  ctx.modalBack = null;
  const modal = $("#modal");
  modal.innerHTML = `<div class="modal-content"><header class="modal-heading"><div class="modal-navigation"><button class="secondary" data-close-modal>חזור</button><button class="secondary" data-modal-home>${icon("home")} בית</button></div><h2 id="modal-title">${e(title)}</h2></header>${body}</div>`;
  if (!modal.open) modal.showModal();
  modal.scrollTop = 0;
  setTimeout(
    () =>
      $("input:not([type=checkbox]),select,button", modal)?.focus({
        preventScroll: true,
      }),
    0,
  );
  return $(".modal-content", modal);
};
ctx.setModalBusy = (value) => {
  ctx.modalBusy = value;
  document.querySelectorAll("#modal [data-close-modal],#modal [data-modal-home]").forEach(b => { b.disabled = value; });
};
ctx.closeModal = () => {
  ctx.disposeModal?.();
  ctx.disposeModal = null;
  ctx.modalBack = null;
  $("#modal").close();
  ctx.modalBusy = false;
  void ctx.updateDraftNames().then(() => ctx.render());
};
ctx.backModal = () => {
  if (ctx.modalBusy) return;
  if (ctx.modalBack) ctx.modalBack();
  else ctx.closeModal();
};
ctx.showSaved = (key, record) => {
  const supplier = ctx.data.suppliers.find(s => s.id === record.supplierId)?.name || "הספק";
  const title = key === "invoice" ? `החשבונית של ${supplier} נשמרה` : key === "payment" ? "התשלום נרשם" : "סגירת היום נשמרה";
  const description = key === "cash" ? `קופה ורב־קו · ${displayDate(record.date)}`
    : `${invoiceLabel(record)} · ${money(record.finalAgorot)} · ${key === "invoice" ? monthLabel(record.invoiceDate?.slice(0, 7)) : supplier}`;
  const root = ctx.dialog("השמירה הסתיימה", `<section class="save-confirmation" role="status"><span class="saved-mark">${icon("check")}</span><h3>${e(title)}</h3><p>${e(description)}</p>${key === "payment" ? '<p class="badge paid">שולם</p>' : ""}</section><div class="saved-actions"><button class="primary" data-saved-done>סיום וחזרה</button>${key === "invoice" ? '<button class="secondary" data-saved-scan>צלם חשבונית נוספת</button>' : ""}<button class="secondary" data-saved-edit>${key === "payment" ? "תיקון פרטי התשלום" : key === "cash" ? "תיקון סכומי הסגירה" : "תיקון פרטי החשבונית"}</button>${key === "payment" ? '<button class="text-button" data-saved-unpay>טעיתי — החשבונית לא שולמה</button>' : ""}</div>`);
  $("[data-saved-done]", root).onclick = () => ctx.closeModal();
  const run = async (button, fn) => {
    if (button.disabled) return;
    button.disabled = true;
    try { await fn(); }
    catch (err) { toast(errorText(err), true); }
    finally { button.disabled = false; }
  };
  $("[data-saved-edit]", root).onclick = ev => run(ev.currentTarget, () => ctx.reopen(key, record.id));
  const scan = $("[data-saved-scan]", root);
  if (scan) scan.onclick = () => run(scan, () => scanDialog(ctx, { openCamera: true }));
  const unpay = $("[data-saved-unpay]", root);
  if (unpay) unpay.onclick = () => run(unpay, () => action("unpay", { id: record.id }));
};
ctx.previewBlob = previewDocument;
ctx.updateDraftNames = async () => {
  const drafts = ctx.drafts;
  if (!drafts) return;
  try {
    const names = await actionableDraftNames(drafts, ctx.data);
    if (ctx.drafts === drafts) ctx.draftNames = names;
  } catch {
    if (ctx.drafts === drafts) ctx.draftWarning = "הנתונים בחנות זמינים, אך הטיוטות במכשיר אינן זמינות כרגע.";
  }
};
ctx.mergeRecord = (record, path) => {
  const collection = path.startsWith("settings") ? "settings" : path.startsWith("suppliers")
    ? "suppliers"
    : path.startsWith("daily-cash")
      ? "dailyCash"
      : "invoices";
  const index = ctx.data[collection].findIndex((r) => r.id === record.id);
  if (index < 0) ctx.data[collection].push(record);
  else if (record.version >= ctx.data[collection][index].version)
    ctx.data[collection][index] = record;
};
// A render rebuilds the section from scratch, so the field being typed into is
// replaced by a new one mid-word: the caret disappears and the next character
// goes nowhere. Renders arrive from elsewhere too — closing a window schedules
// one for whenever the drafts finish being read from the device — so the field
// that held the focus is handed it back, caret where it was left.
const restoreSelector = value => /^[A-Za-z][\w-]*$/.test(value || "");
const focusedField = () => {
  const el = document.activeElement;
  if (!el || !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return null;
  if (!$("#app")?.contains(el)) return null;
  const selector = restoreSelector(el.id) ? "#" + el.id : restoreSelector(el.name) ? `[name="${el.name}"]` : null;
  if (!selector) return null;
  // Dates, months and numbers carry no caret and answer the question by throwing.
  let start = null, end = null;
  try { start = el.selectionStart; end = el.selectionEnd; } catch { start = null; }
  return { selector, start, end };
};
const restoreField = field => {
  if (!field) return;
  const el = $("#app " + field.selector);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (field.start === null || field.start === undefined) return;
  try { el.setSelectionRange(field.start, field.end); } catch { /* the field takes no caret */ }
};
ctx.render = () => {
  if (!ctx.api) return;
  const typing = focusedField();
  $("#app").innerHTML = shell(ctx);
  bindShell();
  restoreField(typing);
};
ctx.refresh = async (force = false) => {
  if (ctx.loading || !ctx.api) return;
  const epoch = ctx.epoch;
  ctx.loading = true;
  const status = $("#connection-status");
  if (status) status.textContent = "טוען…";
  ctx.syncError = false;
  try {
    const r = await ctx.api.request("sync?since=" + (force ? 0 : ctx.version), {
      timeout: 50_000,
    });
    if (epoch !== ctx.epoch) return;
    if (Number.isInteger(r.documentRetentionDays))
      ctx.retentionDays = r.documentRetentionDays;
    if (!r.unchanged) {
      for (const collection of ["suppliers", "invoices", "dailyCash", "settings"]) {
        if (r.full) ctx.data[collection] = r[collection] || [];
        else
          for (const item of r[collection] || [])
            ctx.mergeRecord(
              item,
              collection === "dailyCash" ? "daily-cash" : collection,
            );
      }
      ctx.version = r.version;
    }
    ctx.lastRefresh = Date.now();
    ctx.render(); // Render the successful server snapshot before local storage work.
    try { await settleDiscardedAttempts(ctx); }
    catch { ctx.draftWarning = "לא ניתן לקרוא כרגע את הטיוטות במכשיר. הנתונים מהחנות עודכנו."; }
    if (epoch !== ctx.epoch) return;
    await ctx.updateDraftNames();
  } catch (err) {
    if (epoch !== ctx.epoch) return;
    ctx.syncError = true;
    toast(errorText(err), true);
    const el = $("#connection-status");
    if (el) el.textContent = "לא התקבל עדכון מהשרת";
    if (err.status === 403) {
      ctx.api = null;
      ctx.data = { suppliers: [], invoices: [], dailyCash: [], settings: [] };
      accessError(err);
    }
  } finally {
    if (epoch !== ctx.epoch) return;
    ctx.loading = false;
    ctx.render();
    const el = $("#connection-status");
    if (el)
      el.textContent = ctx.syncError
        ? "הנתונים לא עודכנו"
        : navigator.onLine
          ? ""
          : "אין חיבור לרשת";
  }
};
ctx.reopen = async (key, id) => {
  if (key === "payment") {
    const draft = await ctx.drafts.load("payment");
    if (draft?.batchSupplierId) return batchPaymentForm(ctx, draft.batchSupplierId);
  }
  const record = ctx.data.invoices.find((i) => i.id === id);
  if (key === "preferences") return preferencesForm(ctx);
  if (key === "invoice") return invoiceForm(ctx, record);
  if (key === "supplier")
    return supplierForm(
      ctx,
      ctx.data.suppliers.find((s) => s.id === id),
    );
  if (key === "cash")
    return cashForm(
      ctx,
      ctx.data.dailyCash.find((s) => s.id === id),
      id,
    );
  if (key === "payment" && record) return paymentForm(ctx, record);
};
function navigate(route, { reset = false } = {}) {
  if (ctx.modalBusy) return;
  routePositions.set(ctx.route, structuredClone(pageSnapshot()));
  navigation.visit(() => {
    const saved = !reset && route !== ctx.route && routePositions.get(route);
    const state = saved || { route, folderPath: {}, limit: 80, scrollY: 0,
      filters: route === "suppliers" ? { activeOnly: true } : ["cash", "reports"].includes(route) ? { month: today().slice(0, 7) } : {} };
    restorePage(state);
  });
}
function bindShell() {
  const root = $("#app");
  const invoiceOptions = $(".invoice-options");
  const rememberOptions = () => {
    if (invoiceOptions?.isConnected) ctx.filters.optionsOpen = invoiceOptions.open;
  };
  if (invoiceOptions) invoiceOptions.ontoggle = rememberOptions;
  root.onclick = async (ev) => {
    const nav = ev.target.closest("[data-route]");
    if (nav) {
      navigate(nav.dataset.route);
      return;
    }
    const documentButton = ev.target.closest("[data-open-document]");
    if (documentButton) return openDocument(documentButton);
    const button = ev.target.closest("[data-action]");
    if (!button) return;
    try {
      await action(button.dataset.action, button.dataset);
    } catch (err) {
      toast(errorText(err), true);
    }
  };
  for (const el of root.querySelectorAll(".filters input,.filters select"))
    el.onchange = () => {
      rememberOptions();
      ctx.filters[el.name] = el.value;
      if (el.name === "month") {
        ctx.filters.from = "";
        ctx.filters.to = "";
      }
      if (el.name === "from" || el.name === "to") ctx.filters.month = "";
      // A new period/supplier selection must not be overridden by the folder
      // that was open when the user changed the filter.
      if (["month", "from", "to", "supplierId"].includes(el.name)) ctx.folderPath = {};
      ctx.limit = 80;
      ctx.render();
    };
  const search = $("#invoice-search") || $("#supplier-search") || $("#check-search");
  if (search)
    search.oninput = () => {
      rememberOptions();
      ctx.filters.q = search.value;
      ctx.limit = 80;
      // The focus and the caret ride the render itself now, from wherever it
      // was triggered, so typing here needs nothing of its own.
      ctx.render();
    };
  const active = $("#active-only");
  if (active)
    active.onchange = () => {
      ctx.filters.activeOnly = active.checked;
      ctx.render();
    };
}
async function action(type, data = {}) {
  if (["restore-invoice", "restore-photo"].includes(type)) {
    if (ctx.modalBusy) return;
    const invoice = ctx.data.invoices.find(i => i.id === data.id);
    if (!invoice) return;
    if (type === "restore-invoice") return simpleMutation("restore", invoice);
    return restorePhoto(invoice, data.document);
  }
  if (type === "recycle") { ctx.closeModal(); return navigate("recycle"); }
  if (type === "pay-supplier") {
    const invoice = ctx.data.invoices.find(i => i.id === data.id);
    if (invoice) return batchPaymentForm(ctx, invoice.supplierId);
  }
  if (type === "batch-payment") return batchPaymentForm(ctx, data.id);
  const record = ctx.data.invoices.find((i) => i.id === data.id);
  switch (type) {
    case "back":
      return navigation.back(() => navigate("home"));
    case "folder-month":
      navigation.visit(() => {
        ctx.folderPath = { month: data.value };
        ctx.limit = 80; ctx.render();
        window.scrollTo(0, 0); $("[data-folder-heading]")?.focus({ preventScroll: true });
      });
      return;
    case "folder-supplier":
      navigation.visit(() => {
        ctx.folderPath = { ...ctx.folderPath, supplierId: data.value };
        ctx.limit = 80; ctx.render();
        window.scrollTo(0, 0); $("[data-folder-heading]")?.focus({ preventScroll: true });
      });
      return;
    case "folder-back": {
      // One level up, whatever the history behind this screen happens to hold.
      const parent = ctx.folderPath.supplierId ? { month: ctx.folderPath.month } : {};
      navigation.up(
        entry => entry.route === ctx.route && samePath(entry.folderPath, parent),
        () => {
          ctx.folderPath = parent;
          ctx.limit = 80; ctx.render();
          window.scrollTo(0, 0); $("[data-folder-heading]")?.focus({ preventScroll: true });
        },
      );
      return;
    }
    case "paid-color":
      ctx.paidColor = data.value === "red" ? "red" : "green";
      try { window.localStorage.setItem("ksa-paid-color", ctx.paidColor); } catch { /* Current session remains usable. */ }
      document.documentElement.dataset.paidColor = ctx.paidColor;
      return ctx.render();
    case "share-month":
      return shareDocuments(ctx, { month: data.month });
    case "share-invoice":
      return shareDocuments(ctx, { invoiceId: data.id });
    case "invoice":
      return invoiceForm(ctx, null, [], { quick: true });
    case "scan": {
      // Started from a supplier's folder, the supplier travels with the scan
      // and the questions open on the amount instead of asking who it is.
      const from = ctx.data.suppliers.find(s => s.id === data.supplier && !s.deletedAt);
      return scanDialog(ctx, { openCamera: true, supplier: from ? { id: from.id, name: from.name } : null });
    }
    case "vat-preferences":
      return preferencesForm(ctx);
    case "supplier-restore":
      return supplierRemovalForm(ctx, ctx.data.suppliers.find(s => s.id === data.id), null, "restore");
    case "supplier":
      return supplierForm(ctx);
    case "manage-suppliers":
      return navigate("suppliers");
    case "supplier-edit":
      return supplierForm(
        ctx,
        ctx.data.suppliers.find((s) => s.id === data.id),
      );
    case "cash":
      // Starting a closing must not open today's saved record for editing.
      // Existing amounts belong only to the explicit cash-edit action below.
      return cashForm(ctx);
    case "cash-edit":
      return cashForm(
        ctx,
        ctx.data.dailyCash.find((r) => r.id === data.id),
      );
    case "pay":
      return paymentForm(ctx, record, { onBack: $(".invoice-detail-modal") ? () => detail(ctx.data.invoices.find(i => i.id === record.id)) : null });
    case "detail":
      return detail(record);
    case "documents":
      return documentList(data.id);
    case "edit":
      return invoiceForm(ctx, record);
    case "refresh":
      return ctx.refresh(true);
    case "more":
      ctx.limit += 80;
      ctx.render();
      break;
    case "status":
      ctx.filters.status = data.value;
      ctx.limit = 80;
      ctx.render();
      break;
    case "supplier-open":
      // Out of the month, into everything still owed to this one supplier.
      navigation.visit(() => {
        ctx.filters = { supplierId: data.id, status: "unpaid", view: "supplier-open" };
        ctx.folderPath = {};
        ctx.limit = 80;
        ctx.render();
        window.scrollTo(0, 0);
      });
      return;
    case "open-unpaid":
      navigation.visit(() => {
        ctx.filters = { status: "unpaid", view: "list" };
        ctx.folderPath = {};
        ctx.limit = 80;
        ctx.render();
        window.scrollTo(0, 0);
      });
      return;
    case "archive":
      return navigation.back(() => { ctx.filters = {}; ctx.folderPath = {}; ctx.render(); });
    case "clear-search":
      ctx.filters.q = "";
      ctx.limit = 80;
      ctx.render();
      $("#invoice-search,#supplier-search,#check-search")?.focus({ preventScroll: true });
      return;
    case "period-mode": {
      if (data.value === "range") {
        const range = monthRange(ctx.filters.month || today().slice(0, 7));
        ctx.filters = { ...ctx.filters, month: "", ...range, periodMode: "range" };
      } else {
        ctx.filters = { ...ctx.filters, month: ctx.filters.from?.slice(0, 7) || today().slice(0, 7), from: "", to: "", periodMode: "month" };
      }
      ctx.render();
      break;
    }
    case "clear-filters":
      ctx.filters = ctx.route === "reports" ? { month: ctx.filters.month, from: ctx.filters.from, to: ctx.filters.to, periodMode: ctx.filters.periodMode } : {};
      ctx.limit = 80;
      ctx.render();
      break;
    case "report-supplier": {
      const period = { ...ctx.filters };
      navigate("invoices", { reset: true });
      ctx.filters = { ...period };
      if (period.month) {
        await action("folder-month", { value: period.month });
        await action("folder-supplier", { value: data.id });
      } else ctx.filters.supplierId = data.id;
      ctx.render();
      break;
    }
    case "supplier-invoices":
      navigate("invoices", { reset: true });
      ctx.filters.supplierId = data.id;
      ctx.render();
      break;
    case "invoice-export":
      await download(
        invoiceCsv(
          filterInvoices(ctx.data.invoices, ctx.filters, ctx.data.suppliers),
          ctx.data.suppliers,
        ),
        "invoices-" + (ctx.filters.month || today()) + ".csv",
        "text/csv;charset=utf-8",
      );
      break;
    case "cash-export":
      await download(
        cashCsv(
          ctx.data.dailyCash.filter(
            (r) =>
              (!ctx.filters.month || r.date.startsWith(ctx.filters.month)) &&
              (!ctx.filters.from || r.date >= ctx.filters.from) &&
              (!ctx.filters.to || r.date <= ctx.filters.to),
          ),
        ),
        "cash-" + (ctx.filters.month || today()) + ".csv",
        "text/csv;charset=utf-8",
      );
      break;
    case "backup": {
      const backup = await ctx.api.request("backup", { timeout: 50_000 });
      await download(
        JSON.stringify(backup, null, 2),
        "kiri-accounting-backup-" + today() + ".json",
        "application/json",
      );
      toast("הגיבוי מוכן להורדה");
      break;
    }
    case "print": {
      const old = ctx.limit;
      ctx.limit = Number.MAX_SAFE_INTEGER;
      ctx.render();
      try {
        if (navigator.standalone) {
          toast("להדפסה באייפון אפשר לפתוח את האתר ב־Safari ולבחור שתף ואז הדפס. לייצוא השתמש בכפתור הייצוא.");
        } else window.print();
      } catch { toast("לא ניתן לפתוח הדפסה כאן. פתח את האתר בדפדפן או השתמש בייצוא.", true); }
      ctx.limit = old;
      ctx.render();
      break;
    }
    case "logout":
      if (
        confirm(
          "לצאת ולמחוק את הטיוטות מהמכשיר הזה? חשבוניות שנשמרו בחנות יישארו.",
        )
      ) {
        await ctx.drafts.clear();
        await signOut(auth);
      }
      break;
    case "resume-draft": {
      const d = await ctx.drafts.load(data.key);
      if (data.key === "scan") return scanDialog(ctx, { resume: true });
      return ctx.reopen(data.key, d?.recordId);
    }
    case "check-cancelled": {
      const results = await settleDiscardedAttempts(ctx, data.key);
      await ctx.updateDraftNames();
      ctx.render();
      toast(
        results.includes("committed")
          ? "השמירה הקודמת כבר הושלמה בחנות. הנתונים עודכנו בתצוגה."
          : "ניסיון השמירה בוטל.",
      );
      return;
    }
    case "saved-draft": {
      const d = await ctx.drafts.load(data.key);
      const collection =
        d.kind === "supplier"
          ? "suppliers"
          : d.kind === "cash"
            ? "dailyCash"
            : "invoices";
      const current = ctx.data[collection].find((r) => r.id === d.recordId);
      if (
        current &&
        current.version !== d.version &&
        !d.pending &&
        !d.cancelPending
      ) {
        ctx.dialog(
          "טיוטה קודמת לעיון",
          '<p class="notice">הרשומה עודכנה מאז. אלה הפרטים מהטיוטה הקודמת; לעריכה פתח את הרשומה העדכנית.</p>' +
            draftDetails(d.fields),
        );
        return;
      }
      const old = await ctx.drafts.load(d.kind);
      if (old) await retainDraft(ctx, d.kind, old);
      await ctx.drafts.save(d.kind, d);
      await ctx.drafts.remove(data.key);
      return ctx.reopen(d.kind, d.recordId);
    }
    case "conflict-draft": {
      const d = await ctx.drafts.load(data.key);
      ctx.dialog(
        "הטיוטה מלפני ההתנגשות",
        `<p>הטיוטה הזאת נשמרה לעיון. אפשר להוריד אותה לפני תיקון החשבונית העדכנית.</p>${draftDetails(d.fields)}<button class="secondary" id="download-draft">הורד טיוטה</button>`,
      );
      $("#download-draft").onclick = () =>
        download(
          JSON.stringify(d, null, 2),
          "invoice-draft.json",
          "application/json",
        ).catch(error => toast(errorText(error), true));
      break;
    }
    case "delete":
      if (
        confirm(
          "למחוק את " +
            invoiceLabel(record) +
            " על סך " +
            money(record.finalAgorot) +
            "? היא תעבור לסל המחזור עם הצילומים שלה. ניתן לשחזר במשך 30 יום.",
        )
      )
        await simpleMutation("delete", record);
      break;
    case "unpay":
      if (confirm("להחזיר את החשבונית למצב לא שולם?"))
        await simpleMutation("unpay", record);
      break;
  }
}
function draftDetails(fields) {
  const labels = {
    supplierId: "ספק",
    documentNumber: "מספר מסמך",
    invoiceDate: "תאריך חשבונית",
    subtotal: "לפני מע״מ",
    vat: "מע״מ",
    total: "סכום כולל",
    final: "סופי לתשלום",
    notes: "הערות",
    name: "שם הספק",
    contact: "פרטי קשר",
    date: "תאריך",
    cash: "קופה",
    ravKav: "רב־קו",
    method: "אמצעי תשלום",
    paymentDate: "יום התשלום / מסירת הצ׳ק",
    checkNumber: "מספר צ׳ק",
    checkDueDate: "מועד פירעון",
  };
  return `<dl class="details-list">${Object.entries(labels)
    .filter(([k]) => fields[k] !== undefined)
    .map(
      ([k, label]) =>
        `<div><dt>${e(label)}</dt><dd>${e(k === "supplierId" ? ctx.data.suppliers.find((s) => s.id === fields[k])?.name || "ספק" : k === "method" ? methods[fields[k]] : fields[k] || "לא הוזן")}</dd></div>`,
    )
    .join("")}</dl>`;
}
async function simpleMutation(actionName, record) {
  if (ctx.modalBusy) return;
  ctx.setModalBusy(true);
  try {
  const key = "action-" + record.id + "-" + actionName;
  let pending = await ctx.drafts.load(key);
  pending ||= pendingMutation(
    "invoices/" + record.id + (actionName === "delete" ? "" : "/" + actionName),
    null,
    record.version,
    actionName === "delete" ? "DELETE" : "POST",
  );
  await ctx.drafts.save(key, pending);
  try {
    const r = await ctx.api.save(pending);
    ctx.mergeRecord(r.record, pending.path);
    await ctx.drafts.remove(key);
    ctx.closeModal();
    ctx.render();
    toast(actionName === "delete" ? "החשבונית הועברה לסל המחזור · ניתן לשחזר במשך 30 יום" : actionName === "restore" ? "החשבונית שוחזרה עם הצילומים ופרטי התשלום" : "עודכן בחנות");
  } catch (err) {
    if (err.status && err.status < 500 && ![429, 408].includes(err.status))
      await ctx.drafts.remove(key);
    throw err;
  }
  } finally { ctx.setModalBusy(false); }
}
function detail(i) {
  const supplier = ctx.data.suppliers.find((s) => s.id === i.supplierId);
  const root = ctx.dialog("פרטי החשבונית", invoiceDetails(i, supplier, { retentionDays: ctx.retentionDays }));
  root.classList.add("invoice-detail-modal");
  const api = ctx.api;
  ctx.disposeModal = mountInvoicePhoto(root, i, {
    load: id => api.request("documents/" + id, { blob: true, timeout: 50_000 }),
    preview: ctx.previewBlob,
    isCurrent: () => ctx.api === api,
  });
  root.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-detail-action]");
    if (!b) return;
    b.disabled = true;
    try {
      await action(b.dataset.detailAction, { id: i.id });
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      b.disabled = false;
    }
  });
}
// Always re-read the invoice: a photo deleted from this screen changes it.
function documentList(invoiceId) {
  const i = ctx.data.invoices.find(invoice => invoice.id === invoiceId);
  if (!i) return;
  const supplier = ctx.data.suppliers.find(s => s.id === i.supplierId);
  const files = i.attachmentIds || [];
  const root = ctx.dialog("צילומי החשבונית",
    `<p>${e(supplier?.name || "ספק")} · ${e(displayDate(i.invoiceDate))} · ${e(money(i.finalAgorot))}</p><div class="attachment-links">${attachmentRows(i, index => "פתח עמוד / קובץ " + (index + 1))}</div>${files.length ? `<button class="primary" data-share-this-invoice>${icon("share")} שתף חשבונית ב־PDF</button>` : '<p class="notice">לא נשאר צילום בחשבונית הזאת.</p>'}<button class="text-button" data-invoice-details>פרטי החשבונית והתשלום</button>${files.length ? `<details class="document-actions"><summary>פעולות נוספות</summary><div class="invoice-more-actions">${attachmentRemovalRows(i)}</div></details>` : ""}${retentionNote(ctx.retentionDays)}`);
  if (files.length)
    $("[data-share-this-invoice]", root).onclick = () => shareDocuments(ctx, { invoiceId: i.id });
  $("[data-invoice-details]", root).onclick = () => detail(i);
}
function login() {
  codeSession?.clear();
  codeSession = null;
  $("#app").innerHTML =
    `<main class="login-page"><div class="login-card"><span class="brand-mark">ק</span><span class="eyebrow">החנות המשפחתית</span><h1>החשבונות של החנות</h1><p>התחברות עם מספר הטלפון שלך</p><form id="login-form"><label class="field"><span>מספר טלפון</span><input id="phone" type="tel" dir="ltr" placeholder="05…" autocomplete="tel" required></label><div id="recaptcha"></div><div id="otp-fields" hidden><label class="field"><span>הקוד שקיבלת ב־SMS</span><input id="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" dir="ltr"></label></div><p id="login-error" class="form-error" role="alert" hidden></p><button type="submit" class="primary" id="login-button">שלח לי קוד</button><button type="button" class="text-button" id="restart-login" hidden>החלף מספר / בקש קוד חדש</button></form><p class="small muted">במכשיר הזה ההתחברות נשמרת לפעם הבאה.</p></div></main>`;
  $("#restart-login").onclick = () => login();
  $("#login-form").onsubmit = async (ev) => {
    ev.preventDefault();
    if (loginBusy) return;
    loginBusy = true;
    const button = $("#login-button"),
      error = $("#login-error");
    button.disabled = true;
    $("#restart-login").disabled = true;
    error.hidden = true;
    try {
      if (codeSession) {
        await codeSession.confirmation.confirm($("#otp").value);
      } else {
        codeSession = await sendCode(auth, $("#phone").value, "recaptcha");
        $("#phone").readOnly = true;
        $("#otp-fields").hidden = false;
        $("#otp").required = true;
        $("#otp").focus();
        $("#restart-login").hidden = false;
        button.textContent = "התחבר לחנות";
      }
    } catch (err) {
      error.textContent = authMessage(err);
      error.hidden = false;
      $("#restart-login").hidden = false;
    } finally {
      loginBusy = false;
      if (button.isConnected) {
        button.disabled = false;
        $("#restart-login").disabled = false;
      }
    }
  };
}
function accessError(err) {
  $("#app").innerHTML =
    `<main class="login-page"><div class="login-card"><span class="brand-mark">ק</span><h1>הכניסה לא הושלמה</h1><p role="alert">${e(errorText(err))}</p><button class="primary" id="retry-access">נסה שוב</button><button class="text-button" id="logout-denied">צא מהחשבון</button></div></main>`;
  $("#retry-access").onclick = () => window.location.reload();
  $("#logout-denied").onclick = () => signOut(auth);
}
async function startup() {
  try {
    auth = await initializeAuth();
    unsubscribe = onAuthStateChanged(auth, async (user) => {
      ctx.epoch++;
      const epoch = ctx.epoch;
      ctx.api = null;
      ctx.version = 0;
      ctx.lastRefresh = 0;
      ctx.loading = false;
      ctx.syncError = false;
      ctx.draftWarning = "";
      ctx.data = { suppliers: [], invoices: [], dailyCash: [], settings: [] };
      ctx.route = "home"; ctx.filters = {}; ctx.folderPath = {}; ctx.limit = 80;
      routePositions.clear();
      ctx.closeModal();
      $("#modal").innerHTML = "";
      if (!user) {
        ctx.drafts = null;
        ctx.draftNames = [];
        login();
        return;
      }
      try {
        const api = new Api(user);
        const me = await api.request("me");
        if (epoch !== ctx.epoch) return;
        ctx.api = api;
        ctx.drafts = new Drafts(me.uid);
        navigation.reset();
        await ctx.drafts.open();
        await ctx.updateDraftNames();
        ctx.render();
        await ctx.refresh(true);
      } catch (err) {
        if (epoch === ctx.epoch) accessError(err);
      }
    });
  } catch (err) {
    $("#app").innerHTML =
      `<main class="login-page"><div class="login-card"><h1>טעינת המערכת לא הושלמה</h1><p role="alert">${e(errorText(err))}</p><button class="primary" id="retry-startup">נסה שוב</button></div></main>`;
    const button = $("button");
    button.onclick = () => location.reload();
  }
}
$("#modal").addEventListener("cancel", (ev) => {
  if (ctx.modalBusy || ctx.modalBack) {
    ev.preventDefault();
    if (!ctx.modalBusy) ctx.backModal();
  }
});
$("#modal").addEventListener("close", () => {
  if ($("#modal").open) return;
  ctx.disposeModal?.();
  ctx.disposeModal = null;
  $("#modal").replaceChildren();
  void ctx.updateDraftNames().then(() => ctx.render());
});
$("#modal").addEventListener("click", async (ev) => {
  if (ev.target.closest("[data-close-modal]") && !ctx.modalBusy)
    ctx.backModal();
  if (ev.target.closest("[data-modal-home]") && !ctx.modalBusy) {
    ctx.closeModal();
    navigate("home");
  }
  const doc = ev.target.closest("[data-open-document]");
  if (doc) await openDocument(doc);
  const remove = ev.target.closest("[data-delete-document]");
  if (remove) await deletePhoto(remove);
});
// One page of one invoice moves to the recycle bin without changing amounts.
async function deletePhoto(button) {
  if (button.disabled || ctx.modalBusy || !ctx.api) return;
  const invoice = ctx.data.invoices.find(i => i.id === button.dataset.invoice);
  const documentId = button.dataset.deleteDocument;
  if (!invoice || !(invoice.attachmentIds || []).includes(documentId)) return;
  const page = (invoice.attachmentIds || []).length > 1
    ? "צילום עמוד " + button.dataset.page
    : "צילום החשבונית";
  if (!confirm(`להעביר את ${page} של ${invoiceLabel(invoice)} לסל המחזור? אפשר לשחזר במשך 30 יום. פרטי החשבונית והתשלום יישארו.`))
    return;
  const inDetails = Boolean($(".invoice-detail-modal"));
  button.disabled = true;
  ctx.setModalBusy(true);
  // The mutation ID is kept in the encrypted draft, so a retry after a lost
  // answer replays the same deletion instead of removing another page.
  const key = "action-" + invoice.id + "-document-" + documentId;
  let pending = await ctx.drafts.load(key);
  pending ||= pendingMutation(
    "invoices/" + invoice.id + "/documents/" + documentId,
    null,
    invoice.version,
    "DELETE",
  );
  try {
    await ctx.drafts.save(key, pending);
    const r = await ctx.api.save(pending);
    ctx.mergeRecord(r.record, "invoices");
    await ctx.drafts.remove(key);
    ctx.render();
    toast("הצילום הועבר לסל המחזור · ניתן לשחזר במשך 30 יום");
  } catch (err) {
    if (err.status && err.status < 500 && ![429, 408].includes(err.status))
      await ctx.drafts.remove(key);
    toast(errorText(err), true);
  } finally {
    ctx.setModalBusy(false);
    if (button.isConnected) button.disabled = false;
  }
  const fresh = ctx.data.invoices.find(i => i.id === invoice.id);
  if (!fresh) return ctx.closeModal();
  if (inDetails) detail(fresh);
  else documentList(fresh.id);
}
async function restorePhoto(invoice, documentId) {
  ctx.setModalBusy(true);
  const key = "action-" + invoice.id + "-restore-document-" + documentId;
  try {
    const pending = await ctx.drafts.load(key) || pendingMutation(`invoices/${invoice.id}/documents/${documentId}/restore`, null, invoice.version, "POST");
    await ctx.drafts.save(key, pending);
    const result = await ctx.api.save(pending);
    ctx.mergeRecord(result.record, "invoices");
    await ctx.drafts.remove(key);
    ctx.render();
    toast("הצילום שוחזר לחשבונית");
  } catch (err) {
    if (err.status && err.status < 500 && ![429, 408].includes(err.status)) await ctx.drafts.remove(key);
    throw err;
  } finally { ctx.setModalBusy(false); }
}
async function openDocument(doc) {
  if (doc.disabled || !ctx.api) return;
  const api = ctx.api;
    doc.disabled = true;
    try {
      const blob = await api.request("documents/" + doc.dataset.openDocument, {
          blob: true,
          timeout: 50_000,
        });
      if (doc.isConnected && ctx.api === api) ctx.previewBlob(blob);
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      doc.disabled = false;
    }
}
window.addEventListener("online", () => ctx.refresh(false));
window.addEventListener("offline", () => {
  const status = $("#connection-status");
  if (status) status.textContent = "אין חיבור לרשת";
  toast("אין חיבור לרשת. אפשר להמשיך למלא טיוטה.", true);
});
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    Date.now() - ctx.lastRefresh > 60_000
  )
    ctx.refresh(false);
});
window.addEventListener("beforeunload", (event) => {
  if (ctx.drafts?.pending > 0 || ctx.modalBusy) {
    event.preventDefault();
    event.returnValue = "";
  }
});
if (!window.ksaUnsupportedBrowser) startup();
