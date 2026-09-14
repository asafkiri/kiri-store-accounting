import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// The Android wrapper injects window.Capacitor with one plugin. Every test
// builds that plugin itself, so the web fallbacks are exercised as well.
let moduleCount = 0;
const freshBridge = () => import("../src/native-bridge.js?case=" + ++moduleCount);
const freshExport = () => import("../src/export.js?case=" + ++moduleCount);

const installPlugin = (t, api, { native = true } = {}) => {
  const previous = globalThis.window;
  globalThis.window = { Capacitor: { isNativePlatform: () => native, Plugins: api ? { KiriScanner: api } : {} } };
  t.after(() => { globalThis.window = previous; });
};
const setNavigator = (t, value) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "navigator", previous); });
};
const page = (extra = {}) => ({ name: "scan-1.jpg", mime: "image/jpeg", data: "AAECAw==", ...extra });

test("the bridge is invisible in a browser and in a wrapper without the plugin", async t => {
  const { nativeApp, scannerBlocked, scanPages } = await freshBridge();
  assert.equal(nativeApp(), false, "no window.Capacitor at all");
  installPlugin(t, { scan: async () => ({ pages: [page()] }) }, { native: false });
  assert.equal(nativeApp(), false, "Capacitor reporting the web platform");
  globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: {} } };
  assert.equal(nativeApp(), false, "a wrapper build without the scanner plugin");
  assert.match(await scannerBlocked(), /אינה מותקנת כמעטפת/);
  await assert.rejects(scanPages(), /הסורק של הטלפון אינו זמין/);
});

test("a wrapper whose bridge never loaded is named as such, not as a broken camera", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Linux; Android 14) KiriStoreAndroid" }, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "navigator", previous); });
  const { nativeWrapper, scannerBlocked } = await freshBridge();
  assert.equal(nativeWrapper(), true);
  assert.match(await scannerBlocked(), /הגשר של האפליקציה לא נטען/);
});

test("a phone without Google Play services answers once, with its reason", async t => {
  let asked = 0;
  installPlugin(t, { available: async () => { asked++; return { available: false, status: 1 }; }, scan: async () => ({ pages: [] }) });
  const { scannerBlocked } = await freshBridge();
  assert.match(await scannerBlocked(), /שירותי Google.*קוד 1/);
  await scannerBlocked();
  assert.equal(asked, 1, "the phone is asked once per session");
});

test("a scanner the phone says is ready blocks nothing", async t => {
  installPlugin(t, { available: async () => ({ available: true, status: 0 }), scan: async () => ({ pages: [] }) });
  const { scannerBlocked } = await freshBridge();
  assert.equal(await scannerBlocked(), null);
});

test("a failing availability check keeps the app on its own camera and says so", async t => {
  installPlugin(t, { available: async () => { throw Error("play services missing"); } });
  const { scannerBlocked } = await freshBridge();
  assert.match(await scannerBlocked(), /בדיקת הסורק נכשלה: play services missing/);
});

test("scanned pages arrive as ready draft pages, and a cancelled scan adds none", async t => {
  const calls = [];
  installPlugin(t, {
    available: async () => ({ available: true }),
    scan: async options => { calls.push(options); return { pages: calls.length === 1 ? [] : [page(), page({ name: "" })] }; },
  });
  const { scanPages } = await freshBridge();
  assert.deepEqual(await scanPages(3), [], "cancelling the scanner leaves the draft alone");
  assert.deepEqual(calls, [{ limit: 3 }], "the remaining room is the page limit");
  assert.deepEqual(await scanPages(2), [
    { name: "scan-1.jpg", mime: "image/jpeg", data: "AAECAw==" },
    { name: "scan-2.jpg", mime: "image/jpeg", data: "AAECAw==" },
  ]);
});

test("a page that did not come back whole is refused, and extra pages are dropped", async t => {
  for (const broken of [page({ data: "" }), page({ mime: "application/pdf" }), page({ data: 5 }), null]) {
    installPlugin(t, { scan: async () => ({ pages: [page(), broken] }) });
    const { scanPages } = await freshBridge();
    await assert.rejects(scanPages(8), /הסריקה לא הושלמה/, JSON.stringify(broken));
  }
  installPlugin(t, { scan: async () => ({ pages: [page(), page(), page()] }) });
  const { scanPages } = await freshBridge();
  assert.equal((await scanPages(2)).length, 2, "never more pages than there is room for");
});

