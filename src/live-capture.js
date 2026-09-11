import { $ } from "./ui.js";
import { imageWorker } from "./image-worker.js";
import { validateFile } from "./image-upload.js";
import { DISPLAY_CONFIDENCE, LOCK_CONFIDENCE } from "./scan-worker.js";

// Live camera view: getUserMedia inside the app, document detection on small
// frames in the worker, a polygon like the phone's own scanner, and automatic
// capture once the page holds still. The full frame is handed over as a File
// with a hint, so the review screen refines instead of re-detecting.
// Frames never leave the device and nothing is stored until the page is approved.
const DETECT_EDGE = 320, DETECT_INTERVAL = 100, POLYGON_FRAMES = 2, LOCK_FRAMES = 6, LOCK_JITTER = .015, LOCK_AREA = .2;
const MIN_LONG_EDGE = 1600, OPEN_TIMEOUT = 3000, IDLE_TIMEOUT = 90_000, HOLD_FRAMES = 3, BORDER_HINT_MS = 3000, NO_DOCUMENT_HINT_MS = 4000;
export const HINTS = {
  opening: "פותח מצלמה…",
  none: "כוון את המצלמה אל התעודה",
  small: "קרב את הטלפון לתעודה",
  border: "הרחק מעט את הטלפון, שכל התעודה תיראה במסך",
  settling: "החזק את הטלפון יציב",
  locked: "מצלם…",
  noDocument: "לא נמצאה תעודה. אפשר ללחוץ על כפתור הצילום למטה",
  borderLong: "התעודה לא נכנסת כולה? הרחק מעט את הטלפון, או לחץ על כפתור הצילום למטה ונשמור את מה שנראה",
  unavailable: "המצלמה בתוך האפליקציה לא זמינה כרגע",
  paused: "המצלמה הושהתה",
};
export const liveCameraSupported = () => Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext !== false;
// Remembered for this launch only, never persisted: once the in-app camera
// failed, the button opens the phone camera directly.
let liveCameraUnavailable = false;
export const isLiveCameraUnavailable = () => liveCameraUnavailable;
export const markLiveCameraUnavailable = () => { liveCameraUnavailable = true; };
const polygonArea = points => Math.abs(points.reduce((s, p, i) => { const q = points[(i + 1) % points.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[sorted.length >> 1]; };

export function liveCapture(ctx, root, options = {}) {
  return new Promise(resolve => {
    const scanView = $(".scan-view", root), view = document.createElement("section");
    const debug = new URLSearchParams(location.search).get("debug") === "1";
    view.className = "scan-live";
    view.setAttribute("aria-label", "צילום תעודה");
    view.innerHTML = `<div class="crop-heading"><h3>צילום תעודה</h3><button type="button" class="text-button" data-live-cancel>בטל</button></div>
      <p class="small" data-live-status role="status" aria-live="polite">${HINTS.opening}</p>
      <div class="live-stage"><div class="live-frame" data-live-frame>
        <video data-live-video playsinline autoplay muted></video>
        <canvas data-live-frozen hidden></canvas>
        <svg class="live-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon data-live-polygon points="" fill="rgba(56,132,255,.28)" stroke="#4d9cff" stroke-width="2" vector-effect="non-scaling-stroke" hidden></polygon></svg>
        <div class="live-overlay" data-live-paused hidden><p>${HINTS.paused}</p><button type="button" class="primary" data-live-resume>הקש להפעלת המצלמה</button></div>
        <div class="live-overlay" data-live-unavailable hidden><p>${HINTS.unavailable}</p><label class="primary upload-label">צלם עם מצלמת הטלפון<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" data-live-fallback hidden></label></div>
        <pre class="live-debug" data-live-debug ${debug ? "" : "hidden"}></pre>
      </div></div>
      <div class="live-actions"><label class="secondary upload-label live-phone">מצלמת הטלפון<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" data-live-phone hidden></label><button type="button" class="live-shutter" data-live-shutter aria-label="צלם" disabled><span></span></button><span class="live-actions-spacer"></span></div>
      ${options.alternatives ? '<div class="live-alternatives"><label class="text-button upload-label">בחר PDF / תמונה<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple data-live-gallery hidden></label><button type="button" class="text-button" data-live-manual>הקלד חשבונית ידנית</button></div>' : ""}`;
    if (scanView) scanView.hidden = true;
    const modal = root.closest("dialog"), previousScroll = modal?.scrollTop || 0;
    root.classList.add("crop-modal-content"); modal?.classList.add("crop-modal");
    root.append(view);
    if (modal) modal.scrollTop = 0;
    const status = $("[data-live-status]", view), video = $("[data-live-video]", view), frozen = $("[data-live-frozen]", view);
    const frame = $("[data-live-frame]", view), stage = $(".live-stage", view), polygon = $("[data-live-polygon]", view);
    const paused = $("[data-live-paused]", view), unavailable = $("[data-live-unavailable]", view), shutter = $("[data-live-shutter]", view);
    const debugBox = $("[data-live-debug]", view);
    const small = document.createElement("canvas"), smallPen = small.getContext("2d", { willReadFrequently: true });
    let worker = options.worker || null, stream = null, tracks = [], disposed = false, running = false, capturing = false;
    let inFlight = false, lastDetect = 0, frameSize = null, smoothed = null, missed = 0, shown = 0, window_ = [], wakeLock = null;
    let idleTimer = null, borderSince = 0, noneSince = 0, resolvedOnce = false, unavailableShown = false, frameLoop = null, openTimer = null;
    // start() is re-entrant only through its guards: `starting` blocks a second
    // tap while the camera opens, and release() bumps `openSession` so an
    // in-flight start() abandons a stream that was paused or disposed meanwhile.
    let starting = false, openSession = 0;
    const timings = [];
    const setStatus = text => { if (status.textContent !== text) status.textContent = text; };
    // SVG elements have no `hidden` property; the attribute drives the CSS.
    const showPolygon = visible => polygon.toggleAttribute("hidden", !visible);
    const stopFrameLoop = () => { if (frameLoop && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameLoop); else if (frameLoop) cancelAnimationFrame(frameLoop); frameLoop = null; };
    const stopTracks = () => { for (const track of tracks) { try { track.stop(); } catch { /* already ended */ } } tracks = []; stream = null; video.srcObject = null; };
    const release = () => {
      running = false; openSession++; stopFrameLoop(); stopTracks();
      clearTimeout(idleTimer); clearTimeout(openTimer); idleTimer = openTimer = null;
      small.width = small.height = 0;
      wakeLock?.release?.().catch(() => {}); wakeLock = null;
    };
    const finish = value => {
      if (resolvedOnce) return;
      resolvedOnce = true; disposed = true;
      removalObserver.disconnect(); sizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pagehide", onHide);
      release();
      frozen.width = frozen.height = 0;
      if (!value?.file && !options.keepWorker) { worker?.stop(); }
      view.remove();
      root.classList.remove("crop-modal-content");
      if (!modal?.querySelector(".scan-crop, .scan-live")) modal?.classList.remove("crop-modal");
      if (scanView) scanView.hidden = false;
      if (modal?.contains(root)) modal.scrollTop = previousScroll;
      resolve(value);
    };
    const removalObserver = new MutationObserver(() => { if (!view.isConnected) finish({ cancelled: true }); });
    const gallery = $("[data-live-gallery]", view), manual = $("[data-live-manual]", view);
    if (gallery) gallery.onchange = () => { if (gallery.files.length) finish({ files: [...gallery.files] }); };
    if (manual) manual.onclick = () => finish({ manual: true });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    const fitFrame = () => {
      const width = stage.clientWidth, height = stage.clientHeight;
      const vw = video.videoWidth || frozen.width || 3, vh = video.videoHeight || frozen.height || 4;
      if (!width || !height) return;
      // object-fit: contain, done on the wrapper so the polygon maps 1:1.
      const scale = Math.min(width / vw, height / vh);
      frame.style.width = Math.floor(vw * scale) + "px"; frame.style.height = Math.floor(vh * scale) + "px";
    };
    const sizeObserver = new ResizeObserver(fitFrame);
    sizeObserver.observe(stage);
    const showUnavailable = () => {
      release(); markLiveCameraUnavailable(); unavailableShown = true;
      unavailable.hidden = false; paused.hidden = true; showPolygon(false); shutter.disabled = true;
      setStatus(HINTS.unavailable);
    };
    const showPaused = () => {
      release(); paused.hidden = false; showPolygon(false); shutter.disabled = true;
      setStatus(HINTS.paused);
    };
    const resetTracking = () => { smoothed = null; missed = 0; shown = 0; window_ = []; showPolygon(false); borderSince = 0; noneSince = 0; };
    const updateDebug = (ms, result) => {
      if (debugBox.hidden) return;
      timings.push(ms); if (timings.length > 50) timings.shift();
      debugBox.textContent = `detect ${Math.round(ms)}ms · median ${Math.round(median(timings))}ms · confidence ${result.confidence ?? 0} · ${video.videoWidth}×${video.videoHeight}`;
    };
    const drawPolygon = points => {
      polygon.setAttribute("points", points.map(p => `${p.x * 100},${p.y * 100}`).join(" "));
      showPolygon(true);
    };
    const handleResult = result => {
      if (disposed || !running || capturing) return;
      const detected = result.corners && result.confidence >= DISPLAY_CONFIDENCE;
      const now = performance.now();
      if (!detected) {
        window_ = []; shown = 0; missed++;
        if (missed > HOLD_FRAMES) { showPolygon(false); smoothed = null; }
        borderSince = 0;
        if (!noneSince) noneSince = now;
        setStatus(now - noneSince >= NO_DOCUMENT_HINT_MS ? HINTS.noDocument : HINTS.none);
        return;
      }
      noneSince = 0; missed = 0; shown++;
      const corners = result.corners;
      const close = smoothed && corners.every((p, i) => Math.hypot(p.x - smoothed[i].x, p.y - smoothed[i].y) <= .03);
      smoothed = close ? smoothed.map((p, i) => ({ x: p.x + (corners[i].x - p.x) * .5, y: p.y + (corners[i].y - p.y) * .5 })) : corners.map(p => ({ ...p }));
      if (shown >= POLYGON_FRAMES) drawPolygon(smoothed);
      const area = polygonArea(corners);
      if (result.borderSides > 0) {
        window_ = [];
        if (!borderSince) borderSince = now;
        setStatus(now - borderSince >= BORDER_HINT_MS ? HINTS.borderLong : HINTS.border);
        return;
      }
      borderSince = 0;
      if (area < LOCK_AREA) { window_ = []; setStatus(HINTS.small); return; }
      if (result.confidence < LOCK_CONFIDENCE) { window_ = []; setStatus(HINTS.settling); return; }
      window_.push(corners);
      if (window_.length > LOCK_FRAMES) window_.shift();
      const centre = [0, 1, 2, 3].map(i => ({ x: median(window_.map(q => q[i].x)), y: median(window_.map(q => q[i].y)) }));
      const steady = window_.every(q => q.every((p, i) => Math.hypot(p.x - centre[i].x, p.y - centre[i].y) <= LOCK_JITTER));
      if (!steady) { window_ = [corners]; setStatus(HINTS.settling); return; }
      if (window_.length < LOCK_FRAMES) { setStatus(HINTS.settling); return; }
      void capture({ corners, polarity: result.polarity, frame: { width: video.videoWidth, height: video.videoHeight } });
    };
    const detectFrame = async () => {
      if (disposed || !running || capturing || inFlight || !worker) return;
      const now = performance.now();
      if (now - lastDetect < DETECT_INTERVAL) return;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      if (!frameSize || frameSize[0] !== vw || frameSize[1] !== vh) { frameSize = [vw, vh]; resetTracking(); fitFrame(); }
      const scale = Math.min(1, DETECT_EDGE / Math.max(vw, vh));
      small.width = Math.max(2, Math.round(vw * scale)); small.height = Math.max(2, Math.round(vh * scale));
      smallPen.drawImage(video, 0, 0, small.width, small.height);
      let image;
      try { image = smallPen.getImageData(0, 0, small.width, small.height); } catch { return; }
      inFlight = true; lastDetect = now;
      try {
        const result = await worker.request("detect", { image }, 5000);
        updateDebug(performance.now() - now, result);
        handleResult(result);
      } catch {
        if (!disposed && running && worker?.stopped) { worker = imageWorker(); }
      } finally { inFlight = false; }
    };
    const scheduleFrames = () => {
      const step = () => { if (disposed || !running) return; void detectFrame(); frameLoop = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(step) : requestAnimationFrame(step); };
      frameLoop = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(step) : requestAnimationFrame(step);
    };
    const captureFrame = () => new Promise((done, fail) => {
      // Grab the frame at presentation time, at the track's own resolution.
      const grab = () => {
        try {
          const vw = video.videoWidth, vh = video.videoHeight;
          const full = document.createElement("canvas"); full.width = vw; full.height = vh;
          const pen = full.getContext("2d"); pen.drawImage(video, 0, 0, vw, vh);
          full.toBlob(blob => { full.width = full.height = 0; blob ? done(blob) : fail(Error("Capture failed")); }, "image/jpeg", .92);
        } catch (error) { fail(error); }
      };
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(grab); else requestAnimationFrame(grab);
    });
    const capture = async hint => {
      if (disposed || capturing || !running) return;
      capturing = true; shutter.disabled = true; setStatus(HINTS.locked);
      if (hint) { polygon.setAttribute("fill", "rgba(56,132,255,.45)"); drawPolygon(hint.corners); }
      // Freeze what the user sees before the encoder runs.
      try {
        frozen.width = video.videoWidth; frozen.height = video.videoHeight;
        frozen.getContext("2d").drawImage(video, 0, 0); frozen.hidden = false;
      } catch { /* keep the live video visible */ }
      stopFrameLoop();
      try {
        const blob = await captureFrame();
        if (disposed) return;
        const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" });
        validateFile(file);
        const handedWorker = worker; worker = null;
        finish({ file, hint, worker: handedWorker });
      } catch {
        capturing = false; frozen.hidden = true; frozen.width = frozen.height = 0;
        polygon.setAttribute("fill", "rgba(56,132,255,.28)"); resetTracking();
        shutter.disabled = false; setStatus(HINTS.none);
        if (!disposed) scheduleFrames();
      }
    };
    const start = async () => {
      if (disposed || running || starting) return;
      starting = true;
      const session = ++openSession, current = () => !disposed && session === openSession;
      paused.hidden = true; unavailable.hidden = true; frozen.hidden = true; showPolygon(false); shutter.disabled = true;
      setStatus(HINTS.opening);
      stopTracks(); resetTracking(); frameSize = null; capturing = false;
      let media;
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 24, max: 30 } } });
      } catch { starting = false; if (current()) showUnavailable(); return; }
      // Backgrounded, paused or disposed while the permission prompt was up.
      if (!current() || document.hidden) { for (const track of media.getTracks()) track.stop(); starting = false; if (current()) showPaused(); return; }
      stream = media; tracks = media.getVideoTracks();
      video.srcObject = media;
      try {
        const ready = new Promise(done => { const settle = () => done(true); video.addEventListener("loadedmetadata", settle, { once: true }); openTimer = setTimeout(() => done(false), OPEN_TIMEOUT); });
        try { await video.play(); } catch { /* Low Power Mode or a missing gesture: the paused overlay asks for a tap */ }
        const opened = await ready;
        clearTimeout(openTimer); openTimer = null;
        if (!current()) return;
        if (!opened || !video.videoWidth) { if (video.paused && tracks.length && tracks[0].readyState === "live") showPaused(); else showUnavailable(); return; }
        if (Math.max(video.videoWidth, video.videoHeight) < MIN_LONG_EDGE) {
          // Wait for the track to renegotiate (the video reports the new size
          // with "resize") rather than a fixed delay a slow phone could miss.
          const resized = new Promise(done => { const timer = setTimeout(() => { video.removeEventListener("resize", grow); done(); }, 1500); const grow = () => { clearTimeout(timer); done(); }; video.addEventListener("resize", grow, { once: true }); });
          try { await tracks[0].applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } }); } catch { /* keep the stream as it is */ }
          await resized;
          if (!current()) return;
          if (Math.max(video.videoWidth, video.videoHeight) < MIN_LONG_EDGE) { showUnavailable(); return; }
        }
        try { await tracks[0].applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch { /* not every camera exposes focus */ }
        if (!current()) return;
        if (video.paused) { try { await video.play(); } catch { if (current()) showPaused(); return; } }
        if (!current()) return;
        for (const track of tracks) {
          track.addEventListener("ended", () => { if (!disposed && running) showPaused(); });
          track.addEventListener("mute", () => { setTimeout(() => { if (!disposed && running && track.muted) showPaused(); }, 1000); });
        }
        try { wakeLock = await navigator.wakeLock?.request?.("screen"); } catch { wakeLock = null; }
        if (!current()) { wakeLock?.release?.().catch(() => {}); wakeLock = null; return; }
        if (!worker) worker = imageWorker();
        running = true; shutter.disabled = false; fitFrame(); setStatus(HINTS.none);
        idleTimer = setTimeout(() => { if (!disposed && running && !capturing) showPaused(); }, IDLE_TIMEOUT);
        scheduleFrames();
      } catch {
        // Nothing after acquisition may leave the camera running.
        if (current()) showUnavailable();
      } finally { starting = false; }
    };
    // The tracks are released as soon as the app leaves the foreground, even
    // while the camera is still opening.
    const pauseIfActive = () => { if (!disposed && (running || starting || stream)) showPaused(); };
    const onVisibility = () => {
      if (disposed) return;
      if (document.hidden) { pauseIfActive(); return; }
      if (!paused.hidden && !unavailableShown) void start();
    };
    const onHide = pauseIfActive;
    // Playback stopping mid-session (Low Power Mode, another app taking the
    // camera) would otherwise freeze the frame loop until the idle timeout.
    video.addEventListener("pause", () => { if (!disposed && running && !capturing) showPaused(); });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    $("[data-live-cancel]", view).onclick = () => finish({ cancelled: true, unavailable: unavailableShown });
    $("[data-live-resume]", view).onclick = () => void start();
    shutter.onclick = () => void capture(null);
    for (const input of [$("[data-live-fallback]", view), $("[data-live-phone]", view)]) {
      input.onchange = () => {
        const file = input.files[0]; input.value = "";
        if (!file) return; // Cancelling the phone camera keeps the live view.
        try { validateFile(file); } catch (error) { setStatus(error.message); return; }
        release();
        finish({ file, hint: null, worker: null, unavailable: unavailableShown });
      };
      // The phone camera must not run on top of the live stream.
      input.parentElement.addEventListener("click", () => { if (running) showPaused(); });
    }
    if (!liveCameraSupported()) { showUnavailable(); }
    else void start();
    $("[data-live-cancel]", view).focus({ preventScroll: true });
  });
}
