import { parseMoney, moneyInput } from "./format.js";

export function vatFromInclusive(totalAgorot, basisPoints) {
  if (!Number.isSafeInteger(totalAgorot) || !Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000)
    throw Error("יש לבדוק את הסכום ואת שיעור המע״מ.");
  const n = BigInt(Math.abs(totalAgorot)), divisor = BigInt(10000 + basisPoints);
  const vat = Number((n * BigInt(basisPoints) + divisor / 2n) / divisor);
  return { vatAgorot: vat, subtotalAgorot: Math.abs(totalAgorot) - vat };
}
export const amountOrNull = value => { try { return parseMoney(value, true); } catch { return null; } };
// The identity every printed invoice satisfies is subtotal + VAT + rounding =
// total. A supplier may fold the rounding into the VAT base (Mr. ICE) or add it
// after the VAT (Tnuva); either way it belongs on this side of the equation, and
// leaving it out puts the derived pre-VAT figure a few agorot off.
export function roundingAgorot(fields) {
  const printed = fields.deductions
    .filter(d => d.included === "yes" && /עיגול|\brounding\b/iu.test(d.label || ""))
    .reduce((sum, d) => sum + (amountOrNull(d.amount) || 0), 0);
  return fields.documentType === "credit" ? -printed : printed;
}
export function validInvoiceDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && value >= "1900-01-01" && value <= "2200-12-31" &&
    !Number.isNaN(Date.parse(value)) && new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;
}
// Typed from the paper, an invoice is the same few details in the same order
// every time, so the form is a habit rather than a puzzle. A step stays until
// it is answered: a value the form arrived with, today's date, is confirmed
// rather than assumed. The document type is not asked; it is an invoice unless
// changed on the summary, where a credit note is the rare exception. Neither is
// the document number: it is the slowest thing to type and it is already on the
// paper and its photograph, so it is offered on the summary for the invoices
// that need it, and left empty otherwise.
export const typedSteps = ["supplierName", "totalAgorot", "vatAgorot", "invoiceDate"];
export function invoiceQuestions(draft) {
  const f = draft.fields, confirmed = draft.quick?.confirmed || {};
  const questions = [];
  for (const key of typedSteps)
    if (key === "supplierName" ? !f.supplierId || draft.supplierConflict : !confirmed[key]) questions.push(key);
  f.deductions.forEach((d, i) => {
    if (!d.label?.trim() || amountOrNull(d.amount) === null || d.included === "unknown") questions.push("deduction:" + i);
  });
  const expected = expectedFinal(draft);
  const actualFinal = amountOrNull(f.final);
  if (expected !== null && actualFinal !== null && (f.documentType === "credit" ? -Math.abs(actualFinal) : actualFinal) !== expected && !confirmed.finalArithmetic)
    questions.push("finalArithmetic");
  const subtotal = amountOrNull(f.subtotal), vat = amountOrNull(f.vat), total = amountOrNull(f.total);
  if (subtotal !== null && vat !== null && total !== null && Math.abs(subtotal) + Math.abs(vat) + roundingAgorot(f) !== Math.abs(total) && !confirmed.arithmetic)
    questions.push("arithmetic");
  return questions;
}
export function deriveMissingAmounts(draft) {
  const f = draft.fields, total = amountOrNull(f.total), vat = amountOrNull(f.vat);
  if (total === null) return;
  const rounding = roundingAgorot(f);
  if (amountOrNull(f.subtotal) === null && vat !== null && Math.abs(vat) + rounding <= Math.abs(total) && !draft.quick?.confirmed?.subtotalAgorot) {
    f.subtotal = moneyInput(Math.abs(total) - Math.abs(vat) - rounding);
    if (draft.quick) draft.quick.confirmed.subtotalAgorot = true;
  }
  if ((amountOrNull(f.final) === null || draft.quick?.finalDerived) && f.deductions.every(d => d.included !== "unknown" && amountOrNull(d.amount) !== null)) {
    const sign = f.documentType === "credit" ? -1 : 1;
    const final = sign * Math.abs(total) - f.deductions.filter(d => d.included === "no").reduce((s, d) => s + parseMoney(d.amount), 0);
    f.final = moneyInput(sign === -1 ? Math.abs(final) : final);
    if (draft.quick) {
      draft.quick.finalDerived = true;
      draft.quick.confirmed.finalAgorot = true;
      if (draft.quick.paymentBaseFinal !== undefined || draft.quick.paymentReduction) {
        const withoutPayment = sign * Math.abs(total) - f.deductions.filter(d => d.included === "no" && !d.paymentOnly).reduce((s, d) => s + parseMoney(d.amount), 0);
        draft.quick.paymentBaseFinal = moneyInput(sign === -1 ? Math.abs(withoutPayment) : withoutPayment);
      }
    }
  }
}

export function expectedFinal(draft) {
  const f = draft.fields, total = amountOrNull(f.total);
  if (total === null || f.deductions.some(d => d.included === "unknown" || amountOrNull(d.amount) === null)) return null;
  return (f.documentType === "credit" ? -Math.abs(total) : total) - f.deductions.filter(d => d.included === "no").reduce((s, d) => s + parseMoney(d.amount), 0);
}
