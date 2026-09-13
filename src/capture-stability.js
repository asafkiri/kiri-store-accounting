import { DISPLAY_CONFIDENCE, LOCK_CONFIDENCE, polygonArea, validCorners } from "./scan-worker.js";

const HOLD_MS = 450, MAX_GAP_MS = 650, JITTER = .014;
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];

// Use elapsed time and distance in pixels, not six perfect consecutive
// detections. A single missed frame must not restart a steady hand, while
// sustained movement, a changed page, or an interruption must never capture.
export function captureStability() {
  let samples = [], lastGood = -Infinity;
  const reset = () => { samples = []; lastGood = -Infinity; };
  const update = (result, now, { width, height }) => {
    const reply = (state, progress = 0) => ({ state, progress });
    if (now - lastGood > MAX_GAP_MS) reset();
    if (!validCorners(result.corners) || result.confidence < DISPLAY_CONFIDENCE) return reply("none");
    if (result.borderSides > 0) { reset(); return reply("border"); }
    if (polygonArea(result.corners) < .2) { reset(); return reply("small"); }
    if (result.confidence < LOCK_CONFIDENCE) return reply("uncertain");
    const long = Math.max(width, height), sx = width / long, sy = height / long;
    const close = (a, b) => a.every((p, i) => Math.hypot((p.x - b[i].x) * sx, (p.y - b[i].y) * sy) <= JITTER);
    const corners = result.corners.map(p => ({ ...p }));
    samples = samples.filter(s => now - s.time <= 1000);
    if (samples.length) {
      const centre = [0, 1, 2, 3].map(i => ({ x: median(samples.map(s => s.corners[i].x)), y: median(samples.map(s => s.corners[i].y)) }));
      if (!close(corners, centre)) samples = [];
    }
    samples.push({ corners, time: now }); lastGood = now;
    const duration = now - samples[0].time;
    // Require three independent observations even on a slow device. Current
    // corners must also agree with the oldest frame, preventing gradual drift.
    if (!close(corners, samples[0].corners)) samples = [samples.at(-1)];
    const progress = samples.length >= 3 ? Math.min(1, (now - samples[0].time) / HOLD_MS) : 0;
    return reply(samples.length >= 3 && duration >= HOLD_MS && progress === 1 ? "ready" : "settling", progress);
  };
  return { update, reset };
}
