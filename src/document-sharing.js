import { $, icon, errorText } from "./ui.js";
import { escapeHtml as e, monthLabel, displayDate, money, moneyInput } from "./format.js";
import { download, canShareFiles, shareFiles } from "./export.js";
import { nativeApp } from "./native-bridge.js";

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
      // entryPath names the entry itself, without the extension the ZIP needs:
      // it is what the share memory records as already gone.
      this.files.push({ ...entry, blob, entryPath: entry.path, path: entry.path + "." + ext, file: new File([blob], entry.name + "." + ext, { type: blob.type }) });
      this.carry = null; this.bytes += blob.size; this.cursor++; progress(this.cursor);
    }
  }
  next() { this.files = []; this.bytes = 0; }
  clear() { this.next(); this.carry = null; }
}

// A month too big for one share leaves in parts, with a trip to WhatsApp
// between them — and the phone is free to close the app during that trip.
// What already left is remembered here, on the phone itself, so the next
// screen carries on instead of sending the first part a second time.
//
// The share sheet coming back is not proof the accountant received anything,
// so the memory never hides what it skipped: the screen says how much already
// went and keeps a button that sends the month again from the start.
const MEMORY_PREFIX = "ksa-share-sent:";
const MEMORY_MAX_AGE = 60 * 24 * 60 * 60 * 1000;
export const shareMemoryKey = (selection, format) =>
  MEMORY_PREFIX + (selection.month || selection.invoiceId || "") + ":" + format;
export function readShareMemory(key) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) || "null");
    if (!Array.isArray(saved?.paths) || !saved.paths.length) return null;
    // A month nobody came back to within two months is not a send in progress.
    if (!(Date.now() - saved.at < MEMORY_MAX_AGE)) { clearShareMemory(key); return null; }
    return { paths: new Set(saved.paths), parts: Number(saved.parts) || 0 };
  } catch { return null; } // No storage on this phone: every share starts whole.
}
export function rememberShared(key, paths, parts) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ paths: [...paths], parts, at: Date.now() }));
  } catch { /* Without storage the send still works, it just cannot resume. */ }
}
export function clearShareMemory(key) {
  try { window.localStorage.removeItem(key); } catch { /* Nothing to forget. */ }
}

