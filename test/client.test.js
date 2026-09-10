import test from "node:test";
import assert from "node:assert/strict";
import { Api, ApiError, pendingMutation } from "../src/api.js";
import {
  parseMoney,
  moneyInput,
  today,
  filterInvoices,
  totals,
} from "../src/format.js";
import { invoiceCsv, csvCell } from "../src/export.js";
import { normalizePhone, authMessage } from "../src/auth.js";
import { errorText } from "../src/ui.js";
test("ambiguous commas cannot multiply an amount by one hundred", () => {
  for (const s of ["123,45", "1,2", "12,34,567", "1234,567", ",123", "123,"])
    assert.throws(() => parseMoney(s), /נקודה|סכום/);
  assert.equal(parseMoney("1,234,567.89"), 123456789);
});
test("raw browser and startup errors are translated and retain a safe request reference", () => {
  for (const message of [
    "Load failed",
    "Failed to fetch",
    "QuotaExceededError",
  ]) {
    const shown = errorText(
      Object.assign(new Error(message), { requestId: "abcdef12-3456" }),
    );
    assert.match(shown, /[א-ת]/);
    assert.doesNotMatch(
      shown,
      /Load failed|Failed to fetch|QuotaExceededError/,
    );
    assert.match(shown, /abcdef12/);
  }
  assert.equal(
    errorText(new Error("יש להזין סכום תקין.")),
    "יש להזין סכום תקין.",
  );
});
test("exact agorot parsing, roundtrip, credits and empty fields", () => {
  assert.equal(parseMoney("0.10") + parseMoney("0.20"), 30);
  assert.equal(parseMoney("1,234.56"), 123456);
  assert.equal(parseMoney("-123.45"), -12345);
  assert.equal(parseMoney("", true), null);
  assert.equal(moneyInput(-1), "-0.01");
  for (const n of [0, 1, -1, 123456, -99887])
    assert.equal(parseMoney(moneyInput(n)), n);
  for (const bad of ["1.234", "1e3", "12a", "--2", ""])
    assert.throws(() => parseMoney(bad));
});
test("Israeli business date stays correct near UTC midnight and DST", () => {
  assert.equal(today(new Date("2026-09-09T22:30:00Z")), "2026-09-10");
  assert.equal(today(new Date("2026-01-01T22:30:00Z")), "2026-01-02");
});
test("month filtering and unknown VAT reporting do not fabricate zero", () => {
  const rows = [
    {
      id: "1",
      supplierId: "a",
      documentNumber: "123",
      invoiceDate: "2026-09-10",
      status: "unpaid",
      vatAgorot: null,
      subtotalAgorot: null,
      totalAgorot: 123,
      finalAgorot: 123,
      notes: "מיוחד",
    },
    {
      id: "2",
      supplierId: "a",
      documentNumber: "124",
      invoiceDate: "2026-08-31",
      status: "paid",
      vatAgorot: 18,
      subtotalAgorot: 100,
      totalAgorot: 118,
      finalAgorot: 118,
    },
  ];
  const result = filterInvoices(rows, { month: "2026-09", q: "מרינה" }, [
    { id: "a", name: "מרינה" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(totals(result).unknownVat, 1);
  assert.equal(totals(result).total, 123);
});
test("API rejects network loss and server failures; no automatic repeated writes or scans", async () => {
  let count = 0;
  const api = new Api({ getIdToken: async () => "unit-token" }, async () => {
    count++;
    throw Error("network");
  });
  await assert.rejects(
    api.request("scan-invoice", {
      method: "POST",
      body: { jobId: "unit-test" },
    }),
    (e) => e instanceof ApiError && e.code === "NETWORK",
  );
  assert.equal(count, 1);
  const failApi = new Api(
    { getIdToken: async () => "unit-token" },
    async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "FORBIDDEN", message: "אין גישה" } }),
    }),
  );
  await assert.rejects(failApi.request("invoices"), (e) => e.status === 403);
});
test("default browser fetch keeps its Window receiver after SMS authentication", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", function (path, options) {
    // Browser Web IDL rejects Api instances as the receiver; Node fetch does not.
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    requests++;
    assert.equal(path, "/api/v1/me");
    assert.equal(
      options.headers.Authorization,
      "Bearer fictional-browser-token",
    );
    return Promise.resolve({
      ok: true,
      json: async () => ({ authorized: true }),
    });
  });
  const api = new Api({ getIdToken: async () => "fictional-browser-token" });
  assert.deepEqual(await api.request("me"), { authorized: true });
  assert.equal(requests, 1);
});
test("a failed login check does not claim an invoice draft was saved", async () => {
  const api = new Api({ getIdToken: async () => "unit-token" }, async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(api.request("me"), (error) => {
    assert.equal(error.code, "NETWORK");
    assert.doesNotMatch(error.message, /טיוטה/);
    return true;
  });
  await assert.rejects(
    api.request("invoices/test", { method: "PUT", body: {} }),
    (error) => {
      assert.equal(error.code, "NETWORK");
      assert.match(error.message, /טיוטה/);
      return true;
    },
  );
});
test("pending writes reuse mutation identity after ambiguous response and send bearer privately", async () => {
  const bodies = [];
  const api = new Api(
    { getIdToken: async () => "unit-token" },
    async (path, options) => {
      assert.equal(options.headers.Authorization, "Bearer unit-token");
      assert.equal(options.cache, "no-store");
      assert.ok(!path.includes("unit-token"));
      bodies.push(options.body);
      if (bodies.length === 1) throw Error();
      return { ok: true, json: async () => ({ replayed: true }) };
    },
  );
  const p = pendingMutation("invoices/test-invoice", { totalAgorot: 100 }, 0);
  await assert.rejects(api.save(p));
  assert.equal((await api.save(p)).replayed, true);
  assert.equal(bodies[0], bodies[1]);
});
test("CSV quotes formulas, retains business/payment dates and unknown VAT as blank", () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  const csv = invoiceCsv(
    [
      {
        supplierId: "a",
        documentNumber: "123",
        documentType: "invoice",
        invoiceDate: "2026-09-10",
        vatAgorot: null,
        subtotalAgorot: null,
        totalAgorot: 100,
        finalAgorot: 100,
        status: "paid",
        payment: {
          method: "check",
          paymentDate: "2026-09-10",
          checkDueDate: "2026-09-30",
        },
        notes: "",
        deductions: [],
      },
    ],
    [{ id: "a", name: "ספק" }],
  );
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /2026-09-10/);
  assert.match(csv, /2026-09-30/);
  assert.match(csv, /"","","1.00"/);
});
test("phone form normalizes input without embedding an allowlisted phone", () => {
  assert.equal(normalizePhone("050-000-0000"), "+972500000000");
  assert.equal(normalizePhone("058-000-0000"), "+972580000000");
  assert.throws(() => normalizePhone("1"));
});

test("SMS region rejection is explained separately from a disabled Phone provider", () => {
  const region = authMessage({
    code: "auth/operation-not-allowed",
    message:
      "Firebase: SMS unable to be sent until this region enabled by the app developer. (auth/operation-not-allowed).",
  });
  assert.match(region, /מדינה/);
  assert.match(region, /חסומה/);
  assert.doesNotMatch(region, /auth\/|unable to be sent/);
  const provider = authMessage({
    code: "auth/operation-not-allowed",
    message: "Firebase: Error (auth/operation-not-allowed).",
  });
  assert.match(provider, /התחברות בטלפון/);
  assert.doesNotMatch(provider, /מדינה|חסומה/);
});

test("unknown authentication errors do not expose raw diagnostics; local Hebrew validation stays readable", () => {
  const generic = "ההתחברות לא הושלמה. נסה שוב.";
  assert.equal(
    authMessage({
      code: "auth/internal-error",
      message: "private server diagnostic",
    }),
    generic,
  );
  assert.equal(authMessage(new Error("Network failure")), generic);
  assert.equal(authMessage(null), generic);
  assert.equal(
    authMessage(new Error("יש להזין מספר טלפון תקין.")),
    "יש להזין מספר טלפון תקין.",
  );
});
