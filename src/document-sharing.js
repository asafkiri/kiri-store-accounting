import { $, icon, errorText } from "./ui.js";
import { escapeHtml as e, monthLabel, displayDate, money, moneyInput } from "./format.js";
import { download, canShareFiles, shareFiles } from "./export.js";

export const SHARE_BATCH_BYTES = 18 * 1024 * 1024;
export const SHARE_BATCH_FILES = 20;
const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const safeName = value => String(value || "מסמך").normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "-").replace(/^\.+|\.+$/g, "").trim().slice(0, 70) || "מסמך";

// The selection comes from saved invoices, never from the current search,
// status filter or pagination. Keep a shared attachment under each invoice.
export function sharingManifest(data, { month, invoiceId }) {
  if (!invoiceId && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) return { invoices: [], entries: [], pdfEntries: [] };
  const names = new Map(data.suppliers.map(s => [s.id, s.name]));
  const saved = data.invoices.filter(i => !i.deletedAt)
    .sort((a, b) => (names.get(a.supplierId) || "").localeCompare(names.get(b.supplierId) || "", "he") || a.invoiceDate.localeCompare(b.invoiceDate) || a.id.localeCompare(b.id));
  const used = new Map(), fileNames = new Map();
  for (const i of saved) {
    // Use the amount printed on the invoice, before payment deductions. Number
    // suffixes only disambiguate identical filenames, never invoice numbers.
    const amount = moneyInput(i.totalAgorot ?? i.finalAgorot) || "ללא-סכום";
    const base = `${safeName(names.get(i.supplierId) || "ספק")}_${safeName(i.invoiceDate)}_${amount}ILS`;
    const count = (used.get(base) || 0) + 1; used.set(base, count);
    fileNames.set(i.id, base + (count > 1 ? ` (${count})` : ""));
  }
  const invoices = saved.filter(i => invoiceId ? i.id === invoiceId : i.invoiceDate?.slice(0, 7) === month);
  const pdfEntries = invoices.filter(i => i.attachmentIds?.length).map(i => ({
    id: i.id, attachmentIds: [...new Set(i.attachmentIds)], name: fileNames.get(i.id),
    path: `${safeName(names.get(i.supplierId) || "ספק")}/${fileNames.get(i.id)}`,
    label: `${names.get(i.supplierId) || "ספק"} · ${displayDate(i.invoiceDate)} · ${money(i.totalAgorot ?? i.finalAgorot)}`,
  }));
  const entries = pdfEntries.flatMap(i => i.attachmentIds.map((id, page) => ({
    id, label: `${i.label} · קובץ ${page + 1}`, name: `${i.name}_עמוד-${page + 1}`, path: `${i.path}/${page + 1}`,
  })));
  return { invoices, entries, pdfEntries };
}

// ZIP STORE preserves the original images/PDF bytes and needs no compression
// library. The caller supplies one bounded batch, never the entire month.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export async function documentZip(entries) {
  const parts = [], directory = []; let offset = 0;
  for (const entry of entries) {
    const bytes = new Uint8Array(await entry.blob.arrayBuffer()), name = new TextEncoder().encode(entry.path);
    let crc = 0xffffffff; for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint16(12, 33, true); h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true);
    h.setUint32(22, bytes.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
    parts.push(header, entry.blob);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, 0x800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true);
    c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true); central.set(name, 46); directory.push(central);
    offset += header.length + bytes.length;
  }
  const end = new Uint8Array(22), v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
  v.setUint32(12, directory.reduce((n, b) => n + b.length, 0), true); v.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}

export class DocumentShareBatch {
  constructor(entries, load, { maxBytes = SHARE_BATCH_BYTES, maxFiles = SHARE_BATCH_FILES, maxFileBytes = SHARE_BATCH_BYTES } = {}) {
    Object.assign(this, { entries, load, maxBytes, maxFiles, maxFileBytes, cursor: 0, files: [], bytes: 0, carry: null });
  }
  async prepare(progress = () => {}, active = () => true) {
    while (this.cursor < this.entries.length && this.files.length < this.maxFiles && this.bytes < this.maxBytes && active()) {
      const entry = this.entries[this.cursor];
      const blob = this.carry || await this.load(entry.id, entry, active);
      if (!active()) return;
      if (!extensions[blob.type] || !blob.size) throw Error("אחד הקבצים אינו צילום או PDF תקין. פתח את החשבונית ובדוק את הקובץ.");
      // An invoice PDF may exceed a regular batch. Offer it alone, intact,
      // subject to a separate bound; never split an invoice across files.
      if (blob.size > this.maxFileBytes) throw Error("הקובץ גדול מדי לשיתוף. אפשר לפתוח אותו בנפרד או לשתף את הקבצים המקוריים.");
      if (this.files.length && this.bytes + blob.size > this.maxBytes) { this.carry = blob; break; }
      const ext = extensions[blob.type];
      this.files.push({ ...entry, blob, path: entry.path + "." + ext, file: new File([blob], entry.name + "." + ext, { type: blob.type }) });
      this.carry = null; this.bytes += blob.size; this.cursor++; progress(this.cursor);
    }
  }
  next() { this.files = []; this.bytes = 0; }
  clear() { this.next(); this.carry = null; }
}

