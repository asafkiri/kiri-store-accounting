// Local document geometry and continuous-tone photographic correction. No network or OCR.
// Export the numerical functions so the real browser suite can exercise fixtures.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const fullCorners = () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
export function polygonArea(points) {
  return Math.abs(points.reduce((s, p, i) => {
    const q = points[(i + 1) % points.length];
    return s + p.x * q.y - q.x * p.y;
  }, 0)) / 2;
}
export function orderCorners(points) {
  if (points.length !== 4) throw Error("Four corners required");
  const center = points.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  const sorted = points.map(p => ({ ...p })).sort((a, b) =>
    Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  const start = sorted.reduce((best, p, i) => p.x + p.y < sorted[best].x + sorted[best].y ? i : best, 0);
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}
export function validCorners(points) {
  return Array.isArray(points) && points.length === 4 &&
    points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) &&
    points.every((p, i) => cross(p, points[(i + 1) % 4], points[(i + 2) % 4]) > 0.00005) &&
    polygonArea(points) > 0.002;
}
function grayImage(image) {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = image.data[j] * .299 + image.data[j + 1] * .587 + image.data[j + 2] * .114;
  }
  return out;
}
function gaussian3(gray, w, h) {
  const temp = new Float32Array(gray.length), out = new Float32Array(gray.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    temp[i] = (gray[y * w + Math.max(0, x - 1)] + 2 * gray[i] + gray[y * w + Math.min(w - 1, x + 1)]) / 4;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    out[i] = (temp[Math.max(0, y - 1) * w + x] + 2 * temp[i] + temp[Math.min(h - 1, y + 1) * w + x]) / 4;
  }
  return out;
}
// ---------------------------------------------------------------------------
// Document boundary detection.
// Luminance and illumination-normalised saturation gradients, each scaled by
// the frame's own noise, are accumulated along long straight lines (an
// orientation-gated Hough transform). Quadrilaterals assembled from those lines
// are scored by edge support, polarity-consistent contrast and interior
// homogeneity, and the winner's sides are refined to sub-pixel corners.
// Detection runs on a 320px copy; still photographs are then refined in narrow
// bands at their own resolution. Pure JavaScript: no DOM, no libraries.
// A fixed edge threshold cannot separate a white receipt from a beige textured
// sheet (a ~20-level step against texture of the same magnitude); noise-relative
// cues and line integrals can.
// ---------------------------------------------------------------------------
// Confidence thresholds shared with the UI: below DISPLAY_CONFIDENCE a still
// photo is treated as undetected and the live view shows no polygon; the live
// view only auto-captures at LOCK_CONFIDENCE. Measured on the reference receipt
// (confidence .9 at 320px), so LOCK = min(.6, .75 * .9) and DISPLAY = 2/3 * LOCK.
export const DISPLAY_CONFIDENCE = .4;
export const LOCK_CONFIDENCE = .6;
export const DETECT_EDGE = 320;
const VOTE_MIN = 2, HOUGH_THETA = 90, HOUGH_LINES = 10;
const DEG = Math.PI / 180;

