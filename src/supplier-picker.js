import { field, icon, errorText } from "./ui.js";
import { escapeHtml as e } from "./format.js";
import { normalizeSupplierName } from "./supplier-name.js";

export function supplierPickerMarkup(fields) {
  return `<section class="supplier-picker wide" data-supplier-picker aria-label="בחירת ספק">
    ${field("חיפוש ספק", "supplierName", fields.supplierName, { wide: true, placeholder: "הקלד חלק מהשם" })}
    <input type="hidden" name="supplierId" value="${e(fields.supplierId || "")}">
    <p class="supplier-search-status muted" data-supplier-status role="status" aria-live="polite"></p>
    <ul class="supplier-results" data-supplier-results aria-label="ספקים לבחירה"></ul>
    <div data-supplier-proposal></div>
  </section>`;
}

export function bindSupplierPicker(ctx, form, draft, { collect, persist, onSelect }) {
  const root = form.querySelector("[data-supplier-picker]");
  const input = form.elements.supplierName, selected = form.elements.supplierId;
  const proposal = root.querySelector("[data-supplier-proposal]");
  const list = root.querySelector("[data-supplier-results]"), status = root.querySelector("[data-supplier-status]");
  input.maxLength = 160;
  input.enterKeyHint = "done";
  let lookupError = "";
  const available = () => ctx.data.suppliers.filter(s => !s.deletedAt || (draft.mode === "edit" && s.id === draft.fields.supplierId));
  const exactMatches = () => available().filter(s => normalizeSupplierName(s.name) === normalizeSupplierName(input.value));
  const results = () => {
    const query = normalizeSupplierName(input.value);
    return available().filter(s => !query || normalizeSupplierName(s.name).includes(query) || s.id === draft.supplierConflict?.id)
      .sort((a, b) => Number(!b.deletedAt && b.active) - Number(!a.deletedAt && a.active)
        || Number(!normalizeSupplierName(a.name).startsWith(query)) - Number(!normalizeSupplierName(b.name).startsWith(query))
        || a.name.localeCompare(b.name, "he"));
  };
  const button = (action, label, id = "") =>
    `<button type="button" class="secondary supplier-create" data-supplier-action="${action}" data-supplier-id="${e(id)}" ${draft.pending ? "disabled" : ""}>${action === "create" ? icon("plus") : ""}<span>${e(label)}</span></button>`;
  const persistChoice = () => { draft.fields = collect(); persist(); };
  const clearChoice = () => {
    selected.value = "";
    delete draft.newSupplier;
    delete draft.reactivateSupplier;
  };
  const render = () => {
    const name = input.value.trim(), rows = results();
    if (draft.newSupplier) rows.unshift({ ...draft.newSupplier, active: true, pendingCreation: true });
    status.textContent = rows.length
      ? name ? `${rows.length === 1 ? "ספק אחד מתאים" : rows.length + " ספקים מתאימים"} · לחץ על הספק לבחירה` : `${rows.length} ספקים לבחירה · אפשר לגלול ברשימה`
      : name ? "לא נמצאו ספקים מתאימים" : "אין עדיין ספקים. הקלד שם לפתיחת ספק חדש";
    list.hidden = rows.length === 0;
    list.innerHTML = rows.map(s => {
      const chosen = selected.value === s.id;
      const hint = s.deletedAt ? "ספק שנמחק" : s.pendingCreation ? "ספק חדש · נבחר" : chosen ? "נבחר" : s.active ? "" : "לא פעיל · הפעל מחדש ובחר";
      return `<li><button type="button" class="supplier-result ${chosen ? "is-selected" : ""}" data-supplier-action="${s.pendingCreation ? "keep-new" : s.active ? "confirm" : "reactivate"}" data-supplier-id="${e(s.id)}" aria-pressed="${chosen}" ${draft.pending || s.deletedAt ? "disabled" : ""}><span><strong>${e(s.name)}</strong>${hint ? `<small>${e(hint)}</small>` : ""}</span>${icon(chosen ? "check" : "arrow")}</button></li>`;
    }).join("");
    if (draft.newSupplier) {
      proposal.innerHTML = `<p><strong>ספק חדש: ${e(draft.newSupplier.name)}</strong></p><p class="muted">הספק ייפתח יחד עם החשבונית בלחיצה על ״שמור חשבונית״.</p>`;
    } else if (draft.reactivateSupplier) {
      proposal.innerHTML = "<p>הספק יופעל מחדש עם שמירת החשבונית.</p>";
    } else if (draft.supplierConflict && lookupError) {
      proposal.innerHTML = `<p role="alert">${e(lookupError)}</p>${button("lookup", "טען את הספק הקיים")}`;
    } else if (selected.value) {
      proposal.innerHTML = "";
    } else if (name && normalizeSupplierName(name) && !exactMatches().length && !draft.supplierConflict) {
      proposal.innerHTML = button("create", `פתח ספק חדש: ״${name}״`);
    } else if (name && exactMatches().length) {
      proposal.innerHTML = '<p class="small muted">ספק בשם הזה כבר קיים. לפתיחת ספק אחר, הקלד שם שונה.</p>';
    } else {
      proposal.innerHTML = "";
    }
  };
  render();
  input.addEventListener("input", () => {
    if (draft.pending) return;
    clearChoice();
    delete draft.supplierConflict;
    lookupError = "";
    render();
    list.scrollTop = 0;
    persistChoice();
  });
  const selectExisting = supplier => {
    if (draft.pending || !supplier || supplier.deletedAt) return;
    clearChoice();
    delete draft.supplierConflict;
    selected.value = supplier.id;
    input.value = supplier.name;
    if (!supplier.active) draft.reactivateSupplier = { id: supplier.id, expectedVersion: supplier.version };
    render();
    persistChoice();
    onSelect?.();
  };
  // Keep the retained editor's field binding, while the visible control is a list.
  const fieldSelection = () => selectExisting(available().find(s => s.id === selected.value));
  selected.addEventListener("change", fieldSelection);
  selected.addEventListener("input", fieldSelection);
  input.addEventListener("keydown", event => {
    if (draft.pending || event.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault(); list.querySelector("button:not(:disabled)")?.focus();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const rows = results();
      // Enter can choose one clear existing result; opening or reactivating a
      // supplier always needs the button naming that action.
      if (input.value.trim() && rows.length === 1 && rows[0].active) selectExisting(rows[0]);
    }
  });
  const recover = async error => {
    const id = error?.details?.supplierId || draft.supplierConflict?.id;
    if (!id || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) return;
    clearChoice();
    draft.supplierConflict = { id };
    try {
      const existing = await ctx.api.request("suppliers/" + id);
      if (!form.isConnected || draft.supplierConflict?.id !== id) return;
      if (existing.deletedAt) throw Error("הספק נמחק בינתיים. אפשר לתקן את השם או לבחור ספק אחר.");
      ctx.mergeRecord(existing, "suppliers/" + id);
      lookupError = "";
    } catch (err) {
      if (!form.isConnected || draft.supplierConflict?.id !== id) return;
      lookupError = errorText(err);
    }
    render();
    persistChoice();
  };
  root.addEventListener("click", async event => {
    const action = event.target.closest("[data-supplier-action]");
    if (!action || draft.pending || action.disabled) return;
    if (action.dataset.supplierAction === "lookup") {
      action.disabled = true; await recover(); return;
    }
    if (action.dataset.supplierAction === "keep-new") {
      if (draft.newSupplier?.id === selected.value) onSelect?.();
      return;
    }
    if (action.dataset.supplierAction === "create") {
      const name = input.value.trim();
      if (!name || !normalizeSupplierName(name) || exactMatches().length || draft.supplierConflict) return;
      draft.newSupplier = { id: crypto.randomUUID(), name, taxIds: [] };
      delete draft.reactivateSupplier;
      selected.value = draft.newSupplier.id;
      render(); persistChoice(); onSelect?.();
    } else {
      selectExisting(available().find(s => s.id === action.dataset.supplierId));
    }
  });
  if (draft.supplierConflict && !draft.pending) recover();
  return { recover };
}
