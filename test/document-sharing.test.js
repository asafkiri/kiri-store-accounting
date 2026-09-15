import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { loadModule } from './load-module.mjs';
import { sharingManifest, DocumentShareBatch, documentZip, SHARE_BATCH_FILES, SHARE_BATCH_BYTES } from '../src/document-sharing.js';
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
const SUPPLIERS = ['גלוברנס', 'דובק', 'מוצרי איכות קנדיים', 'פיליפ מוריס', 'תנובה'];
// One phone, opened as many times as the test needs: the share memory lives in
// that phone's storage, so resuming can only be tested across two openings.
async function shareWorkspace(t, invoiceCount, { pdfBytes = 0, suppliers = 2, storage = true } = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://unit.example' });
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false; this.dispatchEvent(new dom.window.Event('close'));
  };
  if (!storage) Object.defineProperty(dom.window, 'localStorage', { get() { throw Error('blocked'); } });
  t.after(() => { Object.assign(globalThis, previous); dom.window.close(); });
  const shared = [];
  const module = await loadModule('src/document-sharing.js', {
    './export.js': 'export const canShareFiles=()=>true, download=async()=>{}; export const shareFiles=async files=>globalThis.shareDialogShared.push(files.map(f=>f.name));',
    './native-bridge.js': 'export const nativeApp=()=>false;',
    './invoice-pdf.js': "const size=globalThis.shareDialogPdfBytes; export class InvoicePdfLoader { clear() {} async load() { return new Blob([size ? new Uint8Array(size) : '%PDF-1.4 invoice'], { type: 'application/pdf' }); } }",
  });
  globalThis.shareDialogShared = shared; globalThis.shareDialogPdfBytes = pdfBytes;
  t.after(() => { delete globalThis.shareDialogShared; delete globalThis.shareDialogPdfBytes; });
  const data = {
    suppliers: SUPPLIERS.slice(0, suppliers).map((name, n) => ({ id: 's' + n, name })),
    invoices: Array.from({ length: invoiceCount }, (_, n) => ({
      id: 'i' + n, invoiceDate: `2026-09-${String((n % 28) + 1).padStart(2, '0')}`, documentNumber: '',
      totalAgorot: 12300, finalAgorot: 12300, supplierId: 's' + (n % suppliers), attachmentIds: ['a' + n],
    })),
  };
  const open = () => {
    const dialog = module.shareDocuments({ data, api: { request: async () => blob('page') } }, { month: '2026-09' });
    const text = selector => dialog.querySelector(selector).textContent;
    const settle = async check => {
      for (let n = 0; n < 2000 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(check(), `the dialog never reached the expected state. Status: ${text('[data-share-status]')}`);
    };
    // What the screen lists as ready right now, in the order it will go out.
    const listed = () => [...dialog.querySelectorAll('.share-files li')].map(li => li.textContent);
    return { dialog, shared, text, settle, listed, close: () => dialog.close(), button: sel => dialog.querySelector(sel) };
  };
  // What the phone itself is holding onto between openings.
  const remembered = () => {
    try { return JSON.parse(dom.window.localStorage.getItem('ksa-share-sent:2026-09:pdf') || 'null'); }
    catch { return null; }
  };
  return { data, shared, open, remembered };
}
async function shareDialog(t, invoiceCount, options) {
  const shop = await shareWorkspace(t, invoiceCount, options);
  return { ...shop, ...shop.open() };
}

// Send every part the way the shop owner does: wait, share, ask for the next.
async function drainParts({ shared, text, settle, button }, limit = 20) {
  for (let part = 1; part <= limit; part++) {
    await settle(() => text('[data-share-status]').startsWith(`חלק ${part} מוכן`));
    button('[data-share-send]').click();
    await settle(() => shared.length === part);
    if (button('[data-share-next]').hidden) return part;
    button('[data-share-next]').click();
  }
  assert.fail(`the month never finished within ${limit} parts`);
}