// Area-averaged downscale for detection thumbnails: bilinear sampling would
// alias fabric texture into false edges.
export function downscaleImage(image, maxEdge) {
  const sw = image.width, sh = image.height, scale = Math.min(1, maxEdge / Math.max(sw, sh));
  if (scale >= 1) return image;
  const w = Math.max(2, Math.round(sw * scale)), h = Math.max(2, Math.round(sh * scale));
  const out = new Uint8ClampedArray(w * h * 4), src = image.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sh / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sw / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / w));
      let r = 0, g = 0, b = 0, count = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0, i = (yy * sw + x0) * 4; xx < x1; xx++, i += 4) { r += src[i]; g += src[i + 1]; b += src[i + 2]; count++; }
      const o = (y * w + x) * 4;
      out[o] = r / count; out[o + 1] = g / count; out[o + 2] = b / count; out[o + 3] = 255;
    }
  }
  return new ImageData(out, w, h);
}
function medianOf(values, n, hi, bins = 256, stride = 1) {
  const hist = new Uint32Array(bins), scale = (bins - 1) / hi;
  let counted = 0;
  for (let i = 0; i < n; i += stride) { const v = values[i]; if (!(v >= 0)) continue; let k = (v * scale) | 0; if (k >= bins) k = bins - 1; hist[k]++; counted++; }
  let acc = 0;
  for (let k = 0; k < bins; k++) { acc += hist[k]; if (acc * 2 >= counted) return k / scale; }
  return hi;
}
function blur3Into(src, out, tmp, w, h) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) tmp[row + x] = (src[row + (x ? x - 1 : 0)] + 2 * src[row + x] + src[row + (x < w - 1 ? x + 1 : x)]) * .25;
  }
  for (let y = 0; y < h; y++) {
    const up = (y ? y - 1 : 0) * w, down = (y < h - 1 ? y + 1 : y) * w, row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[down + x]) * .25;
  }
}
// Feature planes are reused between frames of the live view (no per-frame
// allocation of a dozen 320px buffers).
const planePool = new Map();
function acquirePlanes(w, h) {
  const key = w + "x" + h;
  let planes = planePool.get(key);
  if (!planes) {
    if (planePool.size >= 3) planePool.delete(planePool.keys().next().value);
    const n = w * h, make = () => new Float32Array(n);
    const rhoStep = Math.max(1, Math.round(Math.max(w, h) / 160)), rhoBins = Math.ceil(Math.hypot(w, h) / rhoStep) + 1;
    planes = { w, h, n, L0: make(), S0: make(), L: make(), S: make(), tmp: make(), tmp2: make(), gxL: make(), gyL: make(), gxS: make(), gyS: make(), mL: make(), mS: make(), W: make(),
      rhoStep, rhoBins, accumulator: new Float32Array(HOUGH_THETA * rhoBins), sigL: 1, sigS: 1, planes: true };
    planePool.set(key, planes);
  }
  return planes;
}
function computePlanes(image, P) {
  const { width: w, height: h, data } = image, n = w * h;
  const { L0, S0, L, S, tmp, tmp2, gxL, gyL, gxS, gyS, mL, mS, W } = P;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2], dr = r - g, db = b - g;
    L0[i] = .299 * r + .587 * g + .114 * b;
    S0[i] = Math.sqrt(dr * dr + db * db) * 255 / (r + g + b + 3);
  }
  // One separable 3x3 Gaussian pass for both cues.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    tmp[row] = (3 * L0[row] + L0[row + 1]) * .25; tmp2[row] = (3 * S0[row] + S0[row + 1]) * .25;
    for (let x = 1, i = row + 1; x < w - 1; x++, i++) { tmp[i] = (L0[i - 1] + 2 * L0[i] + L0[i + 1]) * .25; tmp2[i] = (S0[i - 1] + 2 * S0[i] + S0[i + 1]) * .25; }
    tmp[row + w - 1] = (L0[row + w - 2] + 3 * L0[row + w - 1]) * .25; tmp2[row + w - 1] = (S0[row + w - 2] + 3 * S0[row + w - 1]) * .25;
  }
  for (let y = 0; y < h; y++) {
    const up = (y ? y - 1 : 0) * w, down = (y < h - 1 ? y + 1 : y) * w, row = y * w;
    for (let x = 0; x < w; x++) { L[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[down + x]) * .25; S[row + x] = (tmp2[up + x] + 2 * tmp2[row + x] + tmp2[down + x]) * .25; }
  }
  for (let x = 0; x < w; x++) { gxL[x] = gyL[x] = gxS[x] = gyS[x] = mL[x] = mS[x] = 0; const b = (h - 1) * w + x; gxL[b] = gyL[b] = gxS[b] = gyS[b] = mL[b] = mS[b] = 0; }
  for (let y = 1; y < h - 1; y++) {
    const row = y * w, last = row + w - 1;
    gxL[row] = gyL[row] = gxS[row] = gyS[row] = mL[row] = mS[row] = 0; gxL[last] = gyL[last] = gxS[last] = gyS[last] = mL[last] = mS[last] = 0;
    for (let x = 1, i = row + 1; x < w - 1; x++, i++) {
      const a = (L[i + 1] - L[i - 1]) * .5, b = (L[i + w] - L[i - w]) * .5, c = (S[i + 1] - S[i - 1]) * .5, d = (S[i + w] - S[i - w]) * .5;
      gxL[i] = a; gyL[i] = b; mL[i] = Math.sqrt(a * a + b * b); gxS[i] = c; gyS[i] = d; mS[i] = Math.sqrt(c * c + d * d);
    }
  }
  // Noise scale from every fourth pixel: the median of a quarter sample is the same.
  P.sigL = Math.max(1.5, 1.4826 * medianOf(mL, n, 32, 256, 2));
  P.sigS = Math.max(.8, 1.4826 * medianOf(mS, n, 16, 256, 2));
  const invL = 1 / P.sigL, invS = 1 / P.sigS;
  for (let i = 0; i < n; i++) W[i] = Math.min(5, mL[i] * invL + mS[i] * invS);
  return P;
}
// Probe a plane set: edge weight and the directional derivatives of both cues.
function probePlanes(P, x, y, out) {
  const i = y * P.w + x;
  out[0] = P.W[i]; out[1] = P.gxL[i]; out[2] = P.gyL[i]; out[3] = P.gxS[i]; out[4] = P.gyS[i];
}
// Feature probes computed on demand from the pixels: the still-photo refinement
// touches only narrow bands around four sides, so no full-size planes are built.
function probeFeatures(image) {
  const { width: w, height: h, data } = image;
  const lum = (x, y) => { const j = (y * w + x) * 4; return .299 * data[j] + .587 * data[j + 1] + .114 * data[j + 2]; };
  const sat = (x, y) => { const j = (y * w + x) * 4, r = data[j], g = data[j + 1], b = data[j + 2], dr = r - g, db = g - b; return Math.sqrt(dr * dr + db * db) * 255 / (r + g + b + 3); };
  const blurred = (f, x, y) => {
    const x0 = x ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : x, y0 = y ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : y;
    return (f(x0, y0) + 2 * f(x, y0) + f(x1, y0) + 2 * f(x0, y) + 4 * f(x, y) + 2 * f(x1, y) + f(x0, y1) + 2 * f(x, y1) + f(x1, y1)) / 16;
  };
  const F = { w, h, sigL: 1.5, sigS: .8, planes: false, probe: null, gradients: null };
  F.gradients = (x, y, out) => {
    out[1] = (blurred(lum, x + 1, y) - blurred(lum, x - 1, y)) * .5; out[2] = (blurred(lum, x, y + 1) - blurred(lum, x, y - 1)) * .5;
    out[3] = (blurred(sat, x + 1, y) - blurred(sat, x - 1, y)) * .5; out[4] = (blurred(sat, x, y + 1) - blurred(sat, x, y - 1)) * .5;
  };
  // Noise scales from a coarse grid, like the full-plane median at 320px.
  const step = Math.max(2, Math.round(Math.max(w, h) / 48)), samplesL = [], samplesS = [], g = new Float32Array(5);
  for (let y = 2; y < h - 2; y += step) for (let x = 2; x < w - 2; x += step) {
    F.gradients(x, y, g); samplesL.push(Math.sqrt(g[1] * g[1] + g[2] * g[2])); samplesS.push(Math.sqrt(g[3] * g[3] + g[4] * g[4]));
  }
  F.sigL = Math.max(1.5, 1.4826 * medianOf(samplesL, samplesL.length, 32));
  F.sigS = Math.max(.8, 1.4826 * medianOf(samplesS, samplesS.length, 16));
  F.probe = (x, y, out) => {
    F.gradients(x, y, out);
    out[0] = Math.min(5, Math.sqrt(out[1] * out[1] + out[2] * out[2]) / F.sigL + Math.sqrt(out[3] * out[3] + out[4] * out[4]) / F.sigS);
  };
  return F;
}
const probe = (F, x, y, out) => F.planes ? probePlanes(F, x, y, out) : F.probe(x, y, out);
const intersect = (a, b) => {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.c * b.ny - b.c * a.ny) / det, y: (a.nx * b.c - b.nx * a.c) / det };
};
// Polarity-aware sub-pixel edge localisation along the normal of segment a->b.
// The normal points to the interior when the quad is traversed consistently;
// pol holds the expected sign of (inside - outside) in luminance and saturation.
function locateEdges(F, a, b, R, N, pol, minWeight) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy), nx = dy / len, ny = -dx / len;
  const values = new Float32Array(2 * R + 1), sample = new Float32Array(5), points = [];
  let hits = 0;
  for (let j = 0; j < N; j++) {
    const f = (j + .5) / N, x = a.x + dx * f, y = a.y + dy * f;
    let bestValue = 0, bestOffset = 0;
    values.fill(0);
    for (let d = -R; d <= R; d++) {
      const xx = Math.round(x + nx * d), yy = Math.round(y + ny * d);
      if (xx < 2 || xx >= F.w - 2 || yy < 2 || yy >= F.h - 2) continue;
      probe(F, xx, yy, sample);
      let v = sample[0];
      const dl = sample[1] * nx + sample[2] * ny, ds = sample[3] * nx + sample[4] * ny;
      // The saturation cue may stand in for a weak luminance step, never for a
      // clear step of the wrong sign (the outer rim of the page's own shadow).
      if (pol.lum && Math.sign(dl) !== pol.lum && (Math.abs(dl) >= 1.5 * F.sigL || !(pol.chr && Math.sign(ds) === pol.chr))) v = 0;
      if (!pol.lum && pol.chr && Math.sign(ds) !== pol.chr) v = 0;
      values[d + R] = v;
      if (v > bestValue) { bestValue = v; bestOffset = d; }
    }
    if (bestValue < minWeight) continue;
    hits++;
    if (bestOffset > -R && bestOffset < R) {
      const prev = values[bestOffset + R - 1], next = values[bestOffset + R + 1], den = prev - 2 * bestValue + next;
      if (den < 0) bestOffset += .5 * (prev - next) / den;
    }
    points.push({ x: x + nx * bestOffset, y: y + ny * bestOffset, t: f });
  }
  return { points, support: hits / N };
}
function fitLine(points) {
  const fit = list => {
    let mx = 0, my = 0;
    for (const p of list) { mx += p.x; my += p.y; }
    mx /= list.length; my /= list.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of list) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
    const angle = .5 * Math.atan2(2 * sxy, sxx - syy), dx = Math.cos(angle), dy = Math.sin(angle);
    return { nx: -dy, ny: dx, c: -dy * mx + dx * my };
  };
  let line = fit(points);
  const residual = p => Math.abs(p.x * line.nx + p.y * line.ny - line.c);
  const residuals = points.map(residual), median = [...residuals].sort((u, v) => u - v)[residuals.length >> 1];
  const kept = points.filter((p, k) => residuals[k] <= Math.max(1, 2.5 * median));
  if (kept.length >= 6) line = fit(kept);
  const after = kept.map(residual).sort((u, v) => u - v);
  return { ...line, inliers: kept.length, medianResidual: after.length ? after[after.length >> 1] : 99 };
}
const onBorder = (a, b, w, h) => (a.x < 2 && b.x < 2) || (a.y < 2 && b.y < 2) || (a.x > w - 3 && b.x > w - 3) || (a.y > h - 3 && b.y > h - 3);
// Refit each side from edge points, then intersect corner-local fits so that a
// bowed or curled edge is followed near the corners. Sides whose support falls
// below minSupport keep their input geometry.
function refineQuad(F, quad, pol, R, N, minWeight, minSupport = 0) {
  const { w, h } = F, lines = [], sidePoints = [];
  for (let s = 0; s < 4; s++) {
    const a = quad[s], b = quad[(s + 1) % 4], dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
    const base = { nx: -dy / len, ny: dx / len, c: (-dy * a.x + dx * a.y) / len };
    if (onBorder(a, b, w, h)) { lines.push({ ...base, border: true, support: 1 }); sidePoints.push(null); continue; }
    const { points, support } = locateEdges(F, a, b, R, N, pol, minWeight);
    if (points.length < 8 || support < minSupport) { lines.push({ ...base, support }); sidePoints.push(null); continue; }
    lines.push({ ...fitLine(points), support }); sidePoints.push(points);
  }
  const localLine = (s, nearEnd) => {
    const points = sidePoints[s];
    if (!points) return lines[s];
    const selected = points.filter(p => nearEnd ? p.t >= .7 : p.t <= .3);
    if (selected.length < 5) return lines[s];
    const line = fitLine(selected);
    return line.inliers >= 4 && line.medianResidual <= 2 ? line : lines[s];
  };
  const refined = [];
  for (let s = 0; s < 4; s++) {
    const p = intersect(localLine((s + 3) % 4, true), localLine(s, false));
    refined.push(p ? { x: clamp(p.x, 0, w - 1), y: clamp(p.y, 0, h - 1) } : quad[s]);
  }
  return { quad: refined, lines };
}
function refineQuadIterated(F, quad, pol, R, N, minWeight, minSupport = 0, iterations = 3) {
  let current = quad, last = null;
  for (let k = 0; k < iterations; k++) {
    last = refineQuad(F, current, pol, R, N, minWeight, minSupport);
    let moved = 0;
    for (let i = 0; i < 4; i++) moved = Math.max(moved, Math.hypot(last.quad[i].x - current[i].x, last.quad[i].y - current[i].y));
    current = last.quad;
    if (moved < .3) break;
  }
  return { quad: current, lines: last.lines };
}
// Corners must be traversed so the segment normal points inside. The winding is
// taken from the corners themselves, never from a differently ordered list.
const traversal = quad => cross(quad[0], quad[1], quad[2]) > 0 ? [...quad].reverse() : quad;
const angleBetween = (a, b) => { const d = Math.abs(a.theta - b.theta); return Math.min(d, Math.PI - d); };
function detectQuad(image, stats = null) {
  const { width: w, height: h } = image, n = w * h, long = Math.max(w, h);
  let mark = stats ? performance.now() : 0;
  const lap = name => { if (!stats) return; const now = performance.now(); stats[name] = Math.round((now - mark) * 10) / 10; mark = now; };
  const P = computePlanes(image, acquirePlanes(w, h));
  lap("features");
  const { W, gxL, gyL, gxS, gyS, mL, mS, sigL, sigS, L, S } = P;
  const R = Math.max(2, Math.round(long * .01));
  // Orientation-gated Hough transform. Only local maxima along their own
  // gradient vote, which thins texture and text strokes to their crests.
  const TH = HOUGH_THETA, dTheta = Math.PI / TH, rhoStep = P.rhoStep, RB = P.rhoBins, cx = w / 2, cy = h / 2, diag = Math.hypot(w, h);
  const cosT = P.cosT || (P.cosT = Float32Array.from({ length: TH }, (_, t) => Math.cos(t * dTheta)));
  const sinT = P.sinT || (P.sinT = Float32Array.from({ length: TH }, (_, t) => Math.sin(t * dTheta)));
  const acc = P.accumulator; acc.fill(0);
  const invRho = 1 / rhoStep, halfDiag = diag / 2, invSigL = 1 / sigL, invSigS = 1 / sigS;
  // A crest pixel on a checkerboard is plenty for lines hundreds of pixels
  // long, and halves the voting cost on a phone.
  for (let y = 2; y < h - 2; y++) for (let x = 2 + (y & 1), i = y * w + x; x < w - 2; x += 2, i += 2) {
    const weight = W[i];
    if (weight < VOTE_MIN) continue;
    const useLum = mL[i] * invSigL >= mS[i] * invSigS, gx = useLum ? gxL[i] : gxS[i], gy = useLum ? gyL[i] : gyS[i];
    if (Math.abs(gx) >= Math.abs(gy) ? (W[i - 1] > weight || W[i + 1] > weight) : (W[i - w] > weight || W[i + w] > weight)) continue;
    // Text strokes are a few pixels long; a page edge continues along its
    // tangent. Only pixels whose edge continues 2px both ways vote.
    const norm = Math.sqrt(gx * gx + gy * gy) || 1, tx = Math.round(-gy / norm * 2), ty = Math.round(gx / norm * 2);
    if (W[i + ty * w + tx] < VOTE_MIN || W[i - ty * w - tx] < VOTE_MIN) continue;
    let phi = Math.atan2(gy, gx);
    if (phi < 0) phi += Math.PI;
    if (phi >= Math.PI) phi -= Math.PI;
    const tc = Math.round(phi / dTheta), px = x - cx, py = y - cy;
    for (let dt = -2; dt <= 2; dt++) {
      const t = (tc + dt + TH) % TH, rb = Math.round((px * cosT[t] + py * sinT[t] + halfDiag) * invRho);
      if (rb >= 0 && rb < RB) acc[t * RB + rb] += weight * (1 - Math.abs(dt) * .25);
    }
  }
  lap("hough");
  // Non-maximum suppression over 5x5 (theta, rho) cells. Orientation wraps at
  // 180 degrees with rho mirrored: the neighbour of (0deg, rho) is (178deg, -rho),
  // not the unrelated cell at the same rho index.
  const peaks = [], mirror = Math.round(2 * halfDiag * invRho);
  for (let t = 0; t < TH; t++) for (let r = 1; r < RB - 1; r++) {
    const v = acc[t * RB + r];
    if (v < 6 * VOTE_MIN) continue;
    let isMax = true;
    for (let dt = -2; dt <= 2 && isMax; dt++) for (let dr = -2; dr <= 2; dr++) {
      if (!dt && !dr) continue;
      const tt = t + dt, wrapped = tt < 0 || tt >= TH, rr = wrapped ? mirror - (r + dr) : r + dr;
      if (rr < 0 || rr >= RB) continue;
      const u = acc[(wrapped ? (tt + TH) % TH : tt) * RB + rr];
      if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; }
    }
    if (isMax) peaks.push({ v, t, r });
  }
  peaks.sort((a, b) => b.v - a.v);
  const toLine = p => {
    const theta = p.t * dTheta, rho = p.r * rhoStep - diag / 2, nx = Math.cos(theta), ny = Math.sin(theta);
    return { nx, ny, c: rho + nx * cx + ny * cy, theta, border: false };
  };
  const lines = peaks.slice(0, HOUGH_LINES).map(toLine), conflictLines = peaks.slice(0, HOUGH_LINES * 2 + 4).map(toLine);
  const detectedLines = lines.length;
  lap("peaks");
  lines.push({ nx: 1, ny: 0, c: 0, theta: 0, border: true }, { nx: 1, ny: 0, c: w - 1, theta: 0, border: true },
    { nx: 0, ny: 1, c: 0, theta: Math.PI / 2, border: true }, { nx: 0, ny: 1, c: h - 1, theta: Math.PI / 2, border: true });
  // Candidate scoring helpers.
  const sample = new Float32Array(5);
  const sideStats = (a, b, N = 24) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy), nx = dy / len, ny = -dx / len;
    let hits = 0, dL = 0, dS = 0, count = 0, plus = 0, minus = 0;
    const offset = 2 * R + 2;
    for (let j = 0; j < N; j++) {
      const f = (j + .5) / N, x = a.x + dx * f, y = a.y + dy * f;
      let best = 0;
      for (let d = -R; d <= R; d++) {
        const xx = Math.round(x + nx * d), yy = Math.round(y + ny * d);
        if (xx < 2 || xx >= w - 2 || yy < 2 || yy >= h - 2) continue;
        const v = W[yy * w + xx];
        if (v > best) best = v;
      }
      if (best >= VOTE_MIN) hits++;
      const ix = Math.round(x + nx * offset), iy = Math.round(y + ny * offset), ox = Math.round(x - nx * offset), oy = Math.round(y - ny * offset);
      if (ix >= 0 && ix < w && iy >= 0 && iy < h && ox >= 0 && ox < w && oy >= 0 && oy < h) {
        dL += L[iy * w + ix] - L[oy * w + ox]; dS += S[iy * w + ix] - S[oy * w + ox]; plus += L[iy * w + ix]; minus += L[oy * w + ox]; count++;
      }
    }
    // plus/minus: mean luminance on the +normal / -normal side; which one is
    // the interior depends on the candidate's winding.
    return { support: hits / N, dL: count ? dL / count : 0, dS: count ? dS / count : 0, plus: count ? plus / count : 0, minus: count ? minus / count : 0 };
  };
  // Fraction of interior samples that look like paper: no edge, or the paper's
  // own luminance (measured just inside the sides). A dense receipt is mostly
  // print at 320px, yet the gaps between rows still carry the paper level.
  const interiorSmooth = (q, paperL = null) => {
    const tolerance = paperL === null ? 0 : Math.max(12, .12 * paperL);
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (const p of q) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    let inside = 0, smooth = 0;
    const G = 14;
    for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
      const p = { x: minX + (maxX - minX) * (gx + .5) / G, y: minY + (maxY - minY) * (gy + .5) / G };
      let sign = 0, convexInside = true;
      for (let i = 0; i < 4 && convexInside; i++) {
        const s = Math.sign(cross(q[i], q[(i + 1) % 4], p));
        if (!sign) sign = s; else if (s && s !== sign) convexInside = false;
      }
      if (!convexInside) continue;
      inside++;
      const xx = Math.round(p.x), yy = Math.round(p.y);
      if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
      const k = yy * w + xx;
      if (W[k] < VOTE_MIN || (paperL !== null && Math.abs(L[k] - paperL) <= tolerance)) smooth++;
    }
    return inside ? smooth / inside : 0;
  };
  const inFrame = p => p.x >= -2 && p.x <= w + 1 && p.y >= -2 && p.y <= h + 1;
  const signedDistance = (line, p) => line.nx * p.x + line.ny * p.y - line.c;
  const borderConflict = (sides, s, q, polarity, floors, minSupport) => {
    const border = sides[s], before = sides[(s + 3) % 4], after = sides[(s + 1) % 4], opposite = sides[(s + 2) % 4];
    const centroid = { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
    const inwardBorder = Math.sign(signedDistance(border, centroid)), inwardOpposite = Math.sign(signedDistance(opposite, centroid));
    const sameLine = (a, b) => angleBetween(a, b) < 2 * DEG && Math.abs(a.c - b.c) < 2 * R;
    for (const line of conflictLines) {
      if (sides.some(side => sameLine(side, line)) || angleBetween(line, border) > 45 * DEG) continue;
      const p1 = intersect(line, before), p2 = intersect(line, after);
      if (!p1 || !p2 || !inFrame(p1) || !inFrame(p2)) continue;
      const inside = p => Math.sign(signedDistance(border, p)) === inwardBorder && Math.abs(signedDistance(border, p)) > R &&
        Math.sign(signedDistance(opposite, p)) === inwardOpposite && Math.abs(signedDistance(opposite, p)) > R;
      if (!inside(p1) || !inside(p2)) { if (stats?.conflictTrace) stats.conflictTrace.push({ line: [Math.round(line.theta / DEG), Math.round(line.c)], skip: "outside", p1, p2 }); continue; }
      const stats2 = sideStats(p1, p2);
      if (stats?.conflictTrace) stats.conflictTrace.push({ line: [Math.round(line.theta / DEG), Math.round(line.c)], support: +stats2.support.toFixed(2), dL: Math.round(stats2.dL), dS: Math.round(stats2.dS) });
      // A line as well supported as the candidate's own weakest side counts;
      // its segment may cross background the candidate wrongly encloses.
      if (stats2.support < Math.min(.55, .85 * minSupport)) continue;
      // Text rows also run parallel to a border; only a paper edge (background
      // on the border side, paper on the interior side) disqualifies the border.
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy);
      const probeSide = { x: mid.x + dy / len, y: mid.y - dx / len };
      const orientation = Math.sign(signedDistance(border, probeSide) - signedDistance(border, mid)) === inwardBorder ? 1 : -1;
      const dL = stats2.dL * orientation, dS = stats2.dS * orientation;
      if ((polarity.lum && Math.sign(dL) === polarity.lum && Math.abs(dL) >= Math.max(6, 1.5 * sigL, .5 * floors.lum)) ||
          (polarity.chr && Math.sign(dS) === polarity.chr && Math.abs(dS) >= Math.max(3, 1.5 * sigS, .5 * floors.chr))) return true;
    }
    return false;
  };
  const minSide = .06 * long;
  let best = null, fullFrameCandidate = false;
  const rejects = stats ? (stats.rejects = { geometry: 0, support: 0, contrast: 0, border: 0, smooth: 0, scored: 0 }) : null;
  const M = lines.length, cache = new Array(M * M).fill(undefined);
  const corner = (i, j) => { const k = i * M + j; let p = cache[k]; if (p === undefined) { p = intersect(lines[i], lines[j]); p = p && inFrame(p) ? p : null; cache[k] = cache[j * M + i] = p; } return p; };
  const shoelace = (p0, p1, p2, p3) => Math.abs(p0.x * p1.y - p1.x * p0.y + p1.x * p2.y - p2.x * p1.y + p2.x * p3.y - p3.x * p2.y + p3.x * p0.y - p0.x * p3.y) / 2;
  const cornerAngle = (p0, p1, p2) => { let delta = Math.abs(Math.atan2(p0.y - p1.y, p0.x - p1.x) - Math.atan2(p2.y - p1.y, p2.x - p1.x)); if (delta > Math.PI) delta = 2 * Math.PI - delta; return delta; };
  // Opposite sides are near-parallel, adjacent sides roughly perpendicular:
  // pairing by angle skips almost all of the 4-line subsets.
  for (let a = 0; a < M; a++) for (let c = a + 1; c < M; c++) {
    if (angleBetween(lines[a], lines[c]) > 35 * DEG) continue;
    for (let b = a + 1; b < M; b++) {
      if (b === c) continue;
      const ab = angleBetween(lines[a], lines[b]);
      if (ab < 55 * DEG || ab > 125 * DEG) continue;
      const q0 = corner(a, b), q1 = corner(b, c);
      if (!q0 || !q1) continue;
      for (let d = b + 1; d < M; d++) {
        if (d === c || angleBetween(lines[b], lines[d]) > 35 * DEG) continue;
        const borders = (lines[a].border ? 1 : 0) + (lines[b].border ? 1 : 0) + (lines[c].border ? 1 : 0) + (lines[d].border ? 1 : 0);
        if (borders > 2) { if (borders === 4) fullFrameCandidate = true; continue; }
        const q2 = corner(c, d), q3 = corner(d, a);
        if (!q2 || !q3) continue;
        const s0 = Math.sign(cross(q0, q1, q2)), s1 = Math.sign(cross(q1, q2, q3)), s2 = Math.sign(cross(q2, q3, q0)), s3 = Math.sign(cross(q3, q0, q1));
        if (!s0 || s0 !== s1 || s0 !== s2 || s0 !== s3) continue;
        const area = shoelace(q0, q1, q2, q3) / n;
        if (area > .985) { fullFrameCandidate = true; continue; }
        if (area < .08) continue;
        const l0 = Math.hypot(q1.x - q0.x, q1.y - q0.y), l1 = Math.hypot(q2.x - q1.x, q2.y - q1.y), l2 = Math.hypot(q3.x - q2.x, q3.y - q2.y), l3 = Math.hypot(q0.x - q3.x, q0.y - q3.y);
        if (Math.min(l0, l1, l2, l3) < minSide) continue;
        const lo = Math.PI / 4, hi = 3 * Math.PI / 4, a0 = cornerAngle(q3, q0, q1), a1 = cornerAngle(q0, q1, q2), a2 = cornerAngle(q1, q2, q3), a3 = cornerAngle(q2, q3, q0);
        if (a0 < lo || a0 > hi || a1 < lo || a1 > hi || a2 < lo || a2 > hi || a3 < lo || a3 > hi) continue;
        const aspect = Math.max(l0 + l2, l1 + l3) / Math.min(l0 + l2, l1 + l3);
        // Long thermal receipts reach 1:12 on paper and more under keystone.
        if (aspect > 16) continue;
        const q = [q0, q1, q2, q3], sides = [lines[a], lines[b], lines[c], lines[d]], signs = [s0, s1, s2, s3];
        let minSupport = 1, paperL = 0;
        const dLs = [], dSs = [];
        for (let s = 0; s < 4 && minSupport >= .55; s++) {
          if (sides[(s + 1) % 4].border) continue;
          const stats = sideStats(q[(s + 1) % 4], q[s]);
          minSupport = Math.min(minSupport, stats.support); dLs.push(stats.dL * signs[0]); dSs.push(stats.dS * signs[0]); paperL += (signs[0] > 0 ? stats.plus : stats.minus) / (4 - borders);
        }
        if (rejects) rejects.scored++;
        const trace = stats?.trace ? { sides: [a, b, c, d], borders, area: +area.toFixed(3), minSupport: +minSupport.toFixed(2) } : null;
        if (trace) (stats.candidates ||= []).push(trace);
        if (minSupport < .55) { if (rejects) rejects.support++; continue; }
        // Polarity-consistent contrast in at least one cue, with absolute floors
        // (6 luminance levels / 3 saturation units) so text rows and grain lose.
        const lumOk = (dLs.every(v => v > 0) || dLs.every(v => v < 0)) && Math.min(...dLs.map(Math.abs)) >= Math.max(6, 1.5 * sigL);
        const chrOk = (dSs.every(v => v > 0) || dSs.every(v => v < 0)) && Math.min(...dSs.map(Math.abs)) >= Math.max(3, 1.5 * sigS);
        if (trace) Object.assign(trace, { dLs: dLs.map(v => Math.round(v)), dSs: dSs.map(v => Math.round(v)) });
        if (!lumOk && !chrOk) { if (rejects) rejects.contrast++; continue; }
        const contrast = Math.max(lumOk ? Math.min(...dLs.map(Math.abs)) / sigL : 0, chrOk ? Math.min(...dSs.map(Math.abs)) / sigS : 0);
        const polarity = { lum: lumOk ? Math.sign(dLs[0]) : 0, chr: chrOk ? Math.sign(dSs[0]) : 0 };
        // A frame border may stand in for a side only when the page really
        // leaves the frame there: a supported paper edge inside the quad means
        // the true side is visible and this candidate overshoots it.
        const floors = { lum: lumOk ? Math.min(...dLs.map(Math.abs)) : 0, chr: chrOk ? Math.min(...dSs.map(Math.abs)) : 0 };
        if (borders && sides.some((side, s) => side.border && borderConflict(sides, s, q, polarity, floors, minSupport))) { if (rejects) rejects.border++; if (trace) trace.stage = "border"; continue; }
        const smooth = interiorSmooth(q, paperL);
        if (trace) trace.smooth = +smooth.toFixed(2);
        if (smooth < .5) { if (rejects) rejects.smooth++; continue; }
        if (trace) trace.stage = "ok";
        // Sides taken from the frame carry no evidence of their own.
        const score = Math.min(1, minSupport / .8) * Math.min(1, contrast / 4) * Math.min(1, smooth / .7) * (1 - .15 * borders);
        const key = area * (.5 + score);
        if (!best || key > best.key) best = { q, key, score, borders, winding: signs[0], polarity };
      }
    }
  }
  lap("assembly");
  if (stats) stats.lines = lines.filter(l => !l.border).map(l => ({ theta: Math.round(l.theta / DEG), c: Math.round(l.c) }));
  if (!best) {
    let reason = "no-supported-quad";
    if (detectedLines < 2) reason = "no-lines";
    else if (fullFrameCandidate) {
      // A page filling the whole frame: bright and mostly blank inside.
      let sum = 0;
      for (let i = 0; i < n; i += 7) sum += L[i];
      if (sum / Math.ceil(n / 7) >= 100 && interiorSmooth([{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }]) >= .5) reason = "fills-frame";
    }
    return { corners: null, confidence: 0, reason, borderSides: 0, polarity: null };
  }
  const refined = refineQuadIterated(P, best.winding > 0 ? [...best.q].reverse() : best.q, best.polarity, Math.max(3, Math.round(long * .02)), 32, VOTE_MIN);
  lap("refine");
  const corners = orderCorners(refined.quad).map(p => ({ x: p.x / (w - 1), y: p.y / (h - 1) }));
  if (!validCorners(corners)) return { corners: null, confidence: 0, reason: "no-supported-quad", borderSides: 0, polarity: null };
  return { corners, confidence: Math.round(best.score * 100) / 100, reason: null, borderSides: best.borders, polarity: best.polarity };
}
// Refine corners found at a lower resolution (or in a video frame) against this
// image, touching only bands around the four sides. Returns null when a side
// loses its support: the caller then falls back to a fresh detection.
// sideMinSupport: a side with weaker edge support keeps its input geometry.
// requireSupport: below this on any side the whole refinement is rejected.
function refineWithHint(image, corners, polarity, sideMinSupport, requireSupport) {
  if (!validCorners(corners) || !polarity) return null;
  const { width: w, height: h } = image, long = Math.max(w, h), F = probeFeatures(image);
  const quad = corners.map(p => ({ x: p.x * (w - 1), y: p.y * (h - 1) })), ordered = traversal(quad);
  const { quad: refined, lines } = refineQuadIterated(F, ordered, polarity, Math.max(3, Math.round(long * .01)), 48, VOTE_MIN, sideMinSupport, 1);
  const support = Math.min(...lines.map(l => l.support));
  if (support < requireSupport) return null;
  // Grain or print inside the search band must not drag a corner away from
  // the estimate the whole-frame detection agreed on.
  const guarded = refined.map((p, i) => Math.hypot(p.x - ordered[i].x, p.y - ordered[i].y) <= .02 * long ? p : ordered[i]);
  const result = orderCorners(guarded).map(p => ({ x: p.x / (w - 1), y: p.y / (h - 1) }));
  return validCorners(result) ? { corners: result, support } : null;
}
export const HINT_SUPPORT = .6;
const NO_DOCUMENT = reason => ({ corners: null, confidence: 0, reason, borderSides: 0, polarity: null });
// Full detection record for any image size: {corners, confidence, reason,
// borderSides, polarity}. corners are normalised TL/TR/BR/BL or null.
export function detectDocument(image, stats = null) {
  const { width: w, height: h } = image;
  if (w < 24 || h < 24) return NO_DOCUMENT("no-lines");
  const small = Math.max(w, h) > DETECT_EDGE * 1.06 ? downscaleImage(image, DETECT_EDGE) : image;
  const result = detectQuad(small, stats);
  if (!result.corners) return result;
  if (small !== image) {
    const refined = refineWithHint(image, result.corners, result.polarity, HINT_SUPPORT, 0);
    if (refined) result.corners = refined.corners;
  }
  if (result.confidence < DISPLAY_CONFIDENCE) return NO_DOCUMENT("no-supported-quad");
  return result;
}
export function detectCorners(image) {
  return detectDocument(image).corners;
}
// Solve the eight projective coefficients with partial pivoting. h[8] = 1.
export function homography(from, to) {
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    if (Math.abs(rows[pivot][col]) < 1e-10) throw Error("Degenerate corners");
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    for (let j = col; j <= 8; j++) rows[col][j] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== col) {
      const factor = rows[row][col];
      for (let j = col; j <= 8; j++) rows[row][j] -= factor * rows[col][j];
    }
  }
  return [...rows.map(row => row[8]), 1];
}
export function projectPoint(h, p) {
  const z = h[6] * p.x + h[7] * p.y + 1;
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / z, y: (h[3] * p.x + h[4] * p.y + h[5]) / z };
}
// Handles live on the already rectified preview. Compose their coordinates back
// into the untouched source, so repeated edits never resample an earlier JPEG.
export function mapCropCorners(points, basePoints = fullCorners()) {
  if (!validCorners(points) || !validCorners(basePoints)) throw Error("Invalid corners");
  const transform = homography(fullCorners(), basePoints);
  const mapped = points.map(p => {
    const q = projectPoint(transform, p);
    return { x: clamp(q.x, 0, 1), y: clamp(q.y, 0, 1) };
  });
  if (!validCorners(mapped)) throw Error("Crop too small");
  return mapped;
}
export function imageFrame(image, points = fullCorners()) {
  if (!validCorners(points)) throw Error("Invalid corners");
  const q = points.map(p => ({ x: p.x * (image.width - 1), y: p.y * (image.height - 1) }));
  return { corners: points, width: Math.max(distance(q[0], q[1]), distance(q[3], q[2])) + 1,
    height: Math.max(distance(q[0], q[3]), distance(q[1], q[2])) + 1 };
}
export function cropFrame(points, frame) {
  // Refining an already straightened page is a rectangular crop, not another
  // perspective correction. Keep its pixel metric instead of measuring the
  // slanted source edges again (which stretched the print on each edit).
  if (!validCorners(points) || points[0].y !== points[1].y || points[1].x !== points[2].x ||
      points[2].y !== points[3].y || points[3].x !== points[0].x) throw Error("Invalid crop rectangle");
  return { corners: mapCropCorners(points, frame.corners),
    width: (frame.width - 1) * (points[1].x - points[0].x) + 1,
    height: (frame.height - 1) * (points[3].y - points[0].y) + 1 };
}
export function perspectiveFrame(points, frame) {
  // Measure in the displayed page's pixel coordinates, not the oblique camera
  // frame. Subsequent rectangular trims keep this metric through cropFrame.
  const metric = imageFrame({ width: frame.width, height: frame.height }, points);
  return { ...metric, corners: mapCropCorners(points, frame.corners) };
}
export function warpImage(image, points, maxEdge = 2500, frame = imageFrame(image, points)) {
  if (!validCorners(points)) throw Error("Invalid corners");
  const q = points.map(p => ({ x: p.x * (image.width - 1), y: p.y * (image.height - 1) }));
  const naturalWidth = frame.width, naturalHeight = frame.height;
  if (![naturalWidth, naturalHeight].every(n => Number.isFinite(n) && n >= 2)) throw Error("Invalid crop size");
  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
  const w = Math.max(2, Math.floor(naturalWidth * scale)), h = Math.max(2, Math.floor(naturalHeight * scale));
  const transform = homography([{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }], q);
  const out = new Uint8ClampedArray(w * h * 4), data = image.data, sw = image.width;
  for (let y = 0; y < h; y++) {
    let u = transform[1] * y + transform[2], v = transform[4] * y + transform[5], z = transform[7] * y + 1;
    for (let x = 0; x < w; x++, u += transform[0], v += transform[3], z += transform[6]) {
      const sx = clamp(u / z, 0, sw - 1), sy = clamp(v / z, 0, image.height - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), dx = sx - x0, dy = sy - y0;
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + Math.min(x0 + 1, sw - 1)) * 4;
      const c = (Math.min(y0 + 1, image.height - 1) * sw + x0) * 4, d = (Math.min(y0 + 1, image.height - 1) * sw + Math.min(x0 + 1, sw - 1)) * 4;
      const i = (y * w + x) * 4;
      for (let channel = 0; channel < 3; channel++) out[i + channel] =
        (data[a + channel] * (1 - dx) + data[b + channel] * dx) * (1 - dy) +
        (data[c + channel] * (1 - dx) + data[d + channel] * dx) * dy;
      out[i + 3] = 255;
    }
  }
  return new ImageData(out, w, h);
}
export function enhanceImage(image) {
  const { width: w, height: h, data } = image;
  // Estimate paper colour from the upper-middle part of each cell's histogram.
  // Unlike a maximum, these samples resist isolated glare. A broad, smooth RGB
  // field removes both lighting gradients and the warm/blue cast of the paper.
  // The histogram only estimates illumination; it never classifies output ink.
  const gridEdge = Math.min(96, Math.max(24, Math.round(Math.max(w, h) / 16)));
  const gw = Math.max(2, Math.round(w / Math.max(w, h) * gridEdge)), gh = Math.max(2, Math.round(h / Math.max(w, h) * gridEdge));
  const cells = gw * gh, counts = new Uint32Array(cells), histogram = new Uint32Array(cells * 64);
  const stride = Math.max(w, h) < 800 ? 1 : 2;
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) {
    const i = (y * w + x) * 4, lum = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
    const cell = Math.min(gh - 1, Math.floor(y * gh / h)) * gw + Math.min(gw - 1, Math.floor(x * gw / w));
    histogram[cell * 64 + (lum >> 2)]++; counts[cell]++;
  }
  const totals = counts.slice(), low = new Uint8Array(cells), high = new Uint8Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    let sum = 0, lower = false;
    for (let bin = 0; bin < 64; bin++) {
      sum += histogram[cell * 64 + bin];
      if (!lower && sum >= counts[cell] * .7) { low[cell] = bin * 4; lower = true; }
      if (sum >= counts[cell] * .9) { high[cell] = bin * 4 + 3; break; }
    }
  }
  let background = Array.from({ length: 3 }, () => new Float32Array(cells));
  const paperLevel = [...high].sort((a, b) => a - b)[Math.floor(cells * .9)];
  // With almost no recorded light there is no reliable paper/ink separation.
  if (paperLevel < 16) return image;
  counts.fill(0);
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) {
    const i = (y * w + x) * 4, lum = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
    const cell = Math.min(gh - 1, Math.floor(y * gh / h)) * gw + Math.min(gw - 1, Math.floor(x * gw / w));
    // Do not average the dark half of a mixed paper/logo cell into the paper.
    // A narrow band near the upper quantile also avoids grid-dependent halos.
    // Luminance is fractional: the bin ending at integer 99 includes 99.7.
    // Excluding that fraction left whole patches without any paper samples.
    if (lum < Math.max(low[cell], high[cell] * .94 - 3) || lum >= high[cell] + 1) continue;
    for (let c = 0; c < 3; c++) background[c][cell] += data[i + c];
    counts[cell]++;
  }
  // Learn the colour of the photographed paper. An absolute saturation limit
  // rejected white paper under blue daylight as if it were coloured printing.
  const paperSamples = [[], [], []];
  for (let cell = 0; cell < cells; cell++) {
    if (!counts[cell]) continue;
    for (let c = 0; c < 3; c++) background[c][cell] /= counts[cell];
    if (high[cell] < paperLevel * .65) continue;
    const sum = background.reduce((s, channel) => s + channel[cell], 0);
    for (let c = 0; c < 3; c++) paperSamples[c].push(background[c][cell] / Math.max(1, sum));
  }
  const paperColour = paperSamples.map(values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 1 / 3);
  // A solid logo has no trustworthy paper samples. Never substitute its dark
  // histogram value: that created a bright halo both inside and around logos.
  // Extend neighbouring paper into those cells, then smooth the illumination.
  const known = new Uint8Array(cells), candidates = new Uint8Array(cells), queue = new Int32Array(cells);
  let head = 0, tail = 0;
  for (let cell = 0; cell < cells; cell++) {
    const sum = background.reduce((s, channel) => s + channel[cell], 0);
    const coloured = background.some((channel, c) => Math.abs(channel[cell] / Math.max(1, sum) - paperColour[c]) > .11);
    if (counts[cell] < Math.max(1, totals[cell] * .08) || high[cell] < paperLevel * .3 || coloured) continue;
    candidates[cell] = 1;
    const x = cell % gw, y = Math.floor(cell / gw);
    if (high[cell] >= paperLevel * .65 || x === 0 || x === gw - 1 || y === 0 || y === gh - 1) {
      known[cell] = 1; queue[tail++] = cell;
    }
  }
  // Deep shadows that reach the page edge and gradual changes in illumination
  // are still paper. Do not jump from paper into an enclosed, solid gray logo.
  while (head < tail) {
    const cell = queue[head++], x = cell % gw, y = Math.floor(cell / gw);
    for (const n of [x > 0 ? cell - 1 : -1, x + 1 < gw ? cell + 1 : -1, y > 0 ? cell - gw : -1, y + 1 < gh ? cell + gw : -1]) {
      if (n < 0 || known[n] || !candidates[n] || Math.abs(high[n] - high[cell]) > paperLevel * .12) continue;
      known[n] = 1; queue[tail++] = n;
    }
  }
  head = 0;
  if (!tail) for (const channel of background) channel.fill(255);
  while (head < tail) {
    const cell = queue[head++], x = cell % gw, y = Math.floor(cell / gw);
    for (const neighbour of [x > 0 ? cell - 1 : -1, x + 1 < gw ? cell + 1 : -1, y > 0 ? cell - gw : -1, y + 1 < gh ? cell + gw : -1]) {
      if (neighbour < 0 || known[neighbour]) continue;
      for (let c = 0; c < 3; c++) background[c][neighbour] = background[c][cell];
      known[neighbour] = 1; queue[tail++] = neighbour;
    }
  }
  const rawBackground = background;
  background = rawBackground.map(channel => gaussian3(channel, gw, gh));
  let edgeCells = new Float32Array(cells);
  const backgroundLight = new Float32Array(cells);
  for (let i = 0; i < cells; i++) backgroundLight[i] = rawBackground[0][i] * .299 + rawBackground[1][i] * .587 + rawBackground[2][i] * .114;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let low = 255, high = 0;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(gh - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(gw - 1, x + 2); xx++) {
      const value = backgroundLight[yy * gw + xx]; low = Math.min(low, value); high = Math.max(high, value);
    }
    edgeCells[y * gw + x] = high - low > Math.max(12, high * .18) ? 1 : 0;
  }
  edgeCells = gaussian3(edgeCells, gw, gh);
  // Reuse this luminance buffer for sharpening after colour correction. Near a
  // hard shadow, it guides interpolation toward the paper on the SAME side of
  // the edge, instead of averaging sunlit paper into shadow (a dark fringe).
  const gray = grayImage(image);
  const weights = new Float32Array(16), neighbours = new Int32Array(16);
  // Expand the distance of ink from its local paper instead of brightening ink
  // along with the background. This monotone curve has a soft highlight shoulder
  // and a linear dark toe: gray strokes stay gray, with no threshold or posterize.
  // Leave highlight headroom for very pale thermal ink rather than driving its
  // local paper almost to 255 before sharpening has a chance to preserve it.
  const tone = new Float32Array(6145), paper = 247, contrast = 2.4, headroom = 255 - paper;
  for (let i = 0; i < tone.length; i++) {
    const ratio = i / 2048;
    tone[i] = ratio <= 1 ? paper * ratio / (contrast - (contrast - 1) * ratio)
      : paper + headroom * (1 - Math.exp(-(ratio - 1) * paper * contrast / headroom));
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Samples describe cell centres, not the outer edges of the whole photo.
    const gx = clamp((x + .5) * gw / w - .5, 0, gw - 1), gy = clamp((y + .5) * gh / h - .5, 0, gh - 1);
    const ix = Math.floor(gx), iy = Math.floor(gy), dx = gx - ix, dy = gy - iy;
    const ia = iy * gw + ix, ib = iy * gw + Math.min(ix + 1, gw - 1);
    const ic = Math.min(iy + 1, gh - 1) * gw + ix, id = Math.min(iy + 1, gh - 1) * gw + Math.min(ix + 1, gw - 1);
    const edgeMix = (edgeCells[ia] * (1 - dx) + edgeCells[ib] * dx) * (1 - dy) + (edgeCells[ic] * (1 - dx) + edgeCells[id] * dx) * dy;
    const i = (y * w + x) * 4;
    const originalSum = data[i] + data[i + 1] + data[i + 2];
    let castDifference = 0;
    for (let c = 0; c < 3; c++) castDifference = Math.max(castDifference, Math.abs(data[i + c] / Math.max(1, originalSum) - paperColour[c]));
    let count = 0, weightSum = 0;
    if (edgeMix > .001) {
      let guide = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        guide += gray[clamp(y + oy * 2, 0, h - 1) * w + clamp(x + ox * 2, 0, w - 1)] * (ox ? 1 : 2) * (oy ? 1 : 2) / 16;
      }
      for (let yy = Math.max(0, iy - 1); yy <= Math.min(gh - 1, iy + 2); yy++) for (let xx = Math.max(0, ix - 1); xx <= Math.min(gw - 1, ix + 2); xx++) {
        const n = yy * gw + xx, difference = (backgroundLight[n] - guide) / Math.max(12, guide * .08);
        // A compact, continuous kernel reaches zero when a sample enters or
        // leaves the neighbourhood. Changing grid cells must not make seams.
        const spatial = Math.max(0, 1 - ((xx - gx) / 2) ** 2) ** 2 * Math.max(0, 1 - ((yy - gy) / 2) ** 2) ** 2;
        const weight = spatial / (1 + difference ** 4);
        neighbours[count] = n; weights[count++] = weight; weightSum += weight;
      }
    }
    for (let channel = 0; channel < 3; channel++) {
      const grid = background[channel];
      const a = grid[ia], b = grid[ib], c = grid[ic], d = grid[id];
      let bg = (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
      if (weightSum) {
        let guided = 0;
        for (let n = 0; n < count; n++) guided += rawBackground[channel][neighbours[n]] * weights[n] / weightSum;
        bg += (guided - bg) * edgeMix;
      }
      // Dark surroundings and solid logos are not treated as white paper.
      const index = clamp(data[i + channel] * 2048 / Math.max(8, paperLevel * .15, bg), 0, tone.length - 1);
      const lower = Math.floor(index), fraction = index - lower;
      data[i + channel] = tone[lower] * (1 - fraction) + tone[Math.min(lower + 1, tone.length - 1)] * fraction;
    }
    // Paper-coloured pixels can retain a cast at hard shadow edges. Neutralize
    // that cast without changing luminance; distinct stamp/logo colours survive.
    const lum = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
    const spread = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
    const neutral = Math.max(clamp((lum - 180) / 60, 0, .75) * clamp(1 - spread / 40, 0, 1),
      clamp((.08 - castDifference) / .03, 0, 1));
    for (let channel = 0; channel < 3; channel++) data[i + channel] += (lum - data[i + channel]) * neutral;
  }
  for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4] * .299 + data[i * 4 + 1] * .587 + data[i * 4 + 2] * .114;
  const blurred = gaussian3(gray, w, h);
  for (let i = 0; i < gray.length; i++) {
    const detail = clamp((gray[i] - blurred[i]) * .4, -10, 10);
    for (let c = 0; c < 3; c++) data[i * 4 + c] += detail;
  }
  return image;
}
let original, sourcePixels, prepared, preparedKey, preparedBlob;
function bitmapPixels(bitmap, maxEdge = Infinity) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally { canvas.width = canvas.height = 1; }
}
async function output(image, retain = false) {
  if (typeof OffscreenCanvas === "undefined") return {
    image: retain ? new ImageData(new Uint8ClampedArray(image.data), image.width, image.height) : image,
  };
  const canvas = new OffscreenCanvas(image.width, image.height);
  try {
    canvas.getContext("2d").putImageData(image, 0, 0);
    return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality: .88 }) };
  } finally { canvas.width = canvas.height = 1; }
}
async function prepare(frame) {
  const key = JSON.stringify(frame);
  if (key !== preparedKey) {
    prepared = null; preparedBlob = null;
    prepared = enhanceImage(warpImage(sourcePixels, frame.corners, 2500, frame));
    preparedKey = key; preparedBlob = null;
  }
  // The displayed preview and accepted upload use the very same 2500px result.
  // In the canvas fallback, retain the pixels when transferring to the UI.
  const result = preparedBlob ? { blob: preparedBlob } : await output(prepared, true);
  if (result.blob && key === preparedKey) preparedBlob = result.blob;
  return { frame, ...result };
}
// A hint carries corners found on a video frame: {corners, polarity, frame}.
// It is trusted only when the decoded still has the same proportions as that
// frame (within 1%), and only while every side keeps its edge support.
function detectWithHint(thumbnail, hint) {
  if (!hint || !validCorners(hint.corners) || !hint.polarity || !hint.frame?.width || !hint.frame?.height) return null;
  const ratio = (thumbnail.width / thumbnail.height) / (hint.frame.width / hint.frame.height);
  if (!(Math.abs(ratio - 1) <= .01)) return null;
  const refined = refineWithHint(thumbnail, hint.corners, { lum: Math.sign(hint.polarity.lum || 0), chr: Math.sign(hint.polarity.chr || 0) }, HINT_SUPPORT, HINT_SUPPORT);
  if (!refined) return null;
  const px = refined.corners.map(p => ({ x: p.x * (thumbnail.width - 1), y: p.y * (thumbnail.height - 1) }));
  const borderSides = px.filter((p, i) => onBorder(p, px[(i + 1) % 4], thumbnail.width, thumbnail.height)).length;
  return { corners: refined.corners, confidence: Math.round(Math.min(1, refined.support) * 100) / 100, reason: null, borderSides, polarity: hint.polarity };
}
async function handle({ type, file, image, points, frame, hint }) {
  let thumbnail;
  if (type === "detect") {
    // Stateless: one small video frame in, corners out. Never touches the
    // retained photo, so the live view can share a worker with the review.
    return detectDocument(image);
  } else if (type === "init") {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return { needsPixels: true };
    original?.close(); sourcePixels = prepared = preparedKey = preparedBlob = null;
    try {
      original = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (!original.width || original.width * original.height > 80_000_000) throw Error("Image too large");
      thumbnail = bitmapPixels(original, 1000);
      // Retain at most 3000px per side, not a 12/24MP RGBA capture. The decoded
      // bitmap is transient and closed immediately; output is still <=2500px.
      sourcePixels = bitmapPixels(original, 3000);
    } catch {
      original?.close(); original = null;
      return { needsPixels: true };
    }
    original.close(); original = null;
  } else if (type === "initPixels") {
    sourcePixels = Math.max(image.width, image.height) > 3000 ? warpImage(image, fullCorners(), 3000) : image;
    prepared = preparedKey = preparedBlob = null;
    thumbnail = warpImage(sourcePixels, fullCorners(), 1000);
  } else if (type === "preview") return prepare(cropFrame(points, frame));
  else if (type === "straighten") return prepare(perspectiveFrame(points, frame));
  else if (type === "process" || type === "restore") return prepare(frame);
  else throw Error("Unknown image operation");
  const hinted = detectWithHint(thumbnail, hint), detection = hinted || detectDocument(thumbnail), corners = detection.corners;
  return { detected: Boolean(corners), confidence: detection.confidence, reason: detection.reason, borderSides: detection.borderSides,
    hintUsed: Boolean(hinted), originalFrame: imageFrame(sourcePixels),
    ...(await prepare(imageFrame(sourcePixels, corners || fullCorners()))) };
}
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = async ({ data }) => {
    try {
      const result = await handle(data);
      self.postMessage({ id: data.id, result }, result.image ? [result.image.data.buffer] : []);
    } catch {
      self.postMessage({ id: data.id, error: true });
    }
  };
}
