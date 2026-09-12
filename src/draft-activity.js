// A draft is work the user actually started, not a form they merely opened.
export function hasDraftContent(key, draft) {
  if (!draft) return false;
  if (draft.pending || draft.cancelPending || draft.conflict) return true;
  if (key === "scan")
    return Boolean(draft.files?.length || draft.attachmentIds?.length);
  const f = draft.fields || {};
  if (key === "invoice" && draft.mode !== "edit" && !(draft.version > 0) && f.attachmentIds?.length) return true;
  if (draft.initialFields) return JSON.stringify(f) !== JSON.stringify(draft.initialFields);
  if (key === "invoice") return Boolean(f.supplierId || f.supplierName?.trim() || f.documentNumber?.trim() ||
    [f.subtotal, f.vat, f.total, f.final, f.notes].some(v => String(v ?? "").trim()) || f.deductions?.length);
  if (key === "supplier") return Boolean(f.name?.trim() || f.contact?.trim() || f.notes?.trim());
  if (key === "cash") return Boolean(f.cash || f.ravKav || f.notes);
  return Boolean(draft.changed);
}

export async function actionableDraftNames(drafts, data) {
  const names = await drafts.names(), values = new Map();
  for (const key of names) {
    if (!["invoice", "scan", "supplier", "cash", "payment", "preferences"].includes(key)) continue;
    const draft = await drafts.load(key);
    values.set(key, draft);
    if (!hasDraftContent(key, draft)) { await drafts.remove(key); values.set(key, null); continue; }
    if (key === "scan" && draft.attachmentIds?.length && data.invoices.some(i => draft.attachmentIds.every(id => i.attachmentIds?.includes(id)))) {
      await drafts.remove(key); values.set(key, null);
    }
  }
  const invoice = values.get("invoice"), scan = values.get("scan");
  const sameScan = invoice && scan?.attachmentIds?.length && scan.attachmentIds.every(id => invoice.fields?.attachmentIds?.includes(id));
  return names.filter(key => (!values.has(key) || values.get(key)) && !(key === "scan" && sameScan));
}
