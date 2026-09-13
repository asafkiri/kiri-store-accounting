import { escapeHtml as e, money, displayDate, invoiceLabel } from "./format.js";

// One supplier does not issue two documents on the same date, for the same
// total, with the same VAT: that is one invoice entered twice. It is what
// guards the intake now that the number is no longer asked for, and the device
// holds every invoice ever saved, so an invoice typed long before this guard
// existed is recognised here too. The store makes the same claim durably.
export const sameInvoice = (a, b) =>
  a.supplierId === b.supplierId &&
  a.documentType === b.documentType &&
  a.invoiceDate === b.invoiceDate &&
  a.totalAgorot === b.totalAgorot &&
  (a.vatAgorot ?? null) === (b.vatAgorot ?? null);

export function findDuplicateInvoice(invoices, candidate, selfId = null) {
  if (
    !candidate?.supplierId ||
    !candidate.invoiceDate ||
    !Number.isFinite(candidate.totalAgorot)
  )
    return null;
  return (
    (invoices || []).find(
      (i) => !i.deletedAt && i.id !== selfId && sameInvoice(i, candidate),
    ) || null
  );
}

// The store refuses the same details even when this device has not seen the
// invoice holding them — another device typed it, or this one is behind — so a
// refusal names an invoice that may not be here to describe.
export const duplicateShown = (
  invoices,
  candidate,
  selfId = null,
  conflictId = null,
) =>
  findDuplicateInvoice(invoices, candidate, selfId) ||
  (conflictId
    ? (invoices || []).find((i) => i.id === conflictId) || { id: conflictId }
    : null);

export function duplicateNotice(
  existing,
  { supplierName = "", allowed = false } = {},
) {
  if (!existing) return "";
  const details = [
    supplierName,
    existing.invoiceDate ? displayDate(existing.invoiceDate) : "",
    Number.isFinite(existing.totalAgorot) ? money(existing.totalAgorot) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (allowed)
    return `<p class="notice" data-duplicate-notice>נשמרת כחשבונית נפרדת, למרות הפרטים הזהים.</p>`;
  return `<div class="notice warning wide" data-duplicate-notice role="alert"><strong>כנראה כבר קלטת את החשבונית הזאת.</strong>
    <span>${
      existing.invoiceDate
        ? `כבר נשמרה כאן ${e(invoiceLabel(existing))}${details ? " · " + e(details) : ""}, עם אותו סכום ואותו מע״מ.`
        : "כבר נשמרה חשבונית עם אותם פרטים בדיוק."
    } אם זו אותה חשבונית, אין צורך לשמור אותה שוב.</span>
    <button type="button" class="text-button" data-confirm-duplicate>זו חשבונית אחרת — שמור בכל זאת</button></div>`;
}
