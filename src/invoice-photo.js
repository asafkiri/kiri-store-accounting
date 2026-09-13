import { $, icon } from "./ui.js";

// Only the displayed page is downloaded. Its original blob also powers zoom;
// URLs and bytes are released on paging, navigation, or account changes.
export function mountInvoicePhoto(root, invoice, { load, preview, isCurrent }) {
  const section = $("[data-invoice-photo]", root);
  if (!section) return () => {};
  const files = invoice.attachmentIds || [], stage = $("[data-photo-stage]", section);
  const previous = $("[data-photo-previous]", section), next = $("[data-photo-next]", section);
  let index = 0, request = 0, disposed = false, url, blob;
  const active = () => !disposed && root.isConnected && isCurrent();
  const release = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
    blob = null;
  };
  const showError = missing => {
    release();
    stage.setAttribute("aria-busy", "false");
    stage.innerHTML = `<div class="invoice-photo-message"><p role="status">${missing ? "הצילום אינו זמין כרגע." : "לא הצלחנו לטעון את הצילום. בדוק את החיבור ונסה שוב."}</p><button class="secondary" data-photo-retry>${icon("refresh")} נסה שוב</button></div>`;
    $("[data-photo-retry]", stage).onclick = () => show(index);
  };
  async function show(page) {
    index = page;
    const attempt = ++request;
    release();
    $("[data-photo-counter]", section).textContent = files.length > 1 ? `עמוד ${index + 1} מתוך ${files.length}` : "";
    if (previous) previous.disabled = index === 0;
    if (next) next.disabled = index === files.length - 1;
    stage.setAttribute("aria-busy", "true");
    stage.innerHTML = '<p role="status">טוען צילום…</p>';
    try {
      const loaded = await load(files[index]);
      if (!active() || request !== attempt) return;
      blob = loaded;
      if (blob.type === "application/pdf") {
        stage.innerHTML = `<div class="invoice-photo-message">${icon("invoice")}<strong>מסמך PDF</strong><button class="secondary" data-photo-open>פתח את כל עמודי המסמך</button></div>`;
        stage.setAttribute("aria-busy", "false");
      } else {
        url = URL.createObjectURL(blob);
        stage.innerHTML = `<button class="invoice-photo-open" data-photo-open aria-label="הגדל צילום, עמוד ${index + 1}"><img alt="צילום החשבונית, עמוד ${index + 1}" decoding="async"><span>${icon("search")} לחץ על הצילום להגדלה</span></button>`;
        const img = $("img", stage);
        img.onload = () => { if (active() && request === attempt) stage.setAttribute("aria-busy", "false"); };
        img.onerror = () => { if (active() && request === attempt) showError(true); };
        img.src = url;
      }
      $("[data-photo-open]", stage).onclick = () => { if (active() && blob) preview(blob); };
    } catch (err) {
      if (active() && request === attempt) showError(err.status === 404 || err.status === 410);
    }
  }
  if (previous) previous.onclick = () => show(Math.max(0, index - 1));
  if (next) next.onclick = () => show(Math.min(files.length - 1, index + 1));
  void show(0);
  return () => { disposed = true; request++; release(); stage.replaceChildren(); };
}
