import { $, toast, errorText, icon } from "./ui.js";
import { download } from "./export.js";
// The photograph is the record, so it opens as large as the screen allows. A
// page the phone scanned upside down is turned from here too: at this size the
// owner can see which way is up, which a thumbnail never showed him.
export function previewDocument(blob, { onRotate = null } = {}) {
  let url = URL.createObjectURL(blob);
  const dialog = document.createElement("dialog");
  dialog.className = "preview-dialog";
  const pdf = blob.type === "application/pdf";
  dialog.innerHTML = `<div class="preview-toolbar"><button class="secondary" data-preview-close>סגור תצוגת מסמך</button>${onRotate && !pdf ? '<button class="secondary" data-preview-rotate>' + icon("refresh") + " סובב</button>" : ""}<button class="secondary" data-preview-download>${pdf ? "שמור או שתף PDF" : "שמור או שתף תמונה"}</button></div>${pdf
    ? `<p>כדי לראות את כל עמודי ה־PDF, פתח אותו בצופה המסמכים של המכשיר.</p><a class="primary" href="${url}" target="_blank" rel="noopener">פתח PDF מלא</a><p class="small">אם הקובץ לא נפתח, שמור אותו ופתח דרך הקבצים במכשיר.</p>`
    : `<img src="${url}" alt="המסמך המצורף">`}`;
  document.body.append(dialog);
  $("[data-preview-close]", dialog).onclick = () => dialog.close();
  const rotate = $("[data-preview-rotate]", dialog);
  if (rotate)
    rotate.onclick = async () => {
      rotate.disabled = true;
      try {
        const turned = await onRotate();
        if (turned) {
          const previous = url;
          blob = turned;
          url = URL.createObjectURL(turned);
          $("img", dialog).src = url;
          URL.revokeObjectURL(previous);
        }
      } catch (error) {
        toast(errorText(error), true);
      } finally {
        rotate.disabled = false;
      }
    };
  $("[data-preview-download]", dialog).onclick = () =>
    download(blob, pdf ? "invoice.pdf" : "invoice-image." + ({ "image/png": "png", "image/webp": "webp" }[blob.type] || "jpg"), blob.type).catch(error => toast(errorText(error), true));
  dialog.onclose = () => { URL.revokeObjectURL(url); dialog.remove(); };
  dialog.showModal();
  return dialog;
}