test("a shared file crosses the bridge in chunks, in order, and is sent as one type", async t => {
  const log = [];
  installPlugin(t, {
    shareFileStart: async value => { log.push(["start", value.name, value.mime]); return { id: "id-" + log.length }; },
    shareFileChunk: async value => { log.push(["chunk", value.id, atob(value.data).length]); },
    shareFiles: async value => { log.push(["share", value.ids.join(","), value.mime]); },
  });
  const { nativeShare } = await freshBridge();
  const big = new File([new Uint8Array(7 * 1024 * 1024)], "חשבוניות.zip", { type: "application/zip" });
  await nativeShare([big]);
  assert.deepEqual(log, [
    ["start", "חשבוניות.zip", "application/zip"],
    ["chunk", "id-1", 3 * 1024 * 1024],
    ["chunk", "id-1", 3 * 1024 * 1024],
    ["chunk", "id-1", 1024 * 1024],
    ["share", "id-1", "application/zip"],
  ]);
  log.length = 0;
  await nativeShare([new File(["a"], "a.pdf", { type: "application/pdf" }), new File(["b"], "b.jpg", { type: "image/jpeg" })]);
  assert.deepEqual(log.at(-1), ["share", "id-1,id-3", "*/*"], "mixed types leave the choice to the phone");
});

test("a share the wrapper cannot start is reported, never silently dropped", async t => {
  installPlugin(t, { shareFileStart: async () => ({}) });
  const { nativeShare } = await freshBridge();
  await assert.rejects(nativeShare([new File(["a"], "a.pdf", { type: "application/pdf" })]), /להכין את הקובץ לשיתוף/);
  installPlugin(t, { scan: async () => ({ pages: [] }) });
  const { nativeShare: withoutShare } = await freshBridge();
  await assert.rejects(withoutShare([new File(["a"], "a.pdf")]), /השיתוף אינו זמין כאן/);
});

test("in the wrapper a download becomes a share; in a browser it stays a download", async t => {
  const dom = new JSDOM("<main></main>", { url: "https://unit.example" });
  t.after(() => dom.window.close());
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previousDocument; });
  dom.window.URL.createObjectURL = () => "blob:unit";
  dom.window.URL.revokeObjectURL = () => {};
  globalThis.URL.createObjectURL ||= dom.window.URL.createObjectURL;
  globalThis.URL.revokeObjectURL ||= dom.window.URL.revokeObjectURL;
  setNavigator(t, {});
  const shared = [];
  installPlugin(t, {
    shareFileStart: async value => { shared.push(value.name); return { id: "id-1" }; },
    shareFileChunk: async () => {},
    shareFiles: async value => shared.push("sent:" + value.mime),
  });
  const { download, canShareFiles, shareFiles } = await freshExport();
  assert.equal(canShareFiles([new File(["a"], "a.pdf")]), true, "the wrapper can always share");
  await download(new Blob(["csv"], { type: "text/csv" }), "invoices.csv", "text/csv");
  assert.deepEqual(shared, ["invoices.csv", "sent:text/csv"]);
  let clicked = 0;
  dom.window.HTMLAnchorElement.prototype.click = function () { clicked++; };
  globalThis.window = undefined;
  const web = await freshExport();
  assert.equal(web.canShareFiles([new File(["a"], "a.pdf")]), false);
  await web.download(new Blob(["csv"], { type: "text/csv" }), "invoices.csv", "text/csv");
  assert.equal(clicked, 1, "a browser still saves the file");
  assert.equal(shared.length, 2, "and never reaches the wrapper");
});

test("the web share sheet is preferred over the wrapper when the browser has one", async t => {
  const offered = [];
  setNavigator(t, { share: async value => offered.push(value.files.map(f => f.name)), canShare: () => true });
  installPlugin(t, { shareFileStart: async () => { throw Error("must not be used"); } });
  const { shareFiles, canShareFiles } = await freshExport();
  assert.equal(canShareFiles([new File(["a"], "a.pdf")]), true);
  await shareFiles([new File(["a"], "a.pdf")]);
  assert.deepEqual(offered, [["a.pdf"]]);
});

test("without any way to share, the reason is said in Hebrew", async t => {
  setNavigator(t, {});
  const previous = globalThis.window;
  globalThis.window = undefined;
  t.after(() => { globalThis.window = previous; });
  const { shareFiles } = await freshExport();
  await assert.rejects(shareFiles([new File(["a"], "a.pdf")]), /השיתוף אינו נתמך כאן/);
});

test("only the wrapper widens the accepted type, so its WebView opens the camera", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => { if (previous) Object.defineProperty(globalThis, "navigator", previous); });
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (iPhone) Safari" }, configurable: true, writable: true });
  const web = await freshBridge();
  assert.equal(web.captureAccept(), "image/jpeg,image/png,image/webp");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Linux; Android 14) KiriStoreAndroid" }, configurable: true, writable: true });
  const wrapper = await freshBridge();
  assert.equal(wrapper.captureAccept(), "image/*", "a precise list sends the wrapper to the gallery instead");
});
