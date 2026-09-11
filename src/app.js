import { previewDocument } from "./preview.js";
import {
  initializeAuth,
  onAuthStateChanged,
  signOut,
  sendCode,
  authMessage,
} from "./auth.js";
import { Api, pendingMutation } from "./api.js";
import { Drafts } from "./drafts.js";
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
} from "./format.js";
import { shell } from "./views.js";
import {
  supplierForm,
  invoiceForm,
  paymentForm,
  cashForm,
  retainDraft,
} from "./forms.js";
import { scanDialog } from "./scan.js";
import { invoiceCsv, cashCsv, download } from "./export.js";
const ctx = {
  route: "invoices",
  filters: { status: "unpaid" },
  limit: 80,
  data: { suppliers: [], invoices: [], dailyCash: [] },
  version: 0,
  lastRefresh: 0,
  loading: false,
  modalBusy: false,
  draftNames: [],
  epoch: 0,
};
let auth,
  unsubscribe,
  codeSession,
  loginBusy = false;
ctx.dialog = (title, body) => {
  const modal = $("#modal");
  modal.innerHTML = `<div class="modal-content"><header class="modal-heading"><h2 id="modal-title">${e(title)}</h2><button class="icon-button" data-close-modal aria-label="סגור">${icon("close")}</button></header>${body}</div>`;
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
  const b = $("[data-close-modal]");
  if (b) b.disabled = value;
};
ctx.closeModal = () => {
  $("#modal").close();
  ctx.modalBusy = false;
  ctx.updateDraftNames();
};
ctx.previewBlob = previewDocument;
ctx.updateDraftNames = async () => {
  const drafts = ctx.drafts;
  if (!drafts) return;
  try {
    const names = await drafts.names();
    if (ctx.drafts === drafts) ctx.draftNames = names;
  } catch {
    if (ctx.drafts === drafts) ctx.draftWarning = "הנתונים בחנות זמינים, אך הטיוטות במכשיר אינן זמינות כרגע.";
  }
};
ctx.mergeRecord = (record, path) => {
  const collection = path.startsWith("suppliers")
    ? "suppliers"
    : path.startsWith("daily-cash")
      ? "dailyCash"
      : "invoices";
  const index = ctx.data[collection].findIndex((r) => r.id === record.id);
  if (index < 0) ctx.data[collection].push(record);
  else if (record.version >= ctx.data[collection][index].version)
    ctx.data[collection][index] = record;
};
ctx.render = () => {
  if (!ctx.api) return;
  $("#app").innerHTML = shell(ctx);
  bindShell();
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
    if (!r.unchanged) {
      for (const collection of ["suppliers", "invoices", "dailyCash"]) {
        if (r.full) ctx.data[collection] = r[collection];
        else
          for (const item of r[collection])
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
      ctx.data = { suppliers: [], invoices: [], dailyCash: [] };
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
  const record = ctx.data.invoices.find((i) => i.id === id);
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
function navigate(route) {
  ctx.route = route;
  ctx.limit = 80;
  ctx.filters =
    route === "invoices"
      ? { status: "unpaid" }
      : ["cash", "reports"].includes(route)
        ? { month: today().slice(0, 7) }
        : {};
  ctx.render();
  window.scrollTo(0, 0);
}
function bindShell() {
  const root = $("#app");
  root.onclick = async (ev) => {
    const nav = ev.target.closest("[data-route]");
    if (nav) {
      navigate(nav.dataset.route);
      return;
    }
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
      ctx.filters[el.name] = el.value;
      if (el.name === "month") {
        ctx.filters.from = "";
        ctx.filters.to = "";
      }
      if (el.name === "from" || el.name === "to") ctx.filters.month = "";
      ctx.limit = 80;
      ctx.render();
    };
  const search = $("#invoice-search") || $("#supplier-search");
  if (search)
    search.oninput = () => {
      ctx.filters.q = search.value;
      const pos = search.selectionStart;
      ctx.render();
      const next = $("#" + search.id);
      next?.focus();
      next?.setSelectionRange(pos, pos);
    };
  const active = $("#active-only");
  if (active)
    active.onchange = () => {
      ctx.filters.activeOnly = active.checked;
      ctx.render();
    };
}
async function action(type, data = {}) {
  const record = ctx.data.invoices.find((i) => i.id === data.id);
  switch (type) {
    case "invoice":
      return invoiceForm(ctx);
    case "scan":
      return scanDialog(ctx);
    case "report-scan":
      return scanDialog(ctx, "report");
    case "supplier":
      return supplierForm(ctx);
    case "supplier-edit":
      return supplierForm(
        ctx,
        ctx.data.suppliers.find((s) => s.id === data.id),
      );
    case "cash":
      return cashForm(
        ctx,
        ctx.data.dailyCash.find((r) => r.date === today()),
      );
    case "cash-edit":
      return cashForm(
        ctx,
        ctx.data.dailyCash.find((r) => r.id === data.id),
      );
    case "pay":
      return paymentForm(ctx, record);
    case "detail":
      return detail(record);
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
    case "clear-filters":
      ctx.filters =
        ctx.route === "invoices" ? { status: ctx.filters.status } : {};
      ctx.render();
      break;
    case "supplier-invoices":
      navigate("invoices");
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
      if (data.key === "scan" || data.key === "reportScan")
        return scanDialog(ctx, data.key === "scan" ? "invoice" : "report");
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
          "למחוק את חשבונית " +
            record.documentNumber +
            " על סך " +
            money(record.finalAgorot) +
            "? היא תוסר מהרשימות הפעילות.",
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
    toast("עודכן בחנות");
  } catch (err) {
    if (err.status && err.status < 500 && ![429, 408].includes(err.status))
      await ctx.drafts.remove(key);
    throw err;
  }
}
function detail(i) {
  const supplier = ctx.data.suppliers.find((s) => s.id === i.supplierId);
  const rows = [
    ["ספק", supplier?.name],
    ["סוג", types[i.documentType]],
    ["מספר מסמך", i.documentNumber],
    ["תאריך החשבונית", displayDate(i.invoiceDate)],
    ["לפני מע״מ", money(i.subtotalAgorot)],
    ["מע״מ", money(i.vatAgorot)],
    ["כולל מע״מ", money(i.totalAgorot)],
    ["סופי לתשלום", money(i.finalAgorot)],
    ["מצב", i.status === "paid" ? "שולם" : "לא שולם"],
  ];
  if (i.payment)
    rows.push(
      ["אמצעי תשלום", methods[i.payment.method]],
      ["תאריך תשלום / מסירת צ׳ק", displayDate(i.payment.paymentDate)],
      ...(i.payment.method === "check"
        ? [
            ["מספר צ׳ק", i.payment.checkNumber || "לא הוזן"],
            ["תאריך פירעון צ׳ק", displayDate(i.payment.checkDueDate)],
          ]
        : []),
    );
  const root = ctx.dialog(
    "חשבונית " + i.documentNumber,
    `<dl class="details-list">${rows.map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join("")}</dl>${i.deductions.length ? `<h3>הפחתות וניכויים</h3>${i.deductions.map((d) => `<p>${e(d.label)} · ${e(money(d.amountAgorot))} · ${d.includedInTotal ? "כלולה בסכום" : "נוספת"}</p>`).join("")}` : ""}${i.notes ? `<div class="notice">${e(i.notes)}</div>` : ""}${i.payment?.notes ? `<p>הערה לתשלום: ${e(i.payment.notes)}</p>` : ""}<div class="attachment-links">${i.attachmentIds.map((id, n) => `<button class="secondary" data-open-document="${e(id)}">פתח מסמך ${n + 1}</button>`).join("")}</div><div class="row-actions"><button class="primary" data-detail-action="pay">${i.status === "paid" ? "ערוך תשלום" : "סמן כשולם"}</button><button class="secondary" data-detail-action="edit">ערוך חשבונית</button>${i.status === "paid" ? '<button class="text-button" data-detail-action="unpay">החזר ללא שולם</button>' : ""}<button class="text-button danger" data-detail-action="delete">מחק חשבונית</button></div>`,
  );
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
      ctx.data = { suppliers: [], invoices: [], dailyCash: [] };
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
  if (ctx.modalBusy) ev.preventDefault();
});
$("#modal").addEventListener("click", async (ev) => {
  if (ev.target.closest("[data-close-modal]") && !ctx.modalBusy)
    ctx.closeModal();
  const doc = ev.target.closest("[data-open-document]");
  if (doc) {
    doc.disabled = true;
    try {
      ctx.previewBlob(
        await ctx.api.request("documents/" + doc.dataset.openDocument, {
          blob: true,
          timeout: 50_000,
        }),
      );
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      doc.disabled = false;
    }
  }
});
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
