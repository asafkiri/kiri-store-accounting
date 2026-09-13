import { $, icon, errorText } from "./ui.js";
import { escapeHtml as e, monthLabel, invoiceLabel } from "./format.js";
import { download } from "./export.js";

export const SHARE_BATCH_BYTES = 18 * 1024 * 1024;
export const SHARE_BATCH_FILES = 20;
const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const safeName = value => String(value || "מסמך").normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "-").replace(/^\.+|\.+$/g, "").trim().slice(0, 70) || "מסמך";

// The selection comes from saved invoices, never from the current search,
// status filter or pagination. Keep a shared attachment under each invoice.
export function sharingManifest(data, { month, invoiceId }) {
  if (!invoiceId && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) return { invoices: [], entries: [] };
  const names = new Map(data.suppliers.map(s => [s.id, s.name]));
  const invoices = data.invoices.filter(i => !i.deletedAt && (invoiceId ? i.id === invoiceId : i.invoiceDate?.slice(0, 7) === month))
    .sort((a, b) => (names.get(a.supplierId) || "").localeCompare(names.get(b.supplierId) || "", "he") || a.invoiceDate.localeCompare(b.invoiceDate) || a.id.localeCompare(b.id));
  const entries = invoices.flatMap((i, index) => [...new Set(i.attachmentIds || [])].map((id, page) => {
    const supplier = safeName(names.get(i.supplierId) || "ספק"), invoice = `${safeName(i.invoiceDate)}_${safeName(i.documentNumber)}_${index + 1}`;
    return { id, label: `${names.get(i.supplierId) || "ספק"} · ${invoiceLabel(i)} · קובץ ${page + 1}`,
      name: `${supplier}_${invoice}_${page + 1}`, path: `${supplier}/${invoice}/${page + 1}` };
  }));
  return { invoices, entries };
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
  constructor(entries, load, { maxBytes = SHARE_BATCH_BYTES, maxFiles = SHARE_BATCH_FILES } = {}) {
    Object.assign(this, { entries, load, maxBytes, maxFiles, cursor: 0, files: [], bytes: 0, carry: null });
  }
  async prepare(progress = () => {}, active = () => true) {
    while (this.cursor < this.entries.length && this.files.length < this.maxFiles && this.bytes < this.maxBytes && active()) {
      const entry = this.entries[this.cursor];
      const blob = this.carry || await this.load(entry.id);
      if (!active()) return;
      if (!extensions[blob.type] || !blob.size) throw Error("אחד הקבצים אינו צילום או PDF תקין. פתח את החשבונית ובדוק את הקובץ.");
      // The upload API limits each document to 12 MiB. Enforce a bound here too.
      if (blob.size > this.maxBytes && this.maxBytes === SHARE_BATCH_BYTES) throw Error("הקובץ גדול מדי לשיתוף בחלקים. פתח אותו ושתף אותו בנפרד.");
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
  const { invoices, entries } = sharingManifest(ctx.data, selection), api = ctx.api;
  const title = selection.month ? "צילומי " + monthLabel(selection.month) : "צילומי " + invoiceLabel(invoices[0]);
  const dialog = document.createElement("dialog"); dialog.className = "preview-dialog";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<div class="share-dialog"><div class="preview-toolbar"><button class="secondary" data-share-close>חזרה</button><h2>${e(title)}</h2></div>
    <p>${invoices.length} חשבוניות · ${entries.length} קבצים מקוריים</p>
    ${invoices.some(i => !i.attachmentIds?.length) ? '<p class="notice warning">יש בחודש חשבוניות ללא צילום. הן אינן נכללות בקבצים לשיתוף.</p>' : ""}
    <p class="muted small">בחר WhatsApp או מייל במסך השיתוף. אם יש הרבה קבצים, משתפים אותם בחלקים. ZIP שומר את המקור בתיקיות לפי ספק וחשבונית.</p>
    <progress max="${Math.max(entries.length, 1)}" value="0" aria-label="הכנת הקבצים"></progress>
    <p data-share-status role="status"></p><ul class="share-files" data-share-files></ul>
    <p class="notice warning" data-share-error role="alert" hidden></p>
    <button class="primary" data-share-send hidden>${icon("share")} שתף בוואטסאפ או במייל</button>
    <button class="secondary" data-share-zip hidden>${icon("download")} הורד ZIP מסודר</button>
    <button class="secondary" data-share-retry hidden>נסה להכין שוב</button>
    <button class="primary" data-share-next hidden>הכן את החלק הבא</button></div>`;
  document.body.append(dialog); dialog.showModal();
  const status = $("[data-share-status]", dialog), error = $("[data-share-error]", dialog);
  const send = $("[data-share-send]", dialog), zipButton = $("[data-share-zip]", dialog), next = $("[data-share-next]", dialog), retry = $("[data-share-retry]", dialog);
  let part = 1, archive = null, closed = false, busy = false;
  const batch = new DocumentShareBatch(entries, id => api.request("documents/" + id, { blob: true }));
  const active = () => !closed && dialog.isConnected && ctx.api === api;
  const showError = err => { error.hidden = false; error.textContent = errorText(err); };
  const progress = count => { $("progress", dialog).value = count; status.textContent = `מכין קבצים: ${count} מתוך ${entries.length}`; };
  const canShare = files => { try { return Boolean(navigator.share && navigator.canShare?.({ files })); } catch { return false; } };
  const markOffered = () => {
    next.hidden = batch.cursor >= entries.length;
    status.textContent = batch.cursor < entries.length ? `חלק ${part} מוכן. נשארו עוד ${entries.length - batch.cursor} קבצים בחלק הבא.` : `הוכנו כל ${entries.length} הקבצים לשיתוף.`;
  };
  const prepare = async () => {
    if (busy || !active()) return;
    busy = true; error.hidden = true; retry.hidden = true; send.hidden = true; zipButton.hidden = true; next.hidden = true;
    try {
      if (!entries.length) { status.textContent = "אין קבצים מצורפים לשיתוף."; return; }
      progress(batch.cursor);
      await batch.prepare(progress, active);
      if (!active()) return;
      archive = new File([await documentZip(batch.files)], `invoices-${selection.month || "single"}-part-${part}.zip`, { type: "application/zip" });
      if (!active()) return;
      const files = batch.files.map(f => f.file);
      send.hidden = !canShare(files) && !canShare([archive]); zipButton.hidden = false;
      status.textContent = `חלק ${part} מוכן: ${files.length} קבצים (${(batch.bytes / 1024 / 1024).toFixed(1)} MB). הוכנו ${batch.cursor} מתוך ${entries.length}.`;
      $("[data-share-files]", dialog).innerHTML = batch.files.map(f => `<li>${e(f.label)}</li>`).join("");
      if (send.hidden) { error.hidden = false; error.textContent = "השיתוף הישיר אינו זמין בדפדפן הזה. הורד ZIP וצרף אותו לוואטסאפ או למייל."; next.hidden = batch.cursor >= entries.length; }
    } catch (err) {
      if (active()) { showError(err); retry.hidden = false; status.textContent = `ההכנה נעצרה בקובץ ${batch.cursor + 1} מתוך ${entries.length}. שום קובץ לא דולג.`; }
    } finally { busy = false; }
  };
  send.onclick = async () => {
    if (busy || !active()) return;
    busy = true; send.disabled = zipButton.disabled = true; error.hidden = true;
    try {
      const files = batch.files.map(f => f.file);
      // No download or async work before share: this click grants activation.
      await navigator.share({ files: canShare(files) ? files : [archive] });
      if (active()) markOffered();
    } catch (err) { if (active() && err?.name !== "AbortError") showError(Error("השיתוף לא נפתח. נסה שוב או הורד ZIP ושלח אותו מהקבצים במכשיר.")); }
    finally { busy = false; send.disabled = zipButton.disabled = false; }
  };
  zipButton.onclick = async () => {
    if (busy || !active()) return;
    try { await download(archive, archive.name, archive.type, { share: false }); if (active()) markOffered(); }
    catch (err) { showError(err); }
  };
  next.onclick = () => { if (busy || !active()) return; archive = null; batch.next(); part++; void prepare(); };
  retry.onclick = () => void prepare();
  $("[data-share-close]", dialog).onclick = () => dialog.close();
  dialog.onclose = () => { closed = true; archive = null; batch.clear(); dialog.remove(); };
  void prepare();
  return dialog;
}
