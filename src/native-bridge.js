// The Android wrapper loads this same site in a WebView and injects one plugin:
// the phone's own document scanner and its share sheet. A browser has neither,
// so every function here is behind `nativeApp()` and the web paths stay as they
// are. Nothing is stored natively except the file being shared, in the cache.
const CHUNK = 3 * 1024 * 1024;

const plugin = () => {
  const capacitor = typeof window === "undefined" ? null : window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  return capacitor.Plugins?.KiriScanner || null;
};
export const nativeApp = () => Boolean(plugin());
// The wrapper marks its own WebView, so the app knows it is running inside one
// even when the bridge did not load — that is worth saying out loud instead of
// looking like a phone whose camera simply failed.
export const nativeWrapper = () =>
  typeof navigator !== "undefined" && /KiriStoreAndroid/.test(navigator.userAgent || "");

let scannerCheck = null;
// Why the phone's own scanner cannot take this page, as one short clause, or
// null when it can. Asked once per session: a missing scanner stays missing.
export function scannerBlocked() {
  if (!nativeWrapper() && !nativeApp()) return Promise.resolve("האפליקציה אינה מותקנת כמעטפת");
  const api = plugin();
  if (!api?.available) return Promise.resolve("הגשר של האפליקציה לא נטען");
  scannerCheck ||= api.available().then(
    result => (result?.available ? null : `שירותי Google בטלפון אינם מוכנים לסריקה${result?.status ? ` (קוד ${result.status})` : ""}`),
    error => "בדיקת הסורק נכשלה: " + (error?.message || error),
  );
  return scannerCheck;
}

// Pages arrive as the app's own format: JPEG, at most 2500px, quality 88.
export async function scanPages(limit = 8) {
  const api = plugin();
  if (!api?.scan) throw Error("הסורק של הטלפון אינו זמין.");
  const result = await api.scan({ limit });
  const pages = Array.isArray(result?.pages) ? result.pages : [];
  return pages.slice(0, limit).map((page, index) => {
    if (page?.mime !== "image/jpeg" || typeof page.data !== "string" || !page.data)
      throw Error("הסריקה לא הושלמה. נסה שוב או צלם דרך ״מצלמת הטלפון״.");
    return {
      name: typeof page.name === "string" && page.name ? page.name : `scan-${index + 1}.jpg`,
      mime: page.mime,
      data: page.data,
    };
  });
}

const encodeChunk = bytes => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};

// A month of invoices can be tens of megabytes. The file crosses the bridge in
// chunks and is written as it arrives, so it is never held twice in memory.
export async function nativeShare(files) {
  const api = plugin();
  if (!api?.shareFileStart) throw Error("השיתוף אינו זמין כאן. אפשר לשמור את הקובץ ולשלוח אותו מהקבצים במכשיר.");
  const ids = [];
  for (const file of files) {
    const started = await api.shareFileStart({ name: file.name, mime: file.type || "application/octet-stream" });
    const id = started?.id;
    if (!id) throw Error("לא ניתן להכין את הקובץ לשיתוף.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    for (let offset = 0; offset < bytes.length; offset += CHUNK)
      await api.shareFileChunk({ id, data: encodeChunk(bytes.subarray(offset, offset + CHUNK)) });
    ids.push(id);
  }
  const types = new Set(files.map(file => file.type).filter(Boolean));
  await api.shareFiles({ ids, mime: types.size === 1 ? [...types][0] : "*/*" });
}