export function shareDocuments(ctx, selection) {
  const manifest = sharingManifest(ctx.data, selection), api = ctx.api;
  const { invoices } = manifest;
  const title = selection.month ? "שליחת חשבוניות " + monthLabel(selection.month) : "שליחת החשבונית";
  // In the wrapper a download is a share: the WebView saves nothing by itself.
  const keepVerb = nativeApp() ? "שתף" : "הורד";
  const dialog = document.createElement("dialog"); dialog.className = "preview-dialog";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<div class="share-dialog"><div class="preview-toolbar"><button class="secondary" data-share-close>חזרה</button><h2>${e(title)}</h2></div>
    <p>${invoices.length} חשבוניות · ${manifest.entries.length} קבצים מצורפים</p>
    ${invoices.some(i => !i.attachmentIds?.length) ? '<p class="notice warning">יש חשבוניות ללא צילום. הן אינן נכללות בקבצים לשיתוף.</p>' : ""}
    <p data-share-description></p>
    <p class="notice" data-share-resume hidden></p>
    <p class="muted small">במסך השיתוף בוחרים WhatsApp או מייל. חודש גדול נשלח בכמה חלקים: אחרי כל שליחה לוחצים ״הכן את החלק הבא״, עד שנכתב כאן שהכל הוכן.</p>
    <p class="muted small">קבצים שנשלחים בנפרד מגיעים אצל המקבל בסדר שהאפליקציה שלו בוחרת. קובץ ה־ZIP שומר תיקייה לכל ספק ואת הסדר לפי ספק ותאריך.</p>
    <progress max="1" value="0" aria-label="הכנת הקבצים"></progress>
    <p data-share-status role="status"></p><ul class="share-files" data-share-files></ul>
    <p class="notice warning" data-share-error role="alert" hidden></p>
    <button class="primary" data-share-send hidden>${icon("share")} שתף בוואטסאפ או במייל</button>
    <button class="secondary" data-share-zip hidden>${icon(nativeApp() ? "share" : "download")} ${keepVerb} ZIP מסודר לפי ספק</button>
    <button class="secondary" data-share-retry hidden>נסה להכין שוב</button>
    <button class="primary" data-share-next hidden>הכן את החלק הבא</button>
    <button class="secondary" data-share-restart hidden>שלח את החודש מחדש מההתחלה</button>
    <button class="text-button" data-share-format>שתף קבצים מקוריים במקום PDF</button></div>`;
  document.body.append(dialog); dialog.showModal();
  const status = $("[data-share-status]", dialog), error = $("[data-share-error]", dialog);
  const send = $("[data-share-send]", dialog), zipButton = $("[data-share-zip]", dialog), next = $("[data-share-next]", dialog), retry = $("[data-share-retry]", dialog), formatButton = $("[data-share-format]", dialog);
  const resumeNote = $("[data-share-resume]", dialog), restart = $("[data-share-restart]", dialog);
  let closed = false, current;
  const active = run => !closed && dialog.isConnected && ctx.api === api && current === run;
  const showError = err => { error.hidden = false; error.textContent = errorText(err); };
  const canShare = files => canShareFiles(files);
  const progress = (run, count) => {
    if (!active(run)) return;
    $("progress", dialog).value = count;
    status.textContent = `מכין ${run.format === "pdf" ? "PDF לחשבוניות" : "קבצים מקוריים"}: ${count} מתוך ${run.entries.length}`;
  };
  // Hebrew does not read "1 חשבוניות", and the originals are files rather than
  // invoices, so the count and its verb are written out rather than glued on.
  const unit = run => (run.format === "pdf" ? "חשבוניות" : "קבצים");
  const items = (run, n) =>
    n === 1 ? (run.format === "pdf" ? "חשבונית אחת" : "קובץ אחד") : `${n} ${unit(run)}`;
  // A month leaves in parts, so every line says how much is still waiting —
  // what is left in total, never "in the next part": the next part carries as
  // much as fits, and a reader who expects it to be the last one is misled.
  const rest = (run, n) => `${n === 1 ? (run.format === "pdf" ? "נשארה" : "נשאר") : "נשארו"} ${items(run, n)}`;
  const showNext = run => {
    const left = run.entries.length - run.batch.cursor;
    next.hidden = left <= 0;
    if (left > 0) next.textContent = `הכן את החלק הבא (${rest(run, left)})`;
    return left;
  };
  const showRestart = run => { restart.hidden = !run.sent.size; };
  const markOffered = (run, verb) => {
    const left = showNext(run);
    // This part left the app. Remember it, so a phone that closes the app on
    // the way to WhatsApp carries on instead of sending the part again; once
    // nothing is left the month is done and the memory goes with it.
    for (const file of run.batch.files) run.sent.add(file.entryPath);
    if (left > 0) rememberShared(run.key, run.sent, run.part); else clearShareMemory(run.key);
    showRestart(run);
    if (left > 0) status.textContent = `חלק ${run.part} ${verb}. ${rest(run, left)}.`;
    else status.textContent = run.entries.length === 1
      ? "הכל מוכן לשיתוף."
      : `הוכנו כל ${run.entries.length} ה${unit(run)} לשיתוף.`;
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
      // The accountant reads the archive's name too, so it carries the month
      // and a part number only when the month did not fit in one file. ASCII
      // only: a browser download drops a name it cannot transliterate, and
      // "download.zip" says less than the supplier folders inside.
      const whole = run.part === 1 && run.batch.cursor >= run.entries.length;
      run.archive = new File([archive], `invoices-${selection.month || "single"}${whole ? "" : `-part-${run.part}`}.zip`, { type: "application/zip" });
      const files = run.batch.files.map(f => f.file), direct = canShare(files);
      send.hidden = !direct && !canShare([run.archive]); zipButton.hidden = false;
      send.innerHTML = icon("share") + (direct ? " שתף בוואטסאפ או במייל" : " שתף ZIP בוואטסאפ או במייל");
      run.download = files.length === 1 && run.format === "pdf" ? files[0] : run.archive;
      zipButton.innerHTML = icon(nativeApp() ? "share" : "download") + " " + keepVerb + (run.download.type === "application/pdf" ? " PDF" : " ZIP מסודר לפי ספק");
      status.textContent = `חלק ${run.part} מוכן לשליחה: ${items(run, files.length)}. הוכנו ${run.batch.cursor} מתוך ${run.entries.length}.`;
      $("[data-share-files]", dialog).innerHTML = run.batch.files.map(f => `<li>${e(f.label)}</li>`).join("");
      if (send.hidden) {
        error.hidden = false; error.textContent = "השיתוף הישיר אינו זמין בדפדפן הזה. הורד את הקובץ וצרף אותו לוואטסאפ או למייל.";
        showNext(run);
      }
    } catch (err) {
      if (active(run)) {
        showError(err); retry.hidden = false;
        status.textContent = `ההכנה נעצרה ב${run.format === "pdf" ? "חשבונית" : "קובץ"} ${run.batch.cursor + 1} מתוך ${run.entries.length}. שום עמוד לא דולג.`;
      }
    } finally { run.busy = false; }
  };
  const start = (format, fresh = false) => {
    current?.batch.clear(); current?.pdf?.clear();
    if (current) current.archive = current.download = null;
    const key = shareMemoryKey(selection, format), all = format === "pdf" ? manifest.pdfEntries : manifest.entries;
    if (fresh) clearShareMemory(key);
    // A memory covering the whole month is a send that finished, not one to
    // resume; only what is genuinely left over continues where it stopped.
    const memory = fresh ? null : readShareMemory(key);
    const left = memory ? all.filter(entry => !memory.paths.has(entry.path)) : all;
    const resuming = memory && left.length ? memory : null;
    if (memory && !left.length) clearShareMemory(key);
    const run = { format, key, entries: resuming ? left : all, part: (resuming?.parts || 0) + 1,
      sent: new Set(resuming?.paths || []), busy: false, sharing: false, archive: null, download: null, pdf: null };
    current = run;
    resumeNote.hidden = !resuming;
    if (resuming) resumeNote.textContent = `בשליחה קודמת של החודש הזה כבר יצאו ${all.length - run.entries.length} מתוך ${all.length} ${unit(run)}, וההכנה ממשיכה מכאן. אם אותה שליחה לא הגיעה ליעד — אפשר לשלוח את החודש מחדש מההתחלה.`;
    showRestart(run);
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
      // The share sheet came back, which is not a delivery receipt: say the
      // part left the app, never that the accountant has it.
      if (active(run)) markOffered(run, "יצא לשליחה");
    } catch (err) { if (active(run) && err?.name !== "AbortError") showError(Error("השיתוף לא נפתח. נסה שוב או הורד את הקובץ ושלח אותו מהקבצים במכשיר.")); }
    finally {
      run.busy = run.sharing = false;
      if (active(run)) send.disabled = zipButton.disabled = formatButton.disabled = false;
    }
  };
  zipButton.onclick = async () => {
    const run = current;
    if (run.busy || !active(run) || !run.download) return;
    try {
      await download(run.download, run.download.name, run.download.type, { share: false });
      // In the wrapper that download opened the share sheet; a browser saved it.
      if (active(run)) markOffered(run, nativeApp() ? "יצא לשליחה" : "ירד למכשיר");
    }
    catch (err) { if (active(run)) showError(err); }
  };
  next.onclick = () => {
    const run = current;
    if (run.busy || !active(run)) return;
    run.archive = run.download = null; run.batch.next(); run.part++; void prepare(run);
  };
  retry.onclick = () => void prepare();
  // The month goes out again from its first invoice: the only way back when a
  // part the app counted as sent never reached the accountant.
  restart.onclick = () => { if (!current.sharing && active(current)) start(current.format, true); };
  formatButton.onclick = () => { if (!current.sharing && active(current)) start(current.format === "pdf" ? "original" : "pdf"); };
  $("[data-share-close]", dialog).onclick = () => dialog.close();
  dialog.onclose = () => {
    closed = true; current.archive = current.download = null; current.batch.clear(); current.pdf?.clear(); dialog.remove();
  };
  start("pdf");
  return dialog;
}
