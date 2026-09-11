import { $, icon, toast, errorText } from "./ui.js";
import {
  escapeHtml as e,
  money,
  displayDate,
  monthRange,
  today,
} from "./format.js";
import { invoiceForm } from "./forms.js";
import { readFile, encodeFile, decodeImage, validateFile } from "./image-upload.js";
export { readFile } from "./image-upload.js";

function imageWorker() {
  // The build supplies a content-hashed same-origin asset; source tests use the module.
  const url = new URL(typeof SCAN_WORKER_URL === "undefined" ? "./scan-worker.js" : SCAN_WORKER_URL, import.meta.url);
  const worker = new Worker(url, { type: "module" }), pending = new Map();
  let next = 0;
  const stop = () => {
    worker.terminate();
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error("Image worker stopped")); }
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    const task = pending.get(data.id);
    if (!task) return;
    clearTimeout(task.timer); pending.delete(data.id);
    if (data.error) task.reject(Error("Image processing failed"));
    else task.resolve(data.result);
  };
  worker.onerror = worker.onmessageerror = stop;
  return {
    stop,
    request(type, data = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(stop, 15000);
        pending.set(id, { resolve, reject, timer });
        try { worker.postMessage({ id, type, ...data }, data.image ? [data.image.data.buffer] : []); }
        catch { stop(); }
      });
    },
  };
}
async function pixelsFromImage(image, maxEdge = Infinity) {
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  if (!width || !height || width * height > 80_000_000) throw Error("Image too large");
  const scale = Math.min(1, maxEdge / Math.max(width, height)), canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  try {
    const pen = canvas.getContext("2d", { willReadFrequently: true });
    pen.fillStyle = "white"; pen.fillRect(0, 0, canvas.width, canvas.height);
    pen.drawImage(image, 0, 0, canvas.width, canvas.height);
    return pen.getImageData(0, 0, canvas.width, canvas.height);
  } finally { canvas.width = canvas.height = 1; }
}
async function resultBlob(result) {
  if (result.blob) return result.blob;
  const canvas = document.createElement("canvas");
  canvas.width = result.image.width; canvas.height = result.image.height;
  try {
    canvas.getContext("2d").putImageData(result.image, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .88));
    if (!blob) throw Error("Image encoding failed");
    return blob;
  } finally { canvas.width = canvas.height = 1; }
}

