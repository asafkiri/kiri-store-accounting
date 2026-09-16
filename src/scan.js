import { $, icon, errorText } from "./ui.js";
import { escapeHtml as e } from "./format.js";
import { invoiceForm } from "./forms.js";
import { hasDraftContent } from "./draft-activity.js";
import { readFile, encodeFile, decodeImage, validateFile, draftPageBlob, rotatePage } from "./image-upload.js";
import { imageWorker } from "./image-worker.js";
import { liveCapture, liveCameraSupported, isLiveCameraUnavailable } from "./live-capture.js";
import { nativeApp, nativeWrapper, scannerBlocked, scanPages, captureAccept } from "./native-bridge.js";
import { uploadScanPages } from "./scan-upload.js";
export { readFile } from "./image-upload.js";

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
// Default screen: the processed page and three actions (approve, retake, fix by
// hand). Corner handles, straightening, Back, zoom and "no crop" live behind
// "fix by hand" so the common case is a single tap.
export function reviewPhoto(ctx, root, firstFile, options = {}) {
  return new Promise(resolve => {
    const scanView = $(".scan-view", root), editor = document.createElement("section");
    editor.className = "scan-crop";
    editor.setAttribute("aria-label", "אישור צילום התעודה");
    editor.innerHTML = `<div class="crop-heading"><h3>בדיקת צילום התעודה</h3><button type="button" class="text-button" data-crop-cancel>בטל</button></div>
      <p class="small" data-crop-status role="status" aria-live="polite" aria-busy="true">משפר את התאורה ומיישר את התעודה…</p>
      <div class="crop-toolbar" hidden><button type="button" class="text-button" data-crop-undo disabled>אחורה</button><button type="button" class="text-button" data-crop-straighten aria-pressed="false" disabled>יישור פינות</button><button type="button" class="text-button" data-crop-zoom disabled>הגדל</button></div>
      <div class="crop-source-area"><div class="crop-source" hidden>
      <img data-crop-result alt="תעודה משופרת" draggable="false">
      <svg class="crop-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path fill="rgba(0,0,0,.42)" fill-rule="evenodd"></path><polygon fill="none" stroke="#7dd3fc" stroke-width="2" vector-effect="non-scaling-stroke"></polygon></svg>
      ${["שמאלית עליונה", "ימנית עליונה", "ימנית תחתונה", "שמאלית תחתונה"].map((label, i) => `<button type="button" class="crop-handle" data-crop-corner="${i}" aria-label="פינה ${label}" disabled><span></span></button>`).join("")}</div></div>
      <div class="crop-actions"><button type="button" class="primary" data-crop-accept disabled>אשר</button><button type="button" class="secondary" data-crop-retake-button>צלם שוב</button><button type="button" class="text-button crop-adjust" data-crop-adjust disabled>תקן ידנית</button><button type="button" class="secondary" data-crop-original hidden>ללא חיתוך</button><input data-crop-retake type="file" accept="${captureAccept()}" capture="environment" hidden></div>`;
    if (scanView) scanView.hidden = true;
    const modal = root.closest("dialog"), previousScroll = modal?.scrollTop || 0;
    root.classList.add("crop-modal-content"); modal?.classList.add("crop-modal");
    root.append(editor);
    if (modal) modal.scrollTop = 0;
    const status = $("[data-crop-status]", editor), resultImage = $("[data-crop-result]", editor);
    const stage = $(".crop-source", editor), accept = $("[data-crop-accept]", editor), originalButton = $("[data-crop-original]", editor);
    const undo = $("[data-crop-undo]", editor), zoom = $("[data-crop-zoom]", editor), viewport = $(".crop-source-area", editor);
    const straighten = $("[data-crop-straighten]", editor), adjust = $("[data-crop-adjust]", editor), toolbar = $(".crop-toolbar", editor);
    const handles = [...editor.querySelectorAll("[data-crop-corner]")], retake = $("[data-crop-retake]", editor);
    let file = firstFile, worker, resultUrl, originalUrl, previewBlob, frame, hint = options.hint || null;
    // Only crop geometry, never another photo-sized pixel buffer.
    let history = [];
    let points, generation = 0, revision = 0, disposed = false, ready = false, saving = false, rendering = false, dragging = null;
    let straightening = false, adjusting = false, failed = false, detected = false, entry = null;
    const allCorners = () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const RESULT_TEXT = { detected: "בדוק שכל התעודה נראית ולחץ אשר.", undetected: "לא נמצאו גבולות ברורים. אפשר לאשר כך או ללחוץ ״תקן ידנית״." };
    const fitPreview = () => {
      if (disposed || !resultImage.naturalWidth || !resultImage.naturalHeight) return;
      // Fit BOTH dimensions. A width-only fit enlarged long receipts after
      // trimming their sides and hid the bottom behind a scrolling viewport.
      // Padding reserves space for the full touch targets around all corners.
      const style = getComputedStyle(viewport);
      const width = Math.max(1, viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      const height = Math.max(1, viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
      const scale = Math.min(width / resultImage.naturalWidth, height / resultImage.naturalHeight);
      stage.style.width = resultImage.naturalWidth * scale + "px";
      stage.style.height = resultImage.naturalHeight * scale + "px";
      viewport.scrollTop = viewport.scrollLeft = 0;
    };
    // Status wrapping, rotation and browser chrome can all change the space
    // available to the photo. Observe that space, not the image being resized.
    const sizeObserver = new ResizeObserver(fitPreview);
    sizeObserver.observe(viewport);
    const redraw = () => {
      const coords = points.map(p => `${p.x * 100},${p.y * 100}`).join(" ");
      $("polygon", stage).setAttribute("points", coords);
      $("path", stage).setAttribute("d", `M0,0 H100 V100 H0 Z M${coords.replaceAll(" ", " L")} Z`);
      handles.forEach((handle, i) => { handle.style.left = points[i].x * 100 + "%"; handle.style.top = points[i].y * 100 + "%"; });
    };
    const controls = () => {
      const disabled = !ready || saving || rendering;
      const busy = disabled || Boolean(dragging);
      // After a processing failure, approving keeps the photo as it is.
      accept.disabled = failed ? saving : busy;
      zoom.disabled = straighten.disabled = busy;
      undo.disabled = busy || (!straightening && !history.length);
      adjust.disabled = busy || failed; adjust.hidden = adjusting;
      originalButton.hidden = !adjusting; toolbar.hidden = !adjusting;
      editor.classList.toggle("adjusting", adjusting);
      accept.textContent = straightening ? "הצג יישור" : "אשר";
      straighten.textContent = straightening ? "בטל יישור" : "יישור פינות";
      straighten.setAttribute("aria-pressed", String(straightening));
      handles.forEach(handle => handle.disabled = disabled);
    };
    const release = () => {
      if (!options.worker || worker !== options.worker) worker?.stop();
      worker = null;
      if (resultUrl) URL.revokeObjectURL(resultUrl);
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      resultUrl = originalUrl = null; previewBlob = null;
      resultImage.removeAttribute("src"); resultImage.classList.remove("processing");
    };
    const finish = value => {
      if (disposed) return;
      disposed = true; generation++; revision++;
      removalObserver.disconnect(); sizeObserver.disconnect(); release(); options.worker?.stop(); editor.remove();
      root.classList.remove("crop-modal-content");
      if (!modal?.querySelector(".scan-crop")) modal?.classList.remove("crop-modal");
      if (scanView) scanView.hidden = false;
      if (modal?.contains(root)) modal.scrollTop = previousScroll;
      resolve(value);
    };
    // Logout or another view can detach the modal while decoding is in flight.
    const removalObserver = new MutationObserver(() => { if (!editor.isConnected) finish(null); });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    const showOriginal = async (session, dimmed) => {
      // The photo itself stays on screen while the worker straightens it, and
      // remains the fallback when processing is unavailable.
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      originalUrl = URL.createObjectURL(file); resultImage.src = originalUrl;
      resultImage.classList.toggle("processing", dimmed);
      try { await resultImage.decode(); } catch { return; }
      if (disposed || session !== generation || resultImage.src !== originalUrl) return;
      stage.hidden = false; fitPreview();
    };
    const display = async (response, session, current) => {
      const blob = await resultBlob(response);
      if (disposed || session !== generation || current !== revision) return false;
      const oldUrl = resultUrl;
      previewBlob = blob; resultUrl = URL.createObjectURL(blob); resultImage.src = resultUrl;
      resultImage.classList.remove("processing");
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      await resultImage.decode();
      if (disposed || session !== generation || current !== revision) return false;
      frame = response.frame; points = allCorners(); redraw(); stage.hidden = false;
      fitPreview();
      return true;
    };
    const showPreview = async (back = false, perspective = false, target = null) => {
      if (!ready || disposed || saving || rendering || dragging || (back && !history.length)) return false;
      const current = ++revision, session = generation;
      const previous = { frame }, restored = back ? history.at(-1) : null;
      rendering = true; controls();
      status.textContent = "מעדכן את החיתוך בתמונה המשופרת…";
      status.setAttribute("aria-busy", "true");
      let shown = false;
      try {
        const response = target ? await worker.request("restore", { frame: target })
          : back ? await worker.request("restore", { frame: restored.frame })
          : await worker.request(perspective ? "straighten" : "preview", { points, frame });
        if (!await display(response, session, current)) return false;
        shown = true; straightening = false;
        if (target) return true;
        if (back) history.pop();
        else history.push(previous);
        status.textContent = back
          ? "חזרנו צעד אחורה. אפשר להתאים שוב את החיתוך."
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
          fitPreview();
        }
      }
      return shown;
    };
    const load = async nextFile => {
      const current = ++generation; revision++; release();
      file = nextFile; points = allCorners(); frame = null; history = []; ready = false; saving = false; rendering = false; dragging = null;
      straightening = false; adjusting = false; failed = false; detected = false; entry = null;
      originalButton.disabled = false; controls(); redraw();
      stage.hidden = true; viewport.scrollTop = 0;
      status.textContent = "משפר את התאורה ומיישר את התעודה…";
      status.setAttribute("aria-busy", "true");
      void showOriginal(current, true);
      try {
        worker = options.worker && current === 1 ? options.worker : imageWorker();
        const useHint = current === 1 ? hint : null;
        let response = await worker.request("init", useHint ? { file, hint: useHint } : { file });
        if (disposed || current !== generation) return;
        if (response.needsPixels) {
          const decoded = await decodeImage(file);
          if (disposed || current !== generation) { decoded.close?.(); return; }
          let pixels;
          try { pixels = await pixelsFromImage(decoded, 3000); }
          finally { decoded.close?.(); }
          if (disposed || current !== generation) return;
          response = await worker.request("initPixels", useHint ? { image: pixels, hint: useHint } : { image: pixels });
        }
        if (disposed || current !== generation) return;
        if (!await display(response, current, revision)) return;
        // The automatic crop is also one reversible step, so a missed edge can
        // be recovered with the same Back button as any manual edit.
        if (response.detected) history.push({ frame: response.originalFrame });
        detected = Boolean(response.detected);
        ready = true; controls();
        status.setAttribute("aria-busy", "false");
        status.textContent = detected ? RESULT_TEXT.detected : RESULT_TEXT.undetected;
        fitPreview();
      } catch {
        if (!disposed && current === generation) {
          failed = true; ready = false;
          resultImage.classList.remove("processing");
          status.textContent = "העיבוד לא הצליח בצילום הזה. אפשר לשמור אותו כמו שהוא או לצלם שוב.";
          status.setAttribute("aria-busy", "false");
          controls();
        }
      }
    };
    const move = (index, x, y) => {
      if (straightening) {
        const next = points.map((point, i) => i === index ? { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) } : point);
        // Keep a convex, clockwise quadrilateral; crossed handles cannot be
        // submitted to the worker. Wait for explicit Apply to move all corners.
        if (next.some((a, i) => {
          const b = next[(i + 1) % 4], c = next[(i + 2) % 4];
          return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) <= .003;
        }) || (next[index].x === points[index].x && next[index].y === points[index].y)) return false;
        points = next; revision++; redraw(); return true;
      }
      const opposite = points[(index + 2) % 4], leftCorner = index === 0 || index === 3, topCorner = index < 2;
      const xx = Math.max(leftCorner ? 0 : opposite.x + .02, Math.min(leftCorner ? opposite.x - .02 : 1, x));
      const yy = Math.max(topCorner ? 0 : opposite.y + .02, Math.min(topCorner ? opposite.y - .02 : 1, y));
      const left = leftCorner ? xx : opposite.x, right = leftCorner ? opposite.x : xx;
      const top = topCorner ? yy : opposite.y, bottom = topCorner ? opposite.y : yy;
      if ((right - left) * (bottom - top) < .003 || (points[index].x === xx && points[index].y === yy)) return false;
      // Move the two adjacent edges together. Independent corners re-warped and
      // stretched the already straightened text instead of simply trimming it.
      points = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
      revision++; redraw(); return true;
    };
    handles.forEach((handle, index) => {
      handle.onpointerdown = ev => {
        if (!ready || !adjusting || saving || rendering || dragging) return;
        ev.preventDefault(); dragging = { index, id: ev.pointerId, points: points.map(p => ({ ...p })) }; handle.setPointerCapture(ev.pointerId); controls();
      };
      handle.onpointermove = ev => {
        if (!dragging || dragging.id !== ev.pointerId) return;
        const rect = stage.getBoundingClientRect();
        move(index, (ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height);
      };
      handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = ev => {
        if (!dragging || dragging.id !== ev.pointerId) return;
        const previous = dragging.points; dragging = null;
        controls();
        if (ev.type !== "pointerup") { points = previous; redraw(); return; }
        if (straightening) return;
        if (points.some((p, i) => p.x !== allCorners()[i].x || p.y !== allCorners()[i].y)) void showPreview();
      };
      handle.onkeydown = ev => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
        if (!delta || !ready || !adjusting || saving || rendering || dragging) return;
        ev.preventDefault();
        const step = ev.shiftKey ? .02 : .005;
        if (move(index, points[index].x + delta[0] * step, points[index].y + delta[1] * step) && !straightening) void showPreview();
      };
    });
    const cancelStraightening = () => {
      straightening = false; points = allCorners(); redraw(); controls();
      status.textContent = "כל התעודה מוצגת. גרור את הפינות לחיתוך מלבני.";
    };
    const enterAdjust = () => {
      if (!ready || adjusting || failed || saving || rendering || dragging) return;
      adjusting = true; entry = { frame, historyLength: history.length };
      controls(); fitPreview();
      status.textContent = "גרור את הפינות לחיתוך מלבני, או בחר ״יישור פינות״ ליישור לפי ארבע פינות.";
      $("[data-crop-corner=\"0\"]", editor).focus({ preventScroll: true });
    };
    // Leaving the manual screen restores exactly what was shown before entering.
    const leaveAdjust = async () => {
      if (!adjusting || saving || rendering || dragging) return;
      if (straightening) cancelStraightening();
      if (entry && frame !== entry.frame && !await showPreview(false, false, entry.frame)) return;
      if (entry) history.length = Math.min(history.length, entry.historyLength);
      adjusting = false; entry = null; controls();
      status.textContent = detected ? RESULT_TEXT.detected : RESULT_TEXT.undetected;
      status.setAttribute("aria-busy", "false");
      fitPreview();
    };
    $("[data-crop-cancel]", editor).onclick = () => { if (adjusting) void leaveAdjust(); else finish(null); };
    $("[data-crop-retake-button]", editor).onclick = () => {
      if (options.onRetake) { finish({ retake: true }); return; }
      retake.click();
    };
    zoom.onclick = () => { if (previewBlob) ctx.previewBlob(previewBlob); };
    adjust.onclick = enterAdjust;
    straighten.onclick = () => {
      if (!ready || !adjusting || saving || rendering || dragging) return;
      if (straightening) { cancelStraightening(); return; }
      straightening = true; controls();
      status.textContent = "גרור כל פינה לקצה הנייר, ואז לחץ ״הצג יישור״.";
    };
    undo.onclick = () => { if (straightening) cancelStraightening(); else void showPreview(true); };
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
      if (!original && straightening) { await showPreview(false, true); return; }
      saving = true; controls();
      const current = ++generation; revision++;
      status.textContent = original ? "מכין את הצילום המלא…" : "מיישר ושומר את הצילום…";
      status.setAttribute("aria-busy", "true");
      if (original) { originalButton.disabled = true; worker?.stop(); }
      try {
        let value;
        if (original) value = await readFile(file);
        else {
          const response = await worker.request("process", { frame });
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
    accept.onclick = () => void save(failed);
    originalButton.onclick = () => void save(true);
    void load(file);
    $("[data-crop-cancel]", editor).focus({ preventScroll: true });
  });
}

// The photograph is the record for the accountant; the details are typed from
// the paper right after it. Nothing here reads the document.
export async function scanDialog(ctx, options = {}) {
  const key = "scan";
  let draft = (await ctx.drafts.load(key)) || { files: [], attachmentIds: [] };
  const root = ctx.dialog(
    "צילום חשבונית",
    `<div class="scan-view"><p>צלם את החשבונית. אם יש לה עוד עמודים, הוסף גם אותם; אחר כך ממלאים את הפרטים מהנייר.</p><div class="capture-actions"><label class="primary upload-label">${icon("camera")} צלם עמוד<input type="file" id="camera-file" accept="${captureAccept()}" capture="environment" hidden></label><label class="secondary upload-label">בחר תמונות / PDF<input type="file" id="gallery-file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple hidden></label></div><p class="muted small">עד 8 קבצים לאותה חשבונית. אפשר להגדיל כל צילום לפני שממשיכים.</p><div id="file-previews" class="file-previews"></div><div id="scan-error" class="form-error" role="alert" hidden></div><div id="scan-status" class="notice" hidden></div><div class="scan-buttons"><button class="primary" id="fill-details">המשך למילוי הפרטים</button><button class="text-button" id="clear-scan">נקה את הצילום והטיוטה</button></div></div>`,
  );
  let busy = false;
  const persist = () => hasDraftContent(key, draft) ? ctx.drafts.save(key, draft) : ctx.drafts.remove(key);
  const err = $("#scan-error", root),
    status = $("#scan-status", root);
  const showError = (error) => {
    err.hidden = false;
    err.textContent = errorText(error);
  };
  const paint = () => {
    const locked = busy;
    for (const input of root.querySelectorAll("input[type=file]"))
      input.disabled = locked;
    $("#clear-scan", root).disabled = busy;
    $("#clear-scan", root).hidden = !hasDraftContent(key, draft);
    $("#fill-details", root).disabled = busy;
    $("#fill-details", root).textContent = draft.files.length || draft.attachmentIds.length
      ? "המשך למילוי הפרטים"
      : "מלא פרטים בלי צילום";
    $("#file-previews", root).innerHTML = draft.files
      .map(
        (f, i) =>
          `<article class="file-preview">${f.mime === "application/pdf" ? `<div class="pdf-preview">${icon("invoice")}<strong>PDF</strong><small>כל העמודים בקובץ ייקראו</small></div>` : `<img src="data:${e(f.mime)};base64,${e(f.data)}" alt="תצוגת עמוד ${i + 1}">`}<div><span>${e(f.name)}</span><button type="button" class="text-button" data-preview-file="${i}">הגדל</button>${f.mime === "application/pdf" ? "" : `<button type="button" class="text-button" data-rotate-file="${i}" ${locked ? "disabled" : ""}>${icon("refresh")} סובב</button>`}<button type="button" class="text-button danger" data-remove-file="${i}" ${locked ? "disabled" : ""}>הסר / צלם מחדש</button></div></article>`,
      )
      .join("");
  };
  // The phone's scanner keeps the page as the camera saw it, so a page that
  // came out upside down is turned here instead of photographed again.
  const turnPage = async index => {
    busy = true;
    ctx.setModalBusy(true);
    paint();
    try {
      draft.files[index] = await rotatePage(draft.files[index]);
      draft.attachmentIds = [];
      await persist();
      return draftPageBlob(draft.files[index]);
    } finally {
      busy = false;
      ctx.setModalBusy(false);
      if (root.isConnected) paint();
    }
  };
  // One accepted page enters the draft the same way from every capture path.
  const acceptPage = async prepared => {
    if ([...draft.files, prepared].reduce((n, f) => n + f.data.length * 3 / 4, 0) > 12 * 1024 * 1024)
      throw Error("הקבצים גדולים מ־12 מגה. בחר פחות עמודים.");
    draft.files.push(prepared);
    draft.attachmentIds = [];
    await persist();
    paint();
  };
  const acceptFiles = async selected => {
    if (selected.length + draft.files.length > 8)
      throw Error("ניתן לבחור עד 8 קבצים ועד 12 מגה בסך הכול.");
    selected.forEach(validateFile);
    for (const file of selected) {
      const prepared = file.type === "application/pdf" ? await readFile(file) : await reviewPhoto(ctx, root, file);
      if (!root.isConnected || !prepared) break;
      await acceptPage(prepared);
    }
  };
  for (const input of root.querySelectorAll(".scan-view input[type=file]"))
    input.onchange = async () => {
      if (busy) return;
      busy = true;
      ctx.setModalBusy(true);
      paint();
      err.hidden = true;
      try {
        await acceptFiles([...input.files]);
      } catch (error) {
        showError(error);
      } finally {
        input.value = "";
        busy = false;
        ctx.setModalBusy(false);
        if (root.isConnected) paint();
      }
    };
  // "Take a page" opens the in-app camera when it is available; otherwise the
  // label activates the phone camera natively (no scripted input.click()).
  const cameraInput = $("#camera-file", root);
  const captureLive = async () => {
    if (busy) return;
    busy = true;
    ctx.setModalBusy(true);
    paint();
    err.hidden = true;
    let result;
    try {
      if (draft.files.length >= 8) throw Error("ניתן לבחור עד 8 קבצים ועד 12 מגה בסך הכול.");
      result = await liveCapture(ctx, root, { alternatives: true });
      if (result?.files) await acceptFiles(result.files);
      while (root.isConnected && result?.file) {
        const prepared = await reviewPhoto(ctx, root, result.file, { worker: result.worker, hint: result.hint, onRetake: !result.unavailable });
        if (!root.isConnected) break;
        if (prepared?.retake) { result = await liveCapture(ctx, root); continue; }
        if (prepared) await acceptPage(prepared);
        break;
      }
      if (root.isConnected && result?.unavailable && !result.file) {
        status.hidden = false;
        status.textContent = "המצלמה בתוך האפליקציה לא זמינה בדפדפן הזה. לחיצה על ״צלם עמוד״ פותחת את מצלמת הטלפון.";
      }
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      ctx.setModalBusy(false);
      if (root.isConnected) paint();
    }
    if (root.isConnected && result?.manual) $("#fill-details", root).click();
  };
  // In the Android app the phone's own document scanner takes the page: it
  // finds the borders, straightens and cleans it, and returns it ready. Its
  // result needs no review screen, only the same draft the other paths fill.
  const captureNative = async () => {
    if (busy) return;
    // A phone whose scanner cannot open says why, once, and the camera inside
    // the app takes the page instead of a tap that seems to do nothing.
    const blocked = await scannerBlocked();
    if (blocked) {
      status.hidden = false;
      status.textContent = `הסורק של הטלפון לא זמין · ${blocked}. הצילום ייעשה במצלמה שבתוך האפליקציה.`;
      return captureLive();
    }
    busy = true;
    ctx.setModalBusy(true);
    paint();
    err.hidden = true;
    try {
      const room = 8 - draft.files.length;
      if (room <= 0) throw Error("ניתן לבחור עד 8 קבצים ועד 12 מגה בסך הכול.");
      for (const page of await scanPages(room)) await acceptPage(page);
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      ctx.setModalBusy(false);
      if (root.isConnected) paint();
    }
  };
  cameraInput.closest("label").addEventListener("click", ev => {
    if (busy || cameraInput.disabled) return;
    // Inside the wrapper the tap is taken here even when the bridge is missing:
    // captureNative says what is wrong before handing the page to the camera.
    if (nativeApp() || nativeWrapper()) {
      ev.preventDefault();
      void captureNative();
      return;
    }
    if (!liveCameraSupported() || isLiveCameraUnavailable()) return;
    ev.preventDefault();
    void captureLive();
  });
  root.addEventListener("click", async (ev) => {
    const remove = ev.target.closest("[data-remove-file]"),
      preview = ev.target.closest("[data-preview-file]"),
      rotate = ev.target.closest("[data-rotate-file]");
    if (rotate) {
      if (busy) return;
      err.hidden = true;
      try {
        await turnPage(Number(rotate.dataset.rotateFile));
      } catch (error) {
        showError(error);
      }
      return;
    }
    if (remove) {
      if (busy) return;
      draft.files.splice(Number(remove.dataset.removeFile), 1);
      draft.attachmentIds = [];
      try {
        await persist();
        paint();
      } catch (error) {
        showError(error);
      }
    }
    if (preview) {
      const index = Number(preview.dataset.previewFile), shown = draft.files[index];
      // Turning is offered at full size as well: a thumbnail of a long receipt
      // does not show which end is up, which is exactly when it is needed.
      ctx.previewBlob(draftPageBlob(shown), shown.mime === "application/pdf" ? {} : { onRotate: () => (busy ? null : turnPage(index)) });
    }
  });
  // The questions open at once and the photograph goes up behind them: typing
  // five details from the paper takes far longer than the upload, so the wait
  // is spent on work instead of on a spinner. The save is what waits for the
  // pages, and a failed upload is retried from there. Nothing is read.
  $("#fill-details", root).onclick = async () => {
    if (busy || !root.isConnected) return;
    busy = true;
    ctx.setModalBusy(true);
    err.hidden = true;
    paint();
    try {
      if (draft.files.length && !draft.attachmentIds.length)
        void uploadScanPages(ctx, draft).catch(() => {});
      await invoiceForm(ctx, null, draft.attachmentIds, {
        quick: true,
        fromScan: draft.files.length > 0,
        supplier: options.supplier || null,
      });
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
  paint();
  if (options.openCamera && !hasDraftContent(key, draft)) void captureLive();
}