test('a month sent in parts always names how much is left, and offers the next part only once one is gone', async t => {
  const { shared, text, settle, button } = await shareDialog(t, 25);
  await settle(() => text('[data-share-status]').startsWith('חלק 1 מוכן'));
  assert.equal(text('[data-share-status]'), 'חלק 1 מוכן לשליחה: 20 חשבוניות. הוכנו 20 מתוך 25.');
  assert.equal(button('[data-share-next]').hidden, true, 'a part that has not left yet is not behind the user');
  assert.match(text('.share-dialog'), /אחרי כל שליחה לוחצים ״הכן את החלק הבא״/);

  button('[data-share-send]').click();
  await settle(() => shared.length === 1);
  assert.equal(shared[0].length, 20);
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

// The shop's real months are the ones nobody can rehearse on a phone: dozens of
// invoices at the size the scanner actually produces. Both bounds are exercised
// here — the file count on a normal month, the byte budget on a heavy one —
// because an invoice dropped or sent twice between parts reaches the accountant.
test('a 47-invoice month leaves in parts, each invoice exactly once and in supplier order', async t => {
  const dialog = await shareDialog(t, 47, { pdfBytes: 520 * 1024, suppliers: 5 });
  const expected = sharingManifest(dialog.data, { month: '2026-09' }).pdfEntries.map(entry => entry.name + '.pdf');
  assert.equal(expected.length, 47);
  const parts = await drainParts(dialog);
  assert.equal(parts, 3, '20 + 20 + 7 by the file-count bound');
  assert.deepEqual(dialog.shared.flat(), expected, 'the supplier order survives the part boundaries');
  assert.equal(new Set(dialog.shared.flat()).size, 47, 'no invoice is sent twice');
  assert.deepEqual(dialog.shared.map(part => part.length), [20, 20, 7]);
  assert.equal(dialog.text('[data-share-status]'), 'הוכנו כל 47 החשבוניות לשיתוף.');
});

test('invoices too big for the byte budget split before the file count does', async t => {
  const dialog = await shareDialog(t, 10, { pdfBytes: Math.ceil(2.5 * 1024 * 1024), suppliers: 3 });
  const parts = await drainParts(dialog);
  const sizes = dialog.shared.map(part => part.length);
  // 7 × 2.5 MiB fits under the 18 MiB a share may carry; the eighth does not.
  assert.deepEqual(sizes, [7, 3], 'the byte budget, not the file count, ended the part');
  assert.ok(sizes.every(n => n < SHARE_BATCH_FILES && n * 2.5 * 1024 * 1024 <= SHARE_BATCH_BYTES));
  assert.equal(parts, 2);
  assert.equal(new Set(dialog.shared.flat()).size, 10, 'no invoice is sent twice');
});

// Between two parts the owner leaves for WhatsApp, and Android is free to
// close the app while he is there. What already went out is remembered on the
// phone so the next screen carries on — and, because a share sheet coming back
// is not a delivery, never hides that it skipped anything.
test('a month interrupted after one part carries on where it stopped, and forgets itself when it ends', async t => {
  const shop = await shareWorkspace(t, 25);
  const expected = sharingManifest(shop.data, { month: '2026-09' }).pdfEntries.map(entry => entry.name + '.pdf');
  const first = shop.open();
  await first.settle(() => first.text('[data-share-status]').startsWith('חלק 1 מוכן'));
  assert.equal(first.button('[data-share-resume]').hidden, true, 'a first send has nothing to resume');
  assert.equal(first.button('[data-share-restart]').hidden, true, 'and nothing to take back');
  first.button('[data-share-send]').click();
  await first.settle(() => shop.shared.length === 1);
  assert.equal(first.button('[data-share-restart]').hidden, false, 'a part that left can always be sent again');
  assert.equal(shop.remembered().paths.length, 20, 'the phone holds what went out, not merely this screen');
  assert.equal(shop.remembered().parts, 1);
  first.close(); // Android closed the app on the way to WhatsApp.

  const again = shop.open();
  await again.settle(() => again.text('[data-share-status]').startsWith('חלק 2 מוכן'));
  assert.equal(again.button('[data-share-resume]').hidden, false);
  assert.match(again.text('[data-share-resume]'), /כבר יצאו 20 מתוך 25 חשבוניות/);
  assert.equal(again.text('[data-share-status]'), 'חלק 2 מוכן לשליחה: 5 חשבוניות. הוכנו 5 מתוך 5.');
  again.button('[data-share-send]').click();
  await again.settle(() => shop.shared.length === 2);
  assert.deepEqual(shop.shared.flat(), expected, 'the month arrives whole, in order, nothing sent twice');
  assert.equal(shop.remembered(), null, 'a month that finished is not a send in progress');

  const afterwards = shop.open();
  await afterwards.settle(() => afterwards.text('[data-share-status]').startsWith('חלק 1 מוכן'));
  assert.equal(afterwards.button('[data-share-resume]').hidden, true, 'a finished month starts whole again');
  assert.equal(afterwards.text('[data-share-status]'), 'חלק 1 מוכן לשליחה: 20 חשבוניות. הוכנו 20 מתוך 25.');
});

test('sending the month again from the start clears what the app counted as sent', async t => {
  const shop = await shareWorkspace(t, 25);
  const view = shop.open();
  await view.settle(() => view.text('[data-share-status]').startsWith('חלק 1 מוכן'));
  view.button('[data-share-send]').click();
  await view.settle(() => shop.shared.length === 1);
  assert.equal(shop.remembered().paths.length, 20);
  view.button('[data-share-restart]').click();
  await view.settle(() => view.text('[data-share-status]') === 'חלק 1 מוכן לשליחה: 20 חשבוניות. הוכנו 20 מתוך 25.');
  assert.equal(view.button('[data-share-resume]').hidden, true);
  assert.equal(shop.remembered(), null, 'the phone forgot it, so the whole month goes out again');
  view.close();
  const later = shop.open();
  await later.settle(() => later.text('[data-share-status]').startsWith('חלק 1 מוכן'));
  assert.equal(later.button('[data-share-resume]').hidden, true, 'the memory was taken back, not just this screen');
});

test('a phone that blocks local storage sends the month exactly as before', async t => {
  const shop = await shareWorkspace(t, 25, { storage: false });
  const first = shop.open();
  await first.settle(() => first.text('[data-share-status]').startsWith('חלק 1 מוכן'));
  first.button('[data-share-send]').click();
  await first.settle(() => shop.shared.length === 1);
  assert.equal(first.text('[data-share-status]'), 'חלק 1 יצא לשליחה. נשארו 5 חשבוניות.');
  assert.equal(shop.remembered(), null, 'nothing was stored, and nothing threw');
  first.close();
  const again = shop.open();
  await again.settle(() => again.text('[data-share-status]').startsWith('חלק 1 מוכן'));
  assert.equal(again.button('[data-share-resume]').hidden, true, 'no storage, no memory, and no error either');
  assert.equal(again.text('[data-share-status]'), 'חלק 1 מוכן לשליחה: 20 חשבוניות. הוכנו 20 מתוך 25.');
});

test('ZIP opens in an independent reader with Hebrew folders, valid CRCs and unchanged source bytes', async () => {
  const zip = await documentZip([
    { path: 'ספק/חשבונית/1.jpg', blob: blob('jpeg bytes 123') },
    { path: 'ספק/חשבונית/2.pdf', blob: blob('%PDF original bytes', 'application/pdf') },
  ]);
  const result = execFileSync('python3', ['-c', 'import sys,zipfile,io,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))'], { input: Buffer.from(await zip.arrayBuffer()), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), { 'ספק/חשבונית/1.jpg': 'jpeg bytes 123', 'ספק/חשבונית/2.pdf': '%PDF original bytes' });
});
