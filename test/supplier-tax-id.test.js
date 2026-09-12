import test from "node:test";
import assert from "node:assert/strict";
import { matchSupplier } from "../src/supplier-picker.js";
import { parseTaxIds } from "../src/forms.js";
import {
  deriveMissingAmounts,
  invoiceQuestions,
  roundingAgorot,
} from "../src/quick-invoice-model.js";
import { isValidTaxId, normalizeTaxId } from "../src/tax-id.js";

const suppliers = [
  // Filed under a name the document never prints: its invoices read ד.מ.ד שיווק.
  { id: "frozen", name: "תנובה קפואים", active: true, taxIds: ["783034218"] },
  { id: "dairy", name: "תנובה", active: true, taxIds: ["570000745"] },
  { id: "strauss", name: "שטראוס גרופ", active: true, taxIds: ["520003781"] },
  { id: "frito", name: "שטראוס פריטו לי", active: true, taxIds: ["510909450"] },
  { id: "nameless", name: "ספק ללא מספר", active: true, taxIds: [] },
  { id: "gone", name: "ספק שהוסר", active: true, taxIds: ["511175135"], deletedAt: 1 },
];

test("the printed identifier reaches a supplier no name could have reached", () => {
  assert.equal(
    matchSupplier(suppliers, {
      supplierName: "ד.מ.ד שיווק בע״מ - קו 2",
      supplierTaxIds: ["783034218"],
    })?.id,
    "frozen",
  );
});

test("two companies of one group stay apart once their own numbers are bound", () => {
  // Both invoices print the same ע.מ מאוחד, which the server never returns as a
  // supplier identifier, so only the entity number reaches here.
  assert.equal(
    matchSupplier(suppliers, { supplierTaxIds: ["520003781"] })?.id,
    "strauss",
  );
  assert.equal(
    matchSupplier(suppliers, { supplierTaxIds: ["510909450"] })?.id,
    "frito",
  );
});

test("an unmatched, ambiguous or removed holder declines and leaves the picker to ask", () => {
  assert.equal(matchSupplier(suppliers, { supplierTaxIds: ["999999999"] }), null);
  assert.equal(matchSupplier(suppliers, { supplierTaxIds: ["511175135"] }), null);
  const twins = [
    { id: "a", name: "א", active: true, taxIds: ["520003781"] },
    { id: "b", name: "ב", active: true, taxIds: ["520003781"] },
  ];
  assert.equal(matchSupplier(twins, { supplierTaxIds: ["520003781"] }), null);
});

test("without a bound identifier the previous name behaviour is unchanged", () => {
  assert.equal(
    matchSupplier(suppliers, { supplierName: "ספק ללא מספר" })?.id,
    "nameless",
  );
  // A name that only normalizes alike stays a proposal for the picker.
  assert.equal(matchSupplier(suppliers, { supplierName: "ספק ללא מספר בע״מ" }), null);
  assert.equal(
    matchSupplier(suppliers, {
      supplierName: "ספק ללא מספר",
      uncertainFields: ["supplierName"],
    }),
    null,
  );
  // An identifier nobody holds still falls back to the name, which is how the
  // first invoice from a supplier reaches it and earns it the number.
  assert.equal(
    matchSupplier(suppliers, {
      supplierName: "ספק ללא מספר",
      supplierTaxIds: ["515984300"],
    })?.id,
    "nameless",
  );
});

const draft = (fields) => ({
  fields: { deductions: [], documentType: "invoice", ...fields },
  scan: { result: { subtotalAgorot: null } },
});

test("the derived pre-VAT figure carries the printed rounding line", () => {
  // Tnuva adds its rounding after the VAT, Mr. ICE folds it into the VAT base;
  // both satisfy subtotal + VAT + rounding = total, and dropping the term put
  // the derived figure two and thirty-two agorot out respectively.
  for (const [supplier, total, vat, rounding, expected] of [
    ["תנובה", "1635.50", "249.48", "0.02", "1386.00"],
    ["Mr. ICE", "423.00", "64.53", "0.32", "358.15"],
    ["ללא עיגול", "2226.00", "339.56", null, "1886.44"],
  ]) {
    const d = draft({
      total,
      vat,
      subtotal: "",
      deductions: rounding
        ? [{ label: "הפרש עיגול", amount: rounding, included: "yes" }]
        : [],
    });
    deriveMissingAmounts(d);
    assert.equal(d.fields.subtotal, expected, supplier);
  }
});

test("a printed pre-VAT figure is never overwritten by the derivation", () => {
  const d = draft({ total: "1635.50", vat: "249.48", subtotal: "1386.00" });
  deriveMissingAmounts(d);
  assert.equal(d.fields.subtotal, "1386.00");
});

test("the arithmetic question still fires on a document that does not reconcile", () => {
  // Dubek prints 4561.86 + 821.13 against a total of 5383.00.
  const off = draft({ total: "5383.00", vat: "821.13", subtotal: "4561.86" });
  assert.ok(invoiceQuestions({ ...off, scan: { result: {} } }).includes("arithmetic"));
  const exact = draft({
    total: "1635.50",
    vat: "249.48",
    subtotal: "1386.00",
    deductions: [{ label: "הפרש עיגול", amount: "0.02", included: "yes" }],
  });
  assert.equal(roundingAgorot(exact.fields), 2);
  assert.equal(
    invoiceQuestions({ ...exact, scan: { result: {} } }).includes("arithmetic"),
    false,
  );
});

test("the vendored tax-id module is the one the server validates against", () => {
  assert.equal(normalizeTaxId("69991651"), "069991651");
  assert.ok(isValidTaxId("0570000745"));
  assert.equal(isValidTaxId("89991651"), false);
});

test("an identifier typed by hand is checked before the save leaves", () => {
  assert.deepEqual(parseTaxIds(""), []);
  assert.deepEqual(parseTaxIds("  "), []);
  // Separators, a dropped leading zero and a repeat all normalize to one set.
  assert.deepEqual(
    parseTaxIds("513036434, 58323544  557904679\n513036434"),
    ["513036434", "058323544", "557904679"],
  );
  // The number Mr. ICE prints for the store fails its own check digit.
  assert.throws(() => parseTaxIds("89991651"), /89991651/);
  assert.throws(() => parseTaxIds("513036434, 274076"), /274076/);
});
