import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { InvoicePdfLoader } from "../src/invoice-pdf.js";
import { jpeg, png, nativePdf, orientedJpeg } from "./pdf-fixtures.mjs";

const entry = { id: "invoice", attachmentIds: ["photo", "scan", "pdf"] };
const open = async blob => PDFDocument.load(await blob.arrayBuffer());

test("one invoice preserves image pixels, native PDF text, page order and rotation", async () => {
  const sources = { photo: jpeg, scan: png, pdf: await nativePdf() };
  const loader = new InvoicePdfLoader(id => sources[id]);
  const blob = await loader.load(entry), doc = await open(blob);
  assert.equal(blob.type, "application/pdf"); assert.equal(doc.getPageCount(), 4);
  assert.deepEqual(doc.getPages().map(p => [p.getWidth(), p.getHeight(), p.getRotation().angle]), [[60,40,0],[60,40,0],[400,600,0],[300,200,90]]);
  const images = doc.context.enumerateIndirectObjects().map(([,o]) => o).filter(o => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  const jpg = images.find(o => o.dict.get(PDFName.of("Filter")) === PDFName.of("DCTDecode"));
  assert.deepEqual(jpg.getContents(), new Uint8Array(await jpeg.arrayBuffer()), "JPEG bytes are embedded exactly, without another lossy compression");
  assert.ok(images.every(o => o.dict.get(PDFName.of("Width")).asNumber() === 60 && o.dict.get(PDFName.of("Height")).asNumber() === 40));
  const streams = doc.context.enumerateIndirectObjects().map(([,o]) => o).filter(o => o instanceof PDFRawStream && !o.dict.has(PDFName.of("Subtype")));
  assert.ok(streams.some(o => Buffer.from(decodePDFRawStream(o).decode()).toString().includes(Buffer.from("Fictional invoice").toString("hex").toUpperCase())), "native text remains text rather than a screenshot");
  assert.equal(loader.current, null, "release completed invoice state");
});

test("a single original PDF is returned byte-for-byte, including forms", async () => {
  const original = await nativePdf({ form: true });
  const loader = new InvoicePdfLoader(() => original);
  assert.equal(await loader.load({ id: "one", attachmentIds: ["pdf"] }), original);
  const mixed = new InvoicePdfLoader(id => id === "photo" ? jpeg : original);
  await assert.rejects(mixed.load({ id: "mixed", attachmentIds: ["photo", "pdf"] }), /המקוריים/);
  assert.equal(mixed.current.cursor, 1, "a PDF that cannot be safely combined is never silently skipped");
});

test("a failed page resumes within the invoice and cannot produce a partial or duplicate PDF", async () => {
  const calls = []; let fail = true;
  const source = await nativePdf();
  const loader = new InvoicePdfLoader(id => {
    calls.push(id); if (id === "scan" && fail) { fail = false; throw Error("offline"); }
    return id === "pdf" ? source : jpeg;
  });
  await assert.rejects(loader.load(entry), /offline/);
  assert.equal(loader.current.cursor, 1);
  assert.equal((await open(await loader.load(entry))).getPageCount(), 4);
  assert.deepEqual(calls, ["photo", "scan", "scan", "pdf"]);
  let alive = true, downloads = 0;
  const cancelled = new InvoicePdfLoader(() => { downloads++; alive = false; return jpeg; });
  assert.equal(await cancelled.load(entry, () => alive), undefined);
  assert.equal(downloads, 1); cancelled.clear(); assert.equal(cancelled.current, null);
});

test("camera EXIF rotations and reflections retain the original JPEG and page proportions", async () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    const original = await orientedJpeg(orientation);
    const blob = await new InvoicePdfLoader(() => original).load({ id: String(orientation), attachmentIds: ["photo"] });
    const doc = await open(blob), page = doc.getPage(0);
    assert.deepEqual([page.getWidth(), page.getHeight()], orientation >= 5 ? [40,60] : [60,40]);
    const embedded = doc.context.enumerateIndirectObjects().map(([,o]) => o).find(o => o instanceof PDFRawStream && o.dict.get(PDFName.of("Filter")) === PDFName.of("DCTDecode"));
    assert.deepEqual(embedded.getContents(), new Uint8Array(await original.arrayBuffer()));
  }
});

test("invalid and oversized sources stop at their page and retain the retry position", async () => {
  for (const original of [new Blob(["broken"], { type: "image/jpeg" }), new Blob(["broken"], { type: "application/pdf" }), new Blob(["error"], { type: "text/html" }), new Blob([new Uint8Array(36 * 1024 * 1024 + 1)], { type: "image/jpeg" })]) {
    const loader = new InvoicePdfLoader(() => original);
    await assert.rejects(loader.load({ id: "bad", attachmentIds: ["photo"] }));
    assert.equal(loader.current.cursor, 0);
    assert.equal(loader.current.pdf.getPageCount(), 0);
  }
});
