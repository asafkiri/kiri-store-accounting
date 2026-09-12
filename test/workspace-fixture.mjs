// Isolated workspace: production UI, fictional data, no Firebase or paid scans.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { today } from "../src/format.js";

export function workspaceFixture() {
  const month = today().slice(0, 7);
  const date = new Date(month + "-15T12:00:00Z");
  date.setUTCMonth(date.getUTCMonth() - 1);
  const previous = date.toISOString().slice(0, 7);
  const suppliers = [
    { id: "supplier-tnuva", name: "תנובה", active: true, version: 1 },
    { id: "supplier-marina", name: "מרינה", active: true, version: 1 },
    { id: "supplier-unused", name: 'המתוקים של שטרית בע״מ', active: true, version: 1 },
  ];
  const invoice = (id, supplierId, invoiceDate, amount, attachmentIds = [], status = "unpaid") => ({
    id, supplierId, invoiceDate, documentNumber: id, documentType: "invoice", subtotalAgorot: amount,
    vatAgorot: 0, totalAgorot: amount, finalAgorot: amount, attachmentIds, deductions: [], status, version: 1,
    ...(status === "paid" ? { payment: { method: "check", paymentDate: invoiceDate, checkNumber: id === "INV-099" ? "00012345" : "908070", checkDueDate: "2026-12-01" } } : {}),
  });
  const data = { full: true, version: 1, settings: [], documentRetentionDays: 365, suppliers, invoices: [
    invoice("INV-101", "supplier-tnuva", month + "-08", 125400, ["a".repeat(64), "b".repeat(64)]),
    invoice("INV-102", "supplier-marina", month + "-05", 46000, ["c".repeat(64)], "paid"),
    invoice("INV-099", "supplier-tnuva", previous + "-20", 94000, ["d".repeat(64)], "paid"),
  ], dailyCash: [
    { id: month + "-08", date: month + "-08", cashAgorot: 542000, ravKavAgorot: 156000, version: 1 },
    { id: previous + "-20", date: previous + "-20", cashAgorot: 30000, ravKavAgorot: 15000, version: 1 },
  ] };
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const path = req.url.split("?")[0];
    if (path === "/phone-preview") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end('<!doctype html><html><body style="margin:0;background:#dce3eb"><iframe title="תצוגת טלפון" src="/" style="display:block;width:390px;height:844px;border:0;margin:auto"></iframe></body></html>');
    }
    if (path === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end('<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace/styles.css"><title>Workspace fixture</title><body><div id="app"></div><dialog id="modal" aria-labelledby="modal-title"></dialog><div id="toast"></div><script type="module" src="/workspace/app.js"></script></body></html>');
    }
    if (path === "/workspace/auth.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end('export const initializeAuth = async () => ({}), onAuthStateChanged = (_auth, fn) => { fn({ getIdToken: async () => "fixture-token" }); return () => {}; }, signOut = async () => {}, sendCode = async () => {}, authMessage = () => "בדיקה";');
    }
    if (/^\/workspace\/[a-z-]+\.(js|css)$/.test(path)) {
      try {
        res.setHeader("Content-Type", path.endsWith("css") ? "text/css" : "text/javascript");
        return res.end(await readFile(new URL("../src/" + path.split("/").at(-1), import.meta.url)));
      } catch { res.statusCode = 404; return res.end(); }
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ path, method: req.method, body });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer fixture-token") { res.statusCode = 401; return res.end("{}"); }
    if (path === "/api/v1/me") return res.end('{"uid":"workspace-fixture"}');
    if (path === "/api/v1/sync") return res.end(JSON.stringify(data));
    if (path.startsWith("/api/v1/documents/")) {
      res.setHeader("Content-Type", "image/png");
      return res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
    }
    if (req.method === "DELETE" && path.startsWith("/api/v1/suppliers/")) {
      const record = suppliers.find(s => s.id === path.split("/").at(-1));
      Object.assign(record, { deletedAt: Date.now(), restoreUntil: Date.now() + 30 * 86400000, active: false, version: record.version + 1 });
      data.version++;
      return res.end(JSON.stringify({ record }));
    }
    if (req.method === "POST" && path.match(/^\/api\/v1\/suppliers\/[^/]+\/restore$/)) {
      const record = suppliers.find(s => s.id === path.split("/").at(-2));
      Object.assign(record, { deletedAt: null, restoreUntil: null, active: true, version: record.version + 1 }); data.version++;
      return res.end(JSON.stringify({ record }));
    }
    if (req.method === "POST" && path === "/api/v1/documents") return res.end(JSON.stringify({ documents: body.files.map(() => ({ id: "f".repeat(64) })) }));
    // One photo, deleted for good: the invoice keeps its details and loses the
    // page, exactly as the service answers.
    const link = path.match(/^\/api\/v1\/invoices\/([^/]+)\/documents\/([a-f0-9]{64})$/);
    if (req.method === "DELETE" && link) {
      const record = data.invoices.find(i => i.id === link[1]);
      Object.assign(record, {
        attachmentIds: record.attachmentIds.filter(id => id !== link[2]),
        version: record.version + 1,
      });
      data.version++;
      return res.end(JSON.stringify({ record, fileDeleted: true, stillUsedBy: null }));
    }
    if (req.method === "PUT" && path.startsWith("/api/v1/invoices/")) {
      const id = path.split("/").at(-1), existing = data.invoices.find(i => i.id === id);
      const record = { ...existing, ...body.data, id, version: (existing?.version || 0) + 1, status: existing?.status || "unpaid" };
      if (existing) data.invoices[data.invoices.indexOf(existing)] = record; else data.invoices.push(record);
      data.version++;
      return res.end(JSON.stringify({ record }));
    }
    if (req.method === "POST" && /^\/api\/v1\/invoices\/[^/]+\/(pay|unpay)$/.test(path)) {
      const record = data.invoices.find(i => i.id === path.split("/").at(-2));
      const pay = path.endsWith("/pay");
      Object.assign(record, { status: pay ? "paid" : "unpaid", payment: pay ? body.payment : null, version: record.version + 1 });
      data.version++;
      return res.end(JSON.stringify({ record }));
    }
    if (req.method === "PUT" && path.startsWith("/api/v1/daily-cash/")) {
      const id = path.split("/").at(-1), old = data.dailyCash.find(r => r.id === id);
      const record = { ...body.data, id, version: (old?.version || 0) + 1 };
      if (old) data.dailyCash[data.dailyCash.indexOf(old)] = record; else data.dailyCash.push(record);
      data.version++;
      return res.end(JSON.stringify({ record }));
    }
    if (req.method === "PUT" && path === "/api/v1/settings/accounting") {
      const record = { ...body.data, id: "accounting", version: 1 }; data.settings = [record]; data.version++;
      return res.end(JSON.stringify({ record }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return { server, data, requests, month, previous };
}
