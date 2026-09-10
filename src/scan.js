import { $, icon, toast, errorText } from "./ui.js";
import {
  escapeHtml as e,
  money,
  displayDate,
  monthRange,
  today,
} from "./format.js";
import { invoiceForm } from "./forms.js";
import { readFile } from "./image-upload.js";
export { readFile } from "./image-upload.js";
export async function scanDialog(ctx, purpose = "invoice") {
  const key = purpose === "invoice" ? "scan" : "reportScan";
  let draft = (await ctx.drafts.load(key)) || {
    files: [],
    attachmentIds: [],
    jobId: null,
    status: "editing",
    result: null,
  };
  const root = ctx.dialog(
    purpose === "invoice" ? "סריקת חשבונית" : "בדיקה מול רואה החשבון",
    `<div class="scan-view"><p>${purpose === "invoice" ? "צלם את כל העמודים של אותה חשבונית, או בחר תמונות / PDF." : "הדוח משמש להשוואה בלבד. הוא אינו מוסיף או משנה חשבוניות."}</p><div class="capture-actions"><label class="primary upload-label">${icon("camera")} צלם עמוד<input type="file" id="camera-file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden></label><label class="secondary upload-label">בחר תמונות / PDF<input type="file" id="gallery-file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden></label></div><p class="muted small">עד 8 עמודים ו־12 מגה אחרי הקטנת התמונות. כל העמוד נשמר ללא חיתוך. PDF נשאר כפי שנבחר.</p><div id="file-previews" class="file-previews"></div><div id="scan-error" class="form-error" role="alert" hidden></div><div id="scan-status" class="notice" hidden></div><div class="scan-buttons"><button class="primary" id="run-scan">סרוק ובדוק פרטים</button><button class="secondary" id="check-scan" hidden>בדוק תוצאה של סריקה קודמת</button><button class="text-button" id="new-scan" hidden>התחל סריקה חדשה</button><button class="secondary" id="manual-from-scan">המשך בהקלדה ידנית</button><button class="text-button" id="clear-scan">נקה את הצילום והטיוטה</button></div></div>`,
  );
  let busy = false;
  const persist = () => ctx.drafts.save(key, draft);
  const err = $("#scan-error", root),
    status = $("#scan-status", root);
  const showError = (error) => {
    err.hidden = false;
    err.textContent = errorText(error);
  };
  const paint = () => {
    const locked = busy || Boolean(draft.jobId);
    for (const input of root.querySelectorAll("input[type=file]"))
      input.disabled = locked;
    $("#run-scan", root).disabled = locked || !draft.files.length;
    $("#run-scan", root).textContent = busy
      ? "הסריקה מתבצעת…"
      : "סרוק ובדוק פרטים";
    $("#check-scan", root).hidden = !draft.jobId;
    $("#check-scan", root).disabled = busy;
    $("#new-scan", root).hidden = !draft.jobId;
    $("#new-scan", root).disabled = busy;
    $("#clear-scan", root).disabled = busy;
    $("#manual-from-scan", root).hidden = purpose !== "invoice";
    $("#manual-from-scan", root).disabled = busy;
    $("#file-previews", root).innerHTML = draft.files
      .map(
        (f, i) =>
          `<article class="file-preview">${f.mime === "application/pdf" ? `<div class="pdf-preview">${icon("invoice")}<strong>PDF</strong><small>כל העמודים בקובץ ייקראו</small></div>` : `<img src="data:${e(f.mime)};base64,${e(f.data)}" alt="תצוגת עמוד ${i + 1}">`}<div><span>${e(f.name)}</span><button type="button" class="text-button" data-preview-file="${i}">הגדל</button><button type="button" class="text-button danger" data-remove-file="${i}" ${locked ? "disabled" : ""}>הסר / צלם מחדש</button></div></article>`,
      )
      .join("");
  };
  const finish = async (job) => {
    draft.status = job.status;
    draft.result = job;
    await persist();
    if (job.status === "completed") {
      if (purpose === "invoice") {
        await invoiceForm(ctx, null, job);
      } else await showComparison(ctx, job);
    } else if (job.status === "failed") {
      status.hidden = false;
      status.textContent =
        "הסריקה לא הושלמה. אפשר להתחיל סריקה חדשה או למלא ידנית.";
    } else {
      status.hidden = false;
      status.textContent =
        "הסריקה עדיין מתבצעת. בעוד רגע אפשר ללחוץ שוב על בדיקת התוצאה.";
      paint();
    }
  };
  for (const input of root.querySelectorAll("input[type=file]"))
    input.onchange = async () => {
      if (busy || draft.jobId) return;
      busy = true;
      ctx.setModalBusy(true);
      paint();
      err.hidden = true;
      try {
        const selected = [...input.files];
        if (selected.length + draft.files.length > 8)
          throw Error("ניתן לבחור עד 8 קבצים ועד 12 מגה בסך הכול.");
        // Decode one page at a time to bound memory on phones. Check size after compression.
        const files = [];
        for (const file of selected) files.push(await readFile(file));
        if (
          files.some(
            (f) =>
              ![
                "image/jpeg",
                "image/png",
                "image/webp",
                "application/pdf",
              ].includes(f.mime),
          )
        )
          throw Error("בחר תמונה בפורמט JPG, PNG או WebP, או קובץ PDF.");
        if (draft.files.length + files.length > 8)
          throw Error("ניתן לבחור עד 8 קבצים.");
        if (
          [...draft.files, ...files].reduce(
            (n, f) => n + (f.data.length * 3) / 4,
            0,
          ) >
          12 * 1024 * 1024
        )
          throw Error("הקבצים גדולים מ־12 מגה. בחר פחות עמודים.");
        draft.files.push(...files);
        draft.attachmentIds = [];
        draft.jobId = null;
        draft.status = "editing";
        await persist();
        paint();
      } catch (error) {
        showError(error);
      } finally {
        input.value = "";
        busy = false;
        ctx.setModalBusy(false);
        if (root.isConnected) paint();
      }
    };
  root.addEventListener("click", async (ev) => {
    const remove = ev.target.closest("[data-remove-file]"),
      preview = ev.target.closest("[data-preview-file]");
    if (remove) {
      if (busy || draft.jobId) return;
      draft.files.splice(Number(remove.dataset.removeFile), 1);
      draft.attachmentIds = [];
      draft.jobId = null;
      draft.status = "editing";
      try {
        await persist();
        paint();
      } catch (error) {
        showError(error);
      }
    }
    if (preview) {
      const f = draft.files[Number(preview.dataset.previewFile)],
        bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      ctx.previewBlob(new Blob([bytes], { type: f.mime }));
    }
  });
  $("#run-scan", root).onclick = async () => {
    if (busy || draft.status === "running") return;
    busy = true;
    ctx.setModalBusy(true);
    err.hidden = true;
    status.hidden = false;
    status.textContent =
      "מעלה את המסמך וקורא את הפרטים. החשבונית תישמר רק אחרי בדיקה ואישור שלך.";
    paint();
    try {
      if (!draft.attachmentIds.length) {
        const r = await ctx.api.request("documents", {
          method: "POST",
          body: { files: draft.files },
          timeout: 50_000,
        });
        draft.attachmentIds = r.documents.map((d) => d.id);
        await persist();
      }
      draft.jobId ||= crypto.randomUUID();
      draft.status = "running";
      await persist();
      const job = await ctx.api.request(
        purpose === "invoice" ? "scan-invoice" : "scan-report",
        {
          method: "POST",
          body: { jobId: draft.jobId, attachmentIds: draft.attachmentIds },
          timeout: 50_000,
        },
      );
      await finish(job);
    } catch (error) {
      showError(error);
      if (error.status === 409 && error.code === "SCAN_IN_PROGRESS") {
        // A global lease can reject this request before its job exists. GET is free.
        try {
          await finish(await ctx.api.request("scan-jobs/" + draft.jobId));
        } catch (lookup) {
          if (lookup.status === 404) {
            draft.status = "editing";
            draft.jobId = null;
            draft.result = null;
            await persist();
            status.textContent = "מתבצעת סריקה אחרת בחנות. נסה בעוד רגע.";
          } else {
            status.textContent =
              "לא התקבלה תשובה. בדוק את תוצאת הסריקה לפני ניסיון נוסף.";
          }
        }
        return;
      }
      if (error.status && error.code !== "SCAN_IN_PROGRESS") {
        draft.status = "failed";
        await persist();
      }
      status.textContent =
        "אם התקבל ניתוק, בדוק קודם את תוצאת הסריקה הקודמת. אין סריקה חוזרת אוטומטית.";
    } finally {
      busy = false;
      ctx.setModalBusy(false);
      if (root.isConnected) paint();
    }
  };
  $("#check-scan", root).onclick = async () => {
    if (busy) return;
    busy = true;
    paint();
    try {
      await finish(await ctx.api.request("scan-jobs/" + draft.jobId));
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      if (root.isConnected) paint();
    }
  };
  $("#new-scan", root).onclick = async () => {
    if (!confirm("סריקה חדשה שולחת בקשה נוספת ל־AI. להתחיל מחדש?")) return;
    draft.jobId = null;
    draft.status = "editing";
    draft.result = null;
    await persist();
    status.hidden = true;
    paint();
  };
  $("#manual-from-scan", root).onclick = async () => {
    try {
      await invoiceForm(ctx, null, null, draft.attachmentIds);
    } catch (error) {
      showError(error);
    }
  };
  $("#clear-scan", root).onclick = async () => {
    if (
      !confirm("למחוק את הצילום מהטיוטה במכשיר? חשבוניות שכבר נשמרו לא יימחקו.")
    )
      return;
    await ctx.drafts.remove(key);
    ctx.closeModal();
  };
  if (draft.status === "running") {
    status.hidden = false;
    status.textContent =
      "יש סריקה קודמת. בדוק את תוצאתה לפני הפעלת סריקה נוספת.";
  }
  if (draft.result?.status === "completed") {
    status.hidden = false;
    status.textContent = "יש תוצאה מוכנה. לחץ על בדיקת תוצאה כדי לפתוח אותה.";
  }
  paint();
}
async function showComparison(ctx, job) {
  const month = today().slice(0, 7),
    root = ctx.dialog(
      "השוואת הדוח לחשבוניות",
      `<p>בחר את התקופה הכלולה בדוח.</p><form id="compare-form" class="filters"><label class="field"><span>חודש</span><input type="month" name="month" value="${month}" required></label><button type="submit" class="primary">השווה חשבוניות</button></form><div id="comparison"></div>`,
    );
  $("form", root).onsubmit = async (ev) => {
    ev.preventDefault();
    const button = $("button[type=submit]", root);
    button.disabled = true;
    try {
      const dates = monthRange($("input", root).value),
        result = await ctx.api.request("reconcile", {
          method: "POST",
          body: { jobId: job.id, ...dates },
        });
      $("#comparison", root).innerHTML =
        `<div class="notice"><strong>${result.matchedCount} התאמות מלאות</strong><p>אין שינוי בחשבוניות בחנות. שורה שלא נמצאה בה התאמה דורשת בדיקה.</p></div>${result.warnings.map((w) => `<p class="notice warning">${e(w)}</p>`).join("")}${result.results.map((r) => `<article class="compare-row"><strong>${e(r.row.supplierName || "ספק לא זוהה")} · ${e(r.row.documentNumber || "מספר לא זוהה")}</strong><p>${e(displayDate(r.row.invoiceDate))} · ${e(money(r.row.totalAgorot))}</p><span class="badge ${r.status === "matched" ? "paid" : "unpaid"}">${r.status === "matched" ? "נמצאה התאמה" : "לא נמצאה התאמה — דורש בדיקה"}</span>${r.candidates.map((c) => `<p>אפשרות לבדיקה: חשבונית ${e(c.documentNumber)} · ${e(displayDate(c.invoiceDate))} · ${e(money(c.totalAgorot))}</p>`).join("")}</article>`).join("")}<h3>חשבוניות מהחנות שלא הותאמו בדוח (${result.notInReport.length})</h3>${result.notInReport.map((i) => `<p>חשבונית ${e(i.documentNumber)} · ${e(money(i.totalAgorot))}</p>`).join("")}`;
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      button.disabled = false;
    }
  };
}
