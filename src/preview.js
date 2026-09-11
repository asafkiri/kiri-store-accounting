import { $, toast, errorText } from "./ui.js";
import { download } from "./export.js";
export function previewDocument(blob) {
  const url = URL.createObjectURL(blob), dialog = document.createElement("dialog");
  dialog.className = "preview-dialog";
  const pdf = blob.type === "application/pdf";
  dialog.innerHTML = `<button class="secondary" data-preview-close>סגור תצוגת מסמך</button>${pdf
    ? `<p>כדי לראות את כל עמודי ה־PDF, פתח אותו בצופה המסמכים של המכשיר.</p><a class="primary" href="${url}" target="_blank" rel="noopener">פתח PDF מלא</a><button class="secondary" data-preview-download>שמור או שתף PDF</button><p class="small">אם הקובץ לא נפתח, שמור אותו ופתח דרך הקבצים במכשיר.</p>`
    : `<img src="${url}" alt="המסמך המצורף">`}`;
  document.body.append(dialog);
  $("[data-preview-close]", dialog).onclick = () => dialog.close();
  if (pdf) $("[data-preview-download]", dialog).onclick = () =>
    download(blob, "document.pdf", "application/pdf").catch(error => toast(errorText(error), true));
  dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); };
  dialog.showModal();
  return dialog;
}
