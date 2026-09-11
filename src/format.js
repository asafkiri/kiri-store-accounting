import { creditSignIssues } from "./credit.js";
export const money = (value) =>
  value === null || value === undefined
    ? "לא הוזן"
    : new Intl.NumberFormat("he-IL", {
        style: "currency",
        currency: "ILS",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value / 100);
export function moneyInput(value) {
  if (value === null || value === undefined) return "";
  const sign = value < 0 ? "-" : "";
  const n = Math.abs(value);
  return sign + Math.floor(n / 100) + "." + String(n % 100).padStart(2, "0");
}
export function parseMoney(value, nullable = false) {
  let s = String(value ?? "").trim();
  if (s.includes(",")) {
    if (!/^-?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s))
      throw Error(
        "יש להשתמש בנקודה עשרונית, למשל 123.45. פסיק מיועד להפרדת אלפים בלבד.",
      );
    s = s.replace(/,/g, "");
  }
  if (!s && nullable) return null;
  if (!/^-?\d{1,9}(\.\d{1,2})?$/.test(s))
    throw Error("יש להזין סכום תקין, עם עד שתי ספרות אחרי הנקודה.");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const amount = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  const result = Number(s.startsWith("-") ? -amount : amount);
  if (Math.abs(result) > 100_000_000_000) throw Error("הסכום גדול מדי.");
  return result;
}
export function today(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function displayDate(value) {
  if (!value) return "לא הוזן";
  return value.split("-").reverse().join(".");
}
export const methods = {
  cash: "מזומן",
  check: "צ׳ק",
  transfer: "העברה בנקאית",
  card: "כרטיס אשראי",
  other: "אחר",
};
export const types = {
  invoice: "חשבונית",
  credit: "זיכוי",
  delivery: "תעודת משלוח",
  receipt: "קבלה",
};
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function filterInvoices(items, f, suppliers) {
  const names = new Map(suppliers.map((s) => [s.id, s.name]));
  const q = (f.q || "").trim().toLocaleLowerCase("he");
  return items
    .filter(
      (i) =>
        !i.deletedAt &&
        (!f.month || i.invoiceDate.startsWith(f.month)) &&
        (!f.from || i.invoiceDate >= f.from) &&
        (!f.to || i.invoiceDate <= f.to) &&
        (!f.supplierId || i.supplierId === f.supplierId) &&
        (!f.status || i.status === f.status) &&
        (!f.method || i.payment?.method === f.method) &&
        (!q ||
          [names.get(i.supplierId), i.documentNumber, i.notes]
            .join(" ")
            .toLocaleLowerCase("he")
            .includes(q)),
    )
    .sort(
      (a, b) =>
        b.invoiceDate.localeCompare(a.invoiceDate) || b.createdAt - a.createdAt,
    );
}
export function totals(items) {
  const invalidCredits = items.filter((i) => creditSignIssues(i).length).length;
  const sum = (k) =>
    invalidCredits ? null : items.reduce((n, r) => n + (r[k] ?? 0), 0);
  return {
    invalidCredits,
    subtotal: sum("subtotalAgorot"),
    vat: sum("vatAgorot"),
    total: sum("totalAgorot"),
    final: sum("finalAgorot"),
    unknownVat: items.filter((i) => i.vatAgorot === null).length,
    unknownSubtotal: items.filter((i) => i.subtotalAgorot === null).length,
  };
}
export function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  return {
    from: month + "-01",
    to: month + "-" + new Date(Date.UTC(y, m, 0)).getUTCDate(),
  };
}

export function monthLabel(value) {
  if (!/^\d{4}-\d{2}$/.test(value || "")) return "ללא חודש";
  return new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(value + "-01T12:00:00Z"));
}