export function shareDocuments(ctx, selection) {
  const manifest = sharingManifest(ctx.data, selection), api = ctx.api;
  const { invoices } = manifest;
  const title = selection.month ? "שליחת חשבוניות " + monthLabel(selection.month) : "שליחת החשבונית";
  const dialog = document.createElement("dialog"); dialog.className = "preview-dialog";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<div class="share-dialog"><div class="preview-toolbar"><button class="secondary" data-share-close>חזרה</button><h2>${e(title)}</h2></div>
    <p>${invoices.length} חשבוניות · ${manifest.entries.length} קבצים מצורפים</p>
    ${invoices.some(i => !i.attachmentIds?.length) ? '<p class="notice warning">יש חשבוניות ללא צילום. הן אינן נכללות בקבצים לשיתוף.</p>' : ""}
    <p data-share-description></p>
    <p class="muted small">במסך השיתוף בוחרים WhatsApp או מייל. חודשים עם הרבה קבצים נשלחים בחלקים.</p>
    <progress max="1" value="0" aria-label="הכנת הקבצים"></progress>
    <p data-share-status role="status"></p><ul class="share-files" data-share-files></ul>
    <p class="notice warning" data-share-error role="alert" hidden></p>
    <button class="primary" data-share-send hidden>${icon("share")} שתף בוואטסאפ או במייל</button>
    <button class="secondary" data-share-zip hidden>${icon("download")} הורד ZIP מסודר</button>
    <button class="secondary" data-share-retry hidden>נסה להכין שוב</button>
    <button class="primary" data-share-next hidden>הכן את החלק הבא</button>
    <button class="text-button" data-share-format>שתף קבצים מקוריים במקום PDF</button></div>`;
  document.body.append(dialog); dialog.showModal();
  const status = $("[data-share-status]", dialog), error = $("[data-share-error]", dialog);
  const send = $("[data-share-send]", dialog), zipButton = $("[data-share-zip]", dialog), next = $("[data-share-next]", dialog), retry = $("[data-share-retry]", dialog), formatButton = $("[data-share-format]", dialog);
  let closed = false, current;
  const active = run => !closed && dialog.isConnected && ctx.api === api && current === run;
  const showError = err => { error.hidden = false; error.textContent = errorText(err); };
  const canShare = files => canShareFiles(files);
  const progress = (run, count) => {
    if (!active(run)) return;
    $("progress", dialog).value = count;
    status.textContent = `מכין ${run.format === "pdf" ? "PDF לחשבוניות" : "קבצים מקוריים"}: ${count} מתוך ${run.entries.length}`;
  };
  const markOffered = run => {
    next.hidden = run.batch.cursor >= run.entries.length;
    status.textContent = run.batch.cursor < run.entries.length ? `חלק ${run.part} מוכן. נשארו עוד ${run.entries.length - run.batch.cursor} קבצים בחלק הבא.` : `הוכנו כל ${run.entries.length} הקבצים לשיתוף.`;
  };
  const prepare = async (run = current) => {
    if (run.busy || !active(run)) return;
    run.busy = true; error.hidden = true; retry.hidden = true; send.hidden = true; zipButton.hidden = true; next.hidden = true;
    try {
      if (!run.entries.length) { status.textContent = "אין קבצים מצורפים לשיתוף."; return; }
      progress(run, run.batch.cursor);
      await run.batch.prepare(count => progress(run, count), () => active(run));
      if (!active(run)) return;
      const archive = await documentZip(run.batch.files);
      if (!active(run)) return;
      run.archive = new File([archive], `invoices-${selection.month || "single"}-${run.format}-part-${run.part}.zip`, { type: "application/zip" });
      const files = run.batch.files.map(f => f.file), direct = canShare(files);
      send.hidden = !direct && !canShare([run.archive]); zipButton.hidden = false;
      send.innerHTML = icon("share") + (direct ? " שתף בוואטסאפ או במייל" : " שתף ZIP בוואטסאפ או במייל");
      run.download = files.length === 1 && run.format === "pdf" ? files[0] : run.archive;
      zipButton.innerHTML = icon("download") + (run.download.type === "application/pdf" ? " הורד PDF" : " הורד ZIP מסודר");
      status.textContent = `חלק ${run.part} מוכן: ${files.length} ${run.format === "pdf" ? "קובצי PDF" : "קבצים מקוריים"}. הוכנו ${run.batch.cursor} מתוך ${run.entries.length}.`;
      $("[data-share-files]", dialog).innerHTML = run.batch.files.map(f => `<li>${e(f.label)}</li>`).join("");
      if (send.hidden) {
        error.hidden = false; error.textContent = "השיתוף הישיר אינו זמין בדפדפן הזה. הורד את הקובץ וצרף אותו לוואטסאפ או למייל.";
        next.hidden = run.batch.cursor >= run.entries.length;
      }
    } catch (err) {
      if (active(run)) {
        showError(err); retry.hidden = false;
        status.textContent = `ההכנה נעצרה ב${run.format === "pdf" ? "חשבונית" : "קובץ"} ${run.batch.cursor + 1} מתוך ${run.entries.length}. שום עמוד לא דולג.`;
      }
    } finally { run.busy = false; }
  };
  const start = format => {
    current?.batch.clear(); current?.pdf?.clear();
    if (current) current.archive = current.download = null;
    const run = { format, entries: format === "pdf" ? manifest.pdfEntries : manifest.entries, part: 1, busy: false, sharing: false, archive: null, download: null, pdf: null };
    current = run;
    run.batch = new DocumentShareBatch(run.entries, async (id, entry, stillActive) => {
      if (format !== "pdf") return api.request("documents/" + id, { blob: true });
      // Load the PDF engine only when sharing, keeping intake/startup small.
      const { InvoicePdfLoader } = await import("./invoice-pdf.js");
      if (!stillActive()) return;
      run.pdf ||= new InvoicePdfLoader(id => api.request("documents/" + id, { blob: true }));
      return run.pdf.load(entry, stillActive, (page, total) => {
        if (active(run)) status.textContent = `מכין PDF לחשבונית ${run.batch.cursor + 1} מתוך ${run.entries.length} · קובץ ${Math.min(page + 1, total)} מתוך ${total}`;
      });
    }, { maxFileBytes: format === "pdf" ? 36 * 1024 * 1024 : SHARE_BATCH_BYTES });
    $("progress", dialog).max = Math.max(run.entries.length, 1); $("progress", dialog).value = 0;
    $("[data-share-files]", dialog).innerHTML = "";
    $("[data-share-description]", dialog).textContent = format === "pdf" ? "כל חשבונית בקובץ PDF אחד, עם כל העמודים שלה. שם הקובץ כולל ספק, תאריך וסכום." : "שיתוף הקבצים המקוריים כפי שנשמרו, ללא המרה. כל צילום או PDF נשלח בנפרד.";
    formatButton.textContent = format === "pdf" ? "שתף קבצים מקוריים במקום PDF" : "חזור לשיתוף PDF";
    void prepare(run);
  };
  send.onclick = async () => {
    const run = current;
    if (run.busy || !active(run) || !run.archive) return;
    run.busy = run.sharing = true; send.disabled = zipButton.disabled = formatButton.disabled = true; error.hidden = true;
    try {
      const files = run.batch.files.map(f => f.file);
      // No downloads/conversion before share: this click grants activation.
      await shareFiles(canShare(files) ? files : [run.archive]);
      if (active(run)) markOffered(run);
    } catch (err) { if (active(run) && err?.name !== "AbortError") showError(Error("השיתוף לא נפתח. נסה שוב או הורד את הקובץ ושלח אותו מהקבצים במכשיר.")); }
    finally {
      run.busy = run.sharing = false;
      if (active(run)) send.disabled = zipButton.disabled = formatButton.disabled = false;
    }
  };
  zipButton.onclick = async () => {
    const run = current;
    if (run.busy || !active(run) || !run.download) return;
    try { await download(run.download, run.download.name, run.download.type, { share: false }); if (active(run)) markOffered(run); }
    catch (err) { if (active(run)) showError(err); }
  };
  next.onclick = () => {
    const run = current;
    if (run.busy || !active(run)) return;
    run.archive = run.download = null; run.batch.next(); run.part++; void prepare(run);
  };
  retry.onclick = () => void prepare();
  formatButton.onclick = () => { if (!current.sharing && active(current)) start(current.format === "pdf" ? "original" : "pdf"); };
  $("[data-share-close]", dialog).onclick = () => dialog.close();
  dialog.onclose = () => {
    closed = true; current.archive = current.download = null; current.batch.clear(); current.pdf?.clear(); dialog.remove();
  };
  start("pdf");
  return dialog;
}
