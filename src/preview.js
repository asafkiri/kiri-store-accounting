import { $, toast, errorText } from "./ui.js";
import { download } from "./export.js";
export function previewDocument(blob) {
  const url = URL.createObjectURL(blob), dialog = document.createElement("dialog");
  dialog.className = "preview-dialog";
  const pdf = blob.type === "application/pdf";
  dialog.innerHTML = `<div class="preview-toolbar"><button class="secondary" data-preview-close>סגור תצוגת מסמך</button><button class="secondary" data-preview-download>${pdf ? "שמור או שתף PDF" : "שמור או שתף תמונה"}</button></div>${pdf
    ? `<p>כדי לראות את כל עמודי ה־PDF, פתח אותו בצופה המסמכים של המכשיר.</p><a class="primary" href="${url}" target="_blank" rel="noopener">פתח PDF מלא</a><p class="small">אם הקובץ לא נפתח, שמור אותו ופתח דרך הקבצים במכשיר.</p>`
    : `<img src="${url}" alt="המסמך המצורף">`}`;
  document.body.append(dialog);
  $("[data-preview-close]", dialog).onclick = () => dialog.close();
  $("[data-preview-download]", dialog).onclick = () =>
    download(blob, pdf ? "invoice.pdf" : "invoice-image." + ({ "image/png": "png", "image/webp": "webp" }[blob.type] || "jpg"), blob.type).catch(error => toast(errorText(error), true));
  dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); };
  dialog.showModal();
  return dialog;
}
