import { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix } from "pdf-lib";
import { decodeImage } from "./image-upload.js";

// The usual intake is at most 12 MiB. Leave room for older invoices and PDF
// overhead, while keeping a single invoice bounded on a phone.
export const MAX_INVOICE_PDF_BYTES = 36 * 1024 * 1024;
const supported = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const tooLarge = () => Error("החשבונית גדולה מדי להכנת PDF במכשיר. אפשר לשתף את הקבצים המקוריים למטה.");

// Read orientation without decoding/recompressing JPEG pixels. Current uploads
// are already upright, but older originals can still have camera EXIF rotation.
function jpegOrientation(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1), size = view.getUint16(offset + 2);
      if (marker === 0xda || marker === 0xd9 || size < 2) break;
      if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
        const start = offset + 10, little = view.getUint16(start) === 0x4949;
        if (view.getUint16(start + 2, little) !== 42) break;
        const directory = start + view.getUint32(start + 4, little), count = view.getUint16(directory, little);
        for (let n = 0; n < count; n++) {
          const tag = directory + 2 + n * 12;
          if (view.getUint16(tag, little) === 0x0112 && view.getUint16(tag + 2, little) === 3 && view.getUint32(tag + 4, little) === 1) {
            const value = view.getUint16(tag + 8, little);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
      }
      offset += size + 2;
    }
  } catch { /* Missing/malformed optional EXIF does not discard the image. */ }
  return 1;
}

async function webpPng(blob) {
  const canvas = document.createElement("canvas"); let image;
  try {
    image = await decodeImage(blob);
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    if (!canvas.width || !canvas.height || canvas.width * canvas.height > 40_000_000) throw tooLarge();
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("לא ניתן לפתוח את התמונה במכשיר הזה.");
    ctx.drawImage(image, 0, 0);
    const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!png) throw Error("לא ניתן להמיר את התמונה.");
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    image?.close?.(); canvas.width = canvas.height = 1;
  }
}

async function appendImage(pdf, blob, bytes) {
  if (blob.type === "image/png" && bytes.length >= 24) {
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.getUint32(16) * header.getUint32(20) > 40_000_000) throw tooLarge();
  }
  const orientation = blob.type === "image/jpeg" ? jpegOrientation(bytes) : 1;
  const image = blob.type === "image/jpeg" ? await pdf.embedJpg(bytes) : await pdf.embedPng(blob.type === "image/webp" ? await webpPng(blob) : bytes);
  const w = image.width, h = image.height, swapped = orientation >= 5;
  await image.embed(); // Finish embedding before committing the page; retries cannot duplicate it.
  // Only the PDF's physical page size changes. Every source pixel is retained.
  const scale = Math.min(1, 842 / Math.max(w, h));
  const page = pdf.addPage([(swapped ? h : w) * scale, (swapped ? w : h) * scale]);
  const transforms = [null, [1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, w, 0], [-1, 0, 0, -1, w, h],
    [1, 0, 0, -1, 0, h], [0, -1, -1, 0, h, w], [0, -1, 1, 0, 0, w],
    [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, h, 0]];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...transforms[orientation].map(n => n * scale)));
  page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  page.pushOperators(popGraphicsState());
}

// Resume only the current invoice after a failed download. Completed invoices
// live in the bounded sharing batch; no whole-month photo cache is retained.
export class InvoicePdfLoader {
  constructor(load) { this.loadDocument = load; this.current = null; }
  clear() { this.current = null; }
  async load(entry, active = () => true, progress = () => {}) {
    if (!active()) return;
    if (this.current?.id !== entry.id) this.current = { id: entry.id, cursor: 0, bytes: 0, pdf: await PDFDocument.create() };
    const state = this.current;
    while (state.cursor < entry.attachmentIds.length && active()) {
      progress(state.cursor, entry.attachmentIds.length);
      const blob = await this.loadDocument(entry.attachmentIds[state.cursor]);
      if (!active()) return;
      if (!supported.has(blob.type) || !blob.size) throw Error("אחד הקבצים אינו צילום או PDF תקין. אפשר לבדוק אותו בחשבונית או לשתף את המקור.");
      if (state.bytes + blob.size > MAX_INVOICE_PDF_BYTES) throw tooLarge();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!active()) return;
      try {
        if (blob.type === "application/pdf") {
          if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) throw Error("Invalid PDF");
          // A PDF already represents one complete invoice. Return its exact
          // bytes, including signatures and interactive fields, without edits.
          if (entry.attachmentIds.length === 1) { this.clear(); return blob; }
          const source = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
          if (!source.getPageCount() || source.getForm().getFields().length) throw Error("Unsupported PDF form");
          const pages = await state.pdf.copyPages(source, source.getPageIndices());
          if (!active()) return;
          pages.forEach(page => state.pdf.addPage(page));
        } else {
          await appendImage(state.pdf, blob, bytes);
        }
      } catch {
        throw Error(`לא ניתן לצרף את קובץ ${state.cursor + 1} ל־PDF של החשבונית. אפשר לנסות שוב או לשתף את הקבצים המקוריים למטה.`);
      }
      if (!active()) return;
      state.bytes += blob.size; state.cursor++;
      progress(state.cursor, entry.attachmentIds.length);
    }
    if (!active()) return;
    if (!state.pdf.getPageCount()) throw Error("אין עמודים להכנת PDF.");
    const bytes = await state.pdf.save({ addDefaultPage: false, updateFieldAppearances: false });
    if (!active()) return;
    if (bytes.length > MAX_INVOICE_PDF_BYTES) throw tooLarge();
    this.clear();
    return new Blob([bytes], { type: "application/pdf" });
  }
}