// The crop view is inside the existing modal: its draft, upload and Review flow
// stay mounted. This promise completes only with one chosen image or cancellation.
export function reviewPhoto(ctx, root, firstFile) {
  return new Promise(resolve => {
    const scanView = $(".scan-view", root), editor = document.createElement("section");
    editor.className = "scan-crop";
    editor.setAttribute("aria-label", "אישור צילום התעודה");
    editor.innerHTML = `<div class="crop-heading"><h3>בדיקת צילום התעודה</h3><button type="button" class="text-button" data-crop-cancel>בטל</button></div>
      <p class="small" data-crop-status role="status" aria-live="polite" aria-busy="true">משפר את התאורה ומיישר את התעודה…</p>
      <div class="crop-toolbar"><button type="button" class="text-button" data-crop-reset disabled>איפוס חיתוך</button><button type="button" class="text-button" data-crop-zoom disabled>הגדל</button></div>
      <div class="crop-source-area"><div class="crop-source" hidden>
      <img data-crop-result alt="תעודה משופרת — גרור את הפינות להתאמת החיתוך" draggable="false">
      <svg class="crop-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path fill="rgba(0,0,0,.42)" fill-rule="evenodd"></path><polygon fill="none" stroke="#7dd3fc" stroke-width="2" vector-effect="non-scaling-stroke"></polygon></svg>
      ${["שמאלית עליונה", "ימנית עליונה", "ימנית תחתונה", "שמאלית תחתונה"].map((label, i) => `<button type="button" class="crop-handle" data-crop-corner="${i}" aria-label="פינה ${label}" disabled><span></span></button>`).join("")}</div></div>
      <div class="crop-actions"><button type="button" class="primary" data-crop-accept disabled>אשר</button><button type="button" class="secondary" data-crop-retake-button>צלם שוב</button><button type="button" class="secondary" data-crop-original>ללא חיתוך</button><input data-crop-retake type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden></div>`;
    if (scanView) scanView.hidden = true;
    const modal = root.closest("dialog"), previousScroll = modal?.scrollTop || 0;
    root.classList.add("crop-modal-content"); modal?.classList.add("crop-modal");
    root.append(editor);
    if (modal) modal.scrollTop = 0;
    const status = $("[data-crop-status]", editor), resultImage = $("[data-crop-result]", editor);
    const stage = $(".crop-source", editor), accept = $("[data-crop-accept]", editor), originalButton = $("[data-crop-original]", editor);
    const reset = $("[data-crop-reset]", editor), zoom = $("[data-crop-zoom]", editor), viewport = $(".crop-source-area", editor);
    const handles = [...editor.querySelectorAll("[data-crop-corner]")], retake = $("[data-crop-retake]", editor);
    let file = firstFile, worker, resultUrl, previewBlob, basePoints;
    let points, generation = 0, revision = 0, disposed = false, ready = false, saving = false, rendering = false, dragging = null;
    const allCorners = () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const redraw = () => {
      const coords = points.map(p => `${p.x * 100},${p.y * 100}`).join(" ");
      $("polygon", stage).setAttribute("points", coords);
      $("path", stage).setAttribute("d", `M0,0 H100 V100 H0 Z M${coords.replaceAll(" ", " L")} Z`);
      handles.forEach((handle, i) => { handle.style.left = points[i].x * 100 + "%"; handle.style.top = points[i].y * 100 + "%"; });
    };
    const controls = () => {
      const disabled = !ready || saving || rendering;
      accept.disabled = reset.disabled = zoom.disabled = disabled;
      handles.forEach(handle => handle.disabled = disabled);
    };
    const release = () => {
      worker?.stop(); worker = null;
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      resultUrl = null; previewBlob = null;
      resultImage.removeAttribute("src");
    };
    const finish = value => {
      if (disposed) return;
      disposed = true; generation++; revision++;
      removalObserver.disconnect(); release(); editor.remove();
      root.classList.remove("crop-modal-content");
      if (!modal?.querySelector(".scan-crop")) modal?.classList.remove("crop-modal");
      if (scanView) scanView.hidden = false;
      if (modal?.contains(root)) modal.scrollTop = previousScroll;
      resolve(value);
    };
    // Logout or another view can detach the modal while decoding is in flight.
    const removalObserver = new MutationObserver(() => { if (!editor.isConnected) finish(null); });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    const display = async (response, session, current) => {
      const blob = await resultBlob(response);
      if (disposed || session !== generation || current !== revision) return false;
      const oldUrl = resultUrl;
      previewBlob = blob; resultUrl = URL.createObjectURL(blob); resultImage.src = resultUrl;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      await resultImage.decode();
      if (disposed || session !== generation || current !== revision) return false;
      basePoints = response.corners; points = allCorners(); redraw(); stage.hidden = false;
      return true;
    };
    const showPreview = async (resetCrop = false) => {
      if (!ready || disposed || saving || rendering) return;
      const current = ++revision, session = generation;
      rendering = true; controls();
      status.textContent = "מעדכן את החיתוך בתמונה המשופרת…";
      status.setAttribute("aria-busy", "true");
      try {
        const response = await worker.request("preview", {
          points: resetCrop ? allCorners() : points,
          basePoints: resetCrop ? allCorners() : basePoints,
        });
        if (!await display(response, session, current)) return;
        if (resetCrop) viewport.scrollTop = 0;
        status.textContent = resetCrop
          ? "כל התמונה מוצגת עם השיפור. גרור את הפינות סביב התעודה."
          : "החיתוך עודכן. בדוק שכל הטקסט בפנים, גם בתחתית התעודה.";
      } catch {
        if (!disposed && session === generation && current === revision) {
          // Never approve a crop which the user could not see successfully.
          ready = false;
          status.textContent = "לא ניתן לעדכן את החיתוך. אפשר לצלם שוב או להמשיך ללא חיתוך.";
        }
      } finally {
        if (!disposed && session === generation && current === revision) {
          rendering = false; controls(); status.setAttribute("aria-busy", "false");
        }
      }
    };
    const load = async nextFile => {
      const current = ++generation; revision++; release();
      file = nextFile; points = allCorners(); basePoints = allCorners(); ready = false; saving = false; rendering = false; dragging = null;
      originalButton.disabled = false; controls(); redraw();
      stage.hidden = true; viewport.scrollTop = 0;
      status.textContent = "משפר את התאורה ומיישר את התעודה…";
      status.setAttribute("aria-busy", "true");
      try {
        worker = imageWorker();
        let response = await worker.request("init", { file });
        if (disposed || current !== generation) return;
        if (response.needsPixels) {
          const decoded = await decodeImage(file);
          if (disposed || current !== generation) { decoded.close?.(); return; }
          let pixels;
          try { pixels = await pixelsFromImage(decoded); }
          finally { decoded.close?.(); }
          if (disposed || current !== generation) return;
          response = await worker.request("initPixels", { image: pixels });
        }
        if (disposed || current !== generation) return;
        if (!await display(response, current, revision)) return;
        ready = true; controls();
        status.setAttribute("aria-busy", "false");
        status.textContent = response.detected
          ? "גרור את הפינות לחיתוך. גלול כדי לבדוק גם את תחתית התעודה."
          : "לא זוהו גבולות. אפשר לגרור את הפינות או להמשיך ללא חיתוך.";
      } catch {
        if (!disposed && current === generation) {
          status.textContent = "העיבוד אינו זמין לצילום הזה. אפשר לצלם שוב או להמשיך ללא חיתוך.";
          status.setAttribute("aria-busy", "false");
          accept.disabled = true;
        }
      }
    };
    const move = (index, x, y) => {
      const candidate = points.map(p => ({ ...p }));
      candidate[index] = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
      // Keep handle identities and prevent crossing, concavity and collapsed crops.
      if (!candidate.every((a, i) => {
        const b = candidate[(i + 1) % 4], c = candidate[(i + 2) % 4];
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > .00005;
      })) return;
      points = candidate; revision++; redraw();
    };
    handles.forEach((handle, index) => {
      handle.onpointerdown = ev => {
        if (!ready || saving || rendering || dragging) return;
        ev.preventDefault(); dragging = { index, id: ev.pointerId }; handle.setPointerCapture(ev.pointerId);
      };
      handle.onpointermove = ev => {
        if (!dragging || dragging.id !== ev.pointerId) return;
        const rect = stage.getBoundingClientRect();
        move(index, (ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height);
      };
      handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = ev => {
        if (!dragging || dragging.id !== ev.pointerId) return;
        dragging = null;
        if (ev.type !== "pointerup") { points = allCorners(); redraw(); return; }
        if (points.some((p, i) => p.x !== allCorners()[i].x || p.y !== allCorners()[i].y)) void showPreview();
      };
      handle.onkeydown = ev => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
        if (!delta || !ready || saving || rendering) return;
        ev.preventDefault();
        const step = ev.shiftKey ? .02 : .005;
        move(index, points[index].x + delta[0] * step, points[index].y + delta[1] * step);
        void showPreview();
      };
    });
    $("[data-crop-cancel]", editor).onclick = () => finish(null);
    $("[data-crop-retake-button]", editor).onclick = () => retake.click();
    zoom.onclick = () => { if (previewBlob) ctx.previewBlob(previewBlob); };
    reset.onclick = () => void showPreview(true);
    retake.onchange = () => {
      const nextFile = retake.files[0]; retake.value = "";
      if (!nextFile) return; // Cancelling the camera preserves the current photo.
      try { validateFile(nextFile); void load(nextFile); }
      catch (error) { status.textContent = error.message; }
    };
    const save = async original => {
      // Original remains actionable during processing: terminate the worker first.
      if (disposed || (saving && !original)) return;
      if (!original && (!ready || dragging || rendering)) return;
      saving = true; controls();
      const current = ++generation; revision++;
      status.textContent = original ? "מכין את הצילום המלא…" : "מיישר ושומר את הצילום…";
      status.setAttribute("aria-busy", "true");
      if (original) { originalButton.disabled = true; worker?.stop(); }
      try {
        let value;
        if (original) value = await readFile(file);
        else {
          const response = await worker.request("process", { points: basePoints });
          value = await encodeFile(await resultBlob(response), file.name.replace(/\.[^.]+$/, "") + ".jpg");
        }
        if (!disposed && current === generation) finish(value);
      } catch {
        if (!disposed && current === generation) {
          saving = false; controls(); originalButton.disabled = false;
          status.textContent = "לא ניתן להכין את הצילום. אפשר לנסות ללא חיתוך או לצלם שוב.";
          status.setAttribute("aria-busy", "false");
        }
      }
    };
    accept.onclick = () => void save(false);
    originalButton.onclick = () => void save(true);
    void load(file);
    $("[data-crop-cancel]", editor).focus({ preventScroll: true });
  });
}

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
    `<div class="scan-view"><p>${purpose === "invoice" ? "צלם את כל העמודים של אותה חשבונית, או בחר תמונות / PDF." : "הדוח משמש להשוואה בלבד. הוא אינו מוסיף או משנה חשבוניות."}</p><div class="capture-actions"><label class="primary upload-label">${icon("camera")} צלם עמוד<input type="file" id="camera-file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden></label><label class="secondary upload-label">בחר תמונות / PDF<input type="file" id="gallery-file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden></label></div><p class="muted small">עד 8 עמודים ו־12 מגה אחרי הקטנת התמונות. בכל תמונה אפשר להתאים את החיתוך או לשמור את הצילום המלא. PDF נשאר כפי שנבחר.</p><div id="file-previews" class="file-previews"></div><div id="scan-error" class="form-error" role="alert" hidden></div><div id="scan-status" class="notice" hidden></div><div class="scan-buttons"><button class="primary" id="run-scan">סרוק ובדוק פרטים</button><button class="secondary" id="check-scan" hidden>בדוק תוצאה של סריקה קודמת</button><button class="text-button" id="new-scan" hidden>התחל סריקה חדשה</button><button class="secondary" id="manual-from-scan">המשך בהקלדה ידנית</button><button class="text-button" id="clear-scan">נקה את הצילום והטיוטה</button></div></div>`,
  );
  let busy = false;
  const persist = () => ctx.drafts.save(key, draft);
  const uploadDocuments = async () => {
    // Both AI review and manual entry must retain the selected documents.
    // Reuse persisted IDs when the upload succeeded before an interrupted step.
    if (draft.files.length && !draft.attachmentIds.length) {
      const result = await ctx.api.request("documents", {
        method: "POST",
        body: { files: draft.files },
        timeout: 50_000,
      });
      draft.attachmentIds = result.documents.map(document => document.id);
      await persist();
    }
  };
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
    $("#manual-from-scan", root).textContent = draft.files.length || draft.attachmentIds.length
      ? "המשך ידנית עם המסמכים"
      : "המשך בהקלדה ידנית";
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
        selected.forEach(validateFile);
        // Review and persist each accepted page before opening the next one.
        // Only the chosen image is retained; cancelled/retaken photos are discarded.
        for (const file of selected) {
          const prepared = file.type === "application/pdf"
            ? await readFile(file)
            : await reviewPhoto(ctx, root, file);
          if (!root.isConnected || !prepared) break;
          if ([...draft.files, prepared].reduce((n, f) => n + f.data.length * 3 / 4, 0) > 12 * 1024 * 1024)
            throw Error("הקבצים גדולים מ־12 מגה. בחר פחות עמודים.");
          draft.files.push(prepared);
          draft.attachmentIds = [];
          draft.jobId = null;
          draft.status = "editing";
          await persist();
          paint();
        }
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
      await uploadDocuments();
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
    if (busy || !root.isConnected) return;
    busy = true;
    ctx.setModalBusy(true);
    err.hidden = true;
    status.hidden = false;
    status.textContent =
      "מעלה את המסמכים להמשך ההקלדה. החשבונית תישמר רק אחרי האישור שלך.";
    paint();
    try {
      await uploadDocuments();
      if (!root.isConnected) return;
      await invoiceForm(ctx, null, null, draft.attachmentIds);
    } catch (error) {
      status.hidden = true;
      showError(error);
    } finally {
      busy = false;
      ctx.setModalBusy(false);
      if (root.isConnected) paint();
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
