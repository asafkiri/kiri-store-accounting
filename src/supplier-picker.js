import { field, select, errorText } from "./ui.js";
import { escapeHtml as e } from "./format.js";
import { normalizeSupplierName } from "./supplier-name.js";

// The identifier printed on the document binds a supplier on its own, because
// two suppliers can never hold the same one: "תנובה קפואים" is printed as
// ד.מ.ד שיווק and shares no word with the name it is filed under, so no name
// route could ever reach it. A name match stays a proposal the picker asks
// about, exactly as before — the name is the signal this change exists to stop
// relying on. Several holders mean the document is ambiguous, so it asks too.
export function matchSupplier(suppliers, scan) {
  const available = suppliers.filter((s) => !s.deletedAt && s.active);
  const printed = scan?.supplierTaxIds || [];
  const holders = printed.length
    ? available.filter((s) => (s.taxIds || []).some((id) => printed.includes(id)))
    : [];
  if (holders.length) return holders.length === 1 ? holders[0] : null;
  // With no identifier bound yet the name still binds an identical spelling, as
  // it always did, and a merely normalized match stays a proposal the picker
  // asks about. Confirming it is what attaches the identifier, so this fallback
  // is needed once per supplier and then the number takes over.
  if (scan?.uncertainFields?.includes("supplierName")) return null;
  return available.find((s) => s.name === scan?.supplierName) || null;
}

export function supplierPickerMarkup(fields, uncertain, read) {
  return `<section class="supplier-picker wide" data-supplier-picker aria-label="בחירת ספק">
    ${field("שם ספק לחיפוש או פתיחה", "supplierName", fields.supplierName, { wide: true, uncertain, read })}
    ${uncertain ? '<p class="read-value">דורש בדיקה — הקלד את שם הספק שמופיע בתעודה.</p>' : ""}
    <div data-supplier-proposal aria-live="polite"></div>
    <details><summary>בחירה מרשימת הספקים</summary>${select("ספק", "supplierId", "", { "": "בחר ספק" }, { wide: true, uncertain })}</details>
  </section>`;
}

