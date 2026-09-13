import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sharingManifest, DocumentShareBatch, documentZip } from '../src/document-sharing.js';
const invoice = (id, date, attachments, extra = {}) => ({ id, invoiceDate: date, documentNumber: '', totalAgorot: 125400, finalAgorot: 120000, supplierId: 's1', attachmentIds: attachments, ...extra });
const blob = (text, type = 'image/jpeg') => new Blob([text], { type });

test('month selection includes paid/unpaid, archived suppliers, all pages and PDFs; excludes deleted invoices and other months', () => {
  const data = { suppliers: [{ id: 's1', name: '../ספק/א', deletedAt: 1 }], invoices: [
    invoice('one', '2026-09-01', ['a', 'b'], { status: 'unpaid' }),
    invoice('two', '2026-09-02', ['c'], { status: 'paid' }),
    invoice('shared', '2026-09-03', ['a', 'a']),
    invoice('manual', '2026-09-04', []),
    invoice('deleted', '2026-09-05', ['d'], { deletedAt: 1 }),
    invoice('previous', '2026-08-01', ['e']),
  ] };
  const result = sharingManifest(data, { month: '2026-09' });
  assert.equal(result.invoices.length, 4);
  assert.equal(result.pdfEntries.length, 3);
  assert.deepEqual(result.pdfEntries[0].attachmentIds, ['a', 'b']);
  assert.deepEqual(result.entries.map(e => e.id), ['a', 'b', 'c', 'a']);
  assert.equal(new Set(result.entries.map(e => e.path)).size, 4);
  assert.ok(result.entries.every(e => !e.path.split('/').includes('..')));
  assert.deepEqual(sharingManifest(data, { invoiceId: 'one' }).entries.map(e => e.id), ['a', 'b']);
  assert.equal(sharingManifest(data, {}).entries.length, 0);
});

test('PDF filenames use supplier/date/printed amount, stay stable for single sharing and cannot overwrite a duplicate', () => {
  const data = { suppliers: [{ id: 's1', name: 'ספק/א' }], invoices: [
    invoice('a', '2026-09-02', ['one'], { documentNumber: 'DO-NOT-USE' }),
    invoice('b', '2026-09-02', ['two']),
    invoice('c', '2026-09-03', ['three'], { totalAgorot: -1050 }),
  ] };
  const { pdfEntries } = sharingManifest(data, { month: '2026-09' });
  assert.equal(pdfEntries[0].name, 'ספק-א_2026-09-02_1254.00ILS');
  assert.equal(pdfEntries[1].name, 'ספק-א_2026-09-02_1254.00ILS (2)');
  assert.match(pdfEntries[2].name, /-10\.50ILS$/);
  assert.equal(sharingManifest(data, { invoiceId: 'b' }).pdfEntries[0].name, pdfEntries[1].name);
  assert.ok(pdfEntries.every(e => !e.name.includes('DO-NOT-USE')));
});

test('an invoice PDF larger than a batch is offered whole on its own, then the next invoice follows', async () => {
  const entries = ['a', 'b', 'c'].map(id => ({ id, name: id, path: id }));
  const batch = new DocumentShareBatch(entries, id => blob('x'.repeat(id === 'b' ? 15 : 6), 'application/pdf'), { maxBytes: 10, maxFileBytes: 20 });
  const delivered = [];
  do {
    await batch.prepare(); delivered.push(batch.files.map(f => f.id)); batch.next();
  } while (batch.cursor < entries.length);
  assert.deepEqual(delivered, [['a'], ['b'], ['c']]);
});

test('bounded batches and retry deliver every original exactly once without skipping a failed file', async () => {
  const entries = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, path: id }));
  const requested = []; let fail = true;
  const batch = new DocumentShareBatch(entries, async id => {
    requested.push(id); if (id === 'b' && fail) { fail = false; throw Error('offline'); }
    return blob('123456');
  }, { maxBytes: 10, maxFiles: 2 });
  await assert.rejects(batch.prepare(), /offline/);
  assert.equal(batch.cursor, 1);
  await batch.prepare();
  assert.deepEqual(batch.files.map(f => f.id), ['a']);
  const delivered = [];
  do {
    delivered.push(...batch.files.map(f => f.id)); batch.next(); await batch.prepare();
  } while (batch.files.length);
  assert.deepEqual(delivered, ['a', 'b', 'c', 'd']);
  assert.deepEqual(requested, ['a', 'b', 'b', 'c', 'd']);
  batch.clear(); assert.equal(batch.carry, null);
});

test('file-count limits, closing during preparation and invalid content stop further downloads', async () => {
  const entries = ['a', 'b', 'c'].map(id => ({ id, name: id, path: id }));
  let calls = 0;
  const batch = new DocumentShareBatch(entries, async () => { calls++; return blob('x'); }, { maxFiles: 2 });
  await batch.prepare(); assert.equal(calls, 2); assert.equal(batch.cursor, 2);
  let active = true;
  const cancelled = new DocumentShareBatch(entries, async () => { active = false; return blob('x'); });
  await cancelled.prepare(() => {}, () => active); assert.equal(cancelled.cursor, 0);
  const invalid = new DocumentShareBatch(entries, async () => blob('<html>error</html>', 'text/html'));
  await assert.rejects(invalid.prepare(), /תקין/); assert.equal(invalid.cursor, 0);
});

test('ZIP opens in an independent reader with Hebrew folders, valid CRCs and unchanged source bytes', async () => {
  const zip = await documentZip([
    { path: 'ספק/חשבונית/1.jpg', blob: blob('jpeg bytes 123') },
    { path: 'ספק/חשבונית/2.pdf', blob: blob('%PDF original bytes', 'application/pdf') },
  ]);
  const result = execFileSync('python3', ['-c', 'import sys,zipfile,io,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))'], { input: Buffer.from(await zip.arrayBuffer()), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), { 'ספק/חשבונית/1.jpg': 'jpeg bytes 123', 'ספק/חשבונית/2.pdf': '%PDF original bytes' });
});
