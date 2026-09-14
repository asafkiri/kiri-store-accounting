import { DISPLAY_CONFIDENCE, LOCK_CONFIDENCE, polygonArea, validCorners } from "./scan-worker.js";

const HOLD_MS = 450, MAX_GAP_MS = 650, JITTER = .014;
// A hand that trembles beyond JITTER yet stays put: every detection of the
// last PATIENT_MS sits within TREMOR of their common centre, and that centre
// itself has not moved by JITTER between the first and second half.
const PATIENT_MS = 1500, TREMOR = .025, PATIENT_SAMPLES = 6;
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const midrange = values => (Math.min(...values) + Math.max(...values)) / 2;
const centre = (list, pick) => [0, 1, 2, 3].map(i => ({ x: pick(list.map(s => s.corners[i].x)), y: pick(list.map(s => s.corners[i].y)) }));

// Use elapsed time and distance in pixels, not six perfect consecutive
// detections. A single missed frame must not restart a steady hand, while
// sustained movement, a changed page, or an interruption must never capture.
export function captureStability() {
  let samples = [], patient = [], lastGood = -Infinity;
  const reset = () => { samples = []; patient = []; lastGood = -Infinity; };
  const update = (result, now, { width, height }) => {
    const reply = (state, progress = 0) => ({ state, progress });
    if (now - lastGood > MAX_GAP_MS) reset();
    if (!validCorners(result.corners) || result.confidence < DISPLAY_CONFIDENCE) return reply("none");
    if (result.borderSides > 0) { reset(); return reply("border"); }
    if (polygonArea(result.corners) < .2) { reset(); return reply("small"); }
    if (result.confidence < LOCK_CONFIDENCE) return reply("uncertain");
    const long = Math.max(width, height), sx = width / long, sy = height / long;
    const within = (a, b, limit) => a.every((p, i) => Math.hypot((p.x - b[i].x) * sx, (p.y - b[i].y) * sy) <= limit);
    const close = (a, b) => within(a, b, JITTER);
    const corners = result.corners.map(p => ({ ...p }));
    samples = samples.filter(s => now - s.time <= 1000);
    if (samples.length && !close(corners, centre(samples, median))) samples = [];
    samples.push({ corners, time: now }); lastGood = now;
    const duration = now - samples[0].time;
    // Require three independent observations even on a slow device. Current
    // corners must also agree with the oldest frame, preventing gradual drift.
    if (!close(corners, samples[0].corners)) samples = [samples.at(-1)];
    const progress = samples.length >= 3 ? Math.min(1, (now - samples[0].time) / HOLD_MS) : 0;
    if (samples.length >= 3 && duration >= HOLD_MS && progress === 1) return reply("ready", 1);
    // The patient hold. A page that drifts, or one seen only now and then,
    // never spans it; a step of the centre between the halves is movement.
    patient = patient.filter(s => now - s.time <= PATIENT_MS + MAX_GAP_MS);
    patient.push({ corners, time: now });
    if (!patient.every(s => within(s.corners, centre(patient, midrange), TREMOR))) patient = [patient.at(-1)];
    const span = now - patient[0].time, half = patient.length >> 1;
    const steady = patient.length >= PATIENT_SAMPLES && close(centre(patient.slice(0, half), midrange), centre(patient.slice(half), midrange));
    if (steady && span >= PATIENT_MS) return reply("ready", 1);
    return reply("settling", Math.max(progress, steady ? Math.min(1, span / PATIENT_MS) : 0));
  };
  return { update, reset };
}
