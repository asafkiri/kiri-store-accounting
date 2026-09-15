import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { loadModule } from './load-module.mjs';
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

// A month that does not fit one share is the case the shop actually hits, and
// the only guide through it is what the dialog says between the parts.
async function shareDialog(t, invoiceCount) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://unit.example' });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  t.after(() => { Object.assign(globalThis, previous); dom.window.close(); });
  const shared = [];
  const module = await loadModule('src/document-sharing.js', {
    './export.js': 'export const canShareFiles=()=>true, download=async()=>{}; export const shareFiles=async files=>globalThis.shareDialogShared.push(files.length);',
    './native-bridge.js': 'export const nativeApp=()=>false;',
    './invoice-pdf.js': "export class InvoicePdfLoader { clear() {} async load() { return new Blob(['%PDF-1.4 invoice'], { type: 'application/pdf' }); } }",
  });
  globalThis.shareDialogShared = shared;
  t.after(() => { delete globalThis.shareDialogShared; });
  const data = {
    suppliers: [{ id: 's1', name: 'גלוברנס' }, { id: 's2', name: 'תנובה' }],
    invoices: Array.from({ length: invoiceCount }, (_, n) => ({
      id: 'i' + n, invoiceDate: `2026-09-${String((n % 28) + 1).padStart(2, '0')}`, documentNumber: '',
      totalAgorot: 12300, finalAgorot: 12300, supplierId: n % 2 ? 's2' : 's1', attachmentIds: ['a' + n],
    })),
  };
  const dialog = module.shareDocuments({ data, api: { request: async () => blob('page') } }, { month: '2026-09' });
  const text = selector => dialog.querySelector(selector).textContent;
  const settle = async check => {
    for (let n = 0; n < 400 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check(), `the dialog never reached the expected state. Status: ${text('[data-share-status]')}`);
  };
  return { dialog, shared, text, settle, button: selector => dialog.querySelector(selector) };
}

test('a month sent in parts always names how much is left, and offers the next part only once one is gone', async t => {
  const { shared, text, settle, button } = await shareDialog(t, 25);
  await settle(() => text('[data-share-status]').startsWith('חלק 1 מוכן'));
  assert.equal(text('[data-share-status]'), 'חלק 1 מוכן לשליחה: 20 חשבוניות. הוכנו 20 מתוך 25.');
  assert.equal(button('[data-share-next]').hidden, true, 'a part that has not left yet is not behind the user');
  assert.match(text('.share-dialog'), /אחרי כל שליחה לוחצים ״הכן את החלק הבא״/);

  button('[data-share-send]').click();
  await settle(() => shared.length === 1);
  assert.deepEqual(shared, [20]);
  // Never "in the next part": 5 is what is left in total, and a reader who
  // reads it as the last part is misled the moment a third part appears.
  assert.equal(text('[data-share-status]'), 'חלק 1 יצא לשליחה. נשארו 5 חשבוניות.');
  assert.equal(button('[data-share-next]').hidden, false);
  assert.equal(text('[data-share-next]'), 'הכן את החלק הבא (נשארו 5 חשבוניות)');

  button('[data-share-next]').click();
  await settle(() => text('[data-share-status]').startsWith('חלק 2 מוכן'));
  assert.equal(text('[data-share-status]'), 'חלק 2 מוכן לשליחה: 5 חשבוניות. הוכנו 25 מתוך 25.');
  button('[data-share-send]').click();
  await settle(() => shared.length === 2);
  assert.equal(text('[data-share-status]'), 'הוכנו כל 25 החשבוניות לשיתוף.');
  assert.equal(button('[data-share-next]').hidden, true, 'nothing is left to prepare');
});

test('a month that fits one share never mentions parts', async t => {
  const { shared, text, settle, button } = await shareDialog(t, 3);
  await settle(() => text('[data-share-status]').startsWith('חלק 1 מוכן'));
  button('[data-share-send]').click();
  await settle(() => shared.length === 1);
  assert.equal(text('[data-share-status]'), 'הוכנו כל 3 החשבוניות לשיתוף.');
  assert.equal(button('[data-share-next]').hidden, true);
});

test('a single invoice left over is counted in Hebrew, never as "1 חשבוניות"', async t => {
  const { shared, text, settle, button } = await shareDialog(t, 21);
  await settle(() => text('[data-share-status]').startsWith('חלק 1 מוכן'));
  button('[data-share-send]').click();
  await settle(() => shared.length === 1);
  assert.equal(text('[data-share-status]'), 'חלק 1 יצא לשליחה. נשארה חשבונית אחת.');
  assert.equal(text('[data-share-next]'), 'הכן את החלק הבא (נשארה חשבונית אחת)');
  button('[data-share-next]').click();
  await settle(() => text('[data-share-status]').startsWith('חלק 2 מוכן'));
  assert.equal(text('[data-share-status]'), 'חלק 2 מוכן לשליחה: חשבונית אחת. הוכנו 21 מתוך 21.');
});

test('ZIP opens in an independent reader with Hebrew folders, valid CRCs and unchanged source bytes', async () => {
  const zip = await documentZip([
    { path: 'ספק/חשבונית/1.jpg', blob: blob('jpeg bytes 123') },
    { path: 'ספק/חשבונית/2.pdf', blob: blob('%PDF original bytes', 'application/pdf') },
  ]);
  const result = execFileSync('python3', ['-c', 'import sys,zipfile,io,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))'], { input: Buffer.from(await zip.arrayBuffer()), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), { 'ספק/חשבונית/1.jpg': 'jpeg bytes 123', 'ספק/חשבונית/2.pdf': '%PDF original bytes' });
});