export function bindSupplierPicker(ctx, form, draft, { collect, persist, onSelect }) {
  const root = form.querySelector("[data-supplier-picker]");
  const input = form.elements.supplierName;
  const selected = form.elements.supplierId;
  const proposal = root.querySelector("[data-supplier-proposal]");
  input.maxLength = 160;
  let rejected = false;
  let lookupError = "";
  const available = () => ctx.data.suppliers.filter((s) => !s.deletedAt || (draft.mode === "edit" && s.id === draft.fields.supplierId));
  const matches = () =>
    available().filter(
      (s) =>
        normalizeSupplierName(s.name) === normalizeSupplierName(input.value),
    );
  const button = (action, label, id = "", secondary = false) =>
    `<button type="button" class="${secondary ? "secondary" : "primary"}" data-supplier-action="${action}" data-supplier-id="${e(id)}" ${draft.pending ? "disabled" : ""}>${e(label)}</button>`;
  const persistChoice = () => {
    draft.fields = collect();
    persist();
  };
  const clearChoice = () => {
    selected.value = "";
    delete draft.newSupplier;
    delete draft.reactivateSupplier;
    delete draft.bindSupplierId;
    renderOptions("");
  };
  const renderOptions = (id = selected.value) => {
    const rows = [...available()];
    if (draft.newSupplier) rows.push({ ...draft.newSupplier, active: true });
    selected.innerHTML =
      '<option value="">בחר ספק</option>' +
      rows
        .map(
          (s) =>
            `<option value="${e(s.id)}">${e(s.name)}${s.active ? "" : " — לא פעיל"}</option>`,
        )
        .join("");
    selected.value = id;
  };
  const render = () => {
    const name = input.value.trim();
    if (draft.newSupplier) {
      proposal.innerHTML = `<p><strong>ספק חדש: ${e(draft.newSupplier.name)}</strong></p><p>הספק ייפתח יחד עם החשבונית בלחיצה על ״שמור חשבונית״.</p>`;
    } else if (draft.reactivateSupplier) {
      proposal.innerHTML = `<p><strong>הספק יופעל מחדש עם שמירת החשבונית.</strong></p>`;
    } else if (selected.value) {
      const supplier = available().find((s) => s.id === selected.value);
      proposal.innerHTML = `<p><strong>התעודה תשויך לספק: ${e(supplier?.name || name)}</strong></p>`;
    } else if (draft.supplierConflict && lookupError) {
      proposal.innerHTML = `<p>${e(lookupError)}</p>${button("lookup", "טען את הספק הקיים")}`;
    } else if (!name) {
      proposal.innerHTML = "<p>הקלד שם ספק או בחר מהרשימה.</p>";
    } else {
      const forced = available().find(
        (s) => s.id === draft.supplierConflict?.id,
      );
      const candidates = forced ? [forced] : matches();
      if (candidates.length) {
        proposal.innerHTML =
          candidates
            .map((s) =>
              s.active
                ? `<p>זה הספק '${e(s.name)}' שכבר קיים?</p>${button("confirm", "כן, שייך לספק הזה", s.id)}`
                : `<p>הספק '${e(s.name)}' סומן כלא פעיל. להפעיל אותו מחדש?</p>${button("reactivate", "הפעל מחדש ושייך את התעודה", s.id)}`,
            )
            .join("") +
          button("reject", "לא — פתח ספק חדש", "", true) +
          (rejected
            ? "<p>כדי לפתוח ספק אחר, הקלד שם שמבדיל אותו מהספק הקיים.</p>"
            : "");
      } else {
        proposal.innerHTML = `<p><strong>ספק חדש: ${e(name)}</strong></p>${button("create", "פתח ספק חדש ושייך את התעודה")}`;
      }
    }
  };
  renderOptions(draft.fields.supplierId);
  render();
  input.addEventListener("input", () => {
    if (draft.pending) return;
    clearChoice();
    delete draft.supplierConflict;
    rejected = false;
    lookupError = "";
    const exact = available().filter(
      (s) => s.active && s.name === input.value.trim(),
    );
    if (exact.length === 1) selected.value = exact[0].id;
    render();
    persistChoice();
  });
  const selectExisting = () => {
    if (draft.pending) return;
    const supplier = available().find((s) => s.id === selected.value);
    delete draft.newSupplier;
    delete draft.reactivateSupplier;
    delete draft.supplierConflict;
    // Picking from the list is a manual override, not a confirmation of what
    // this document printed, so it never attaches the document's identifier.
    delete draft.bindSupplierId;
    if (supplier) {
      input.value = supplier.name;
    }
    renderOptions(supplier?.active ? supplier.id : "");
    render();
    persistChoice();
  };
  selected.addEventListener("change", selectExisting);
  selected.addEventListener("input", selectExisting);

  const recover = async (error) => {
    const id = error?.details?.supplierId || draft.supplierConflict?.id;
    if (!id || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) return;
    clearChoice();
    draft.supplierConflict = { id };
    try {
      const existing = await ctx.api.request("suppliers/" + id);
      if (!form.isConnected || draft.supplierConflict?.id !== id) return;
      if (existing.deletedAt)
        throw Error("הספק נמחק בינתיים. אפשר לתקן את השם או לבחור ספק אחר.");
      ctx.mergeRecord(existing, "suppliers/" + id);
      lookupError = "";
      renderOptions("");
    } catch (err) {
      if (!form.isConnected || draft.supplierConflict?.id !== id) return;
      lookupError = errorText(err);
    }
    render();
    persistChoice();
  };
  proposal.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-supplier-action]");
    if (!action || draft.pending || action.disabled) return;
    const name = input.value.trim();
    if (action.dataset.supplierAction === "lookup") {
      action.disabled = true;
      await recover();
      return;
    }
    if (action.dataset.supplierAction === "reject") {
      rejected = true;
      render();
      input.focus();
      return;
    }
    if (action.dataset.supplierAction === "create") {
      if (
        !name ||
        !normalizeSupplierName(name) ||
        matches().length ||
        draft.supplierConflict
      )
        return;
      // A supplier opened for this document keeps the identifier printed on it,
      // so every later invoice from it matches on the number instead of the name.
      draft.newSupplier = {
        id: crypto.randomUUID(),
        name,
        taxIds: draft.scan?.result?.supplierTaxIds || [],
      };
      delete draft.reactivateSupplier;
      renderOptions(draft.newSupplier.id);
    } else {
      const supplier = available().find(
        (s) => s.id === action.dataset.supplierId,
      );
      if (!supplier) return;
      clearChoice();
      delete draft.supplierConflict;
      selected.value = supplier.id;
      input.value = supplier.name;
      // Confirming the proposal is the moment the supplier earns the identifier
      // printed here: the next invoice then matches on it, whatever name it
      // carries. Reactivation writes its own supplier change and cannot also.
      if (supplier.active) draft.bindSupplierId = supplier.id;
      else
        draft.reactivateSupplier = {
          id: supplier.id,
          expectedVersion: supplier.version,
        };
    }
    render();
    persistChoice();
  });
  if (draft.supplierConflict && !draft.pending) recover();
  proposal.addEventListener("click", event => {
    const action = event.target.closest("[data-supplier-action]");
    if (action && ["create", "confirm", "reactivate"].includes(action.dataset.supplierAction) && selected.value) onSelect?.();
  });
  return { recover };
}
