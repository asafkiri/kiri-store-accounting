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
function hull(points) {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const lower = [], upper = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
// Maximum-area quadrilateral of the convex hull. For each diagonal, the two
// largest triangles can be chosen independently (O(n^3), on the small hull).
// Removing tiny triangles greedily can shave the ends off a narrow receipt.
// Curved contours still fail the retained-area/edge-support checks below.
function quadrilateral(contour) {
  let best = [], largest = 0;
  for (let a = 0; a < contour.length - 3; a++) for (let c = a + 2; c < contour.length - 1; c++) {
    let b = a + 1, d = c + 1, first = 0, second = 0;
    for (let i = a + 1; i < c; i++) {
      const area = cross(contour[a], contour[i], contour[c]);
      if (area > first) { first = area; b = i; }
    }
    for (let i = c + 1; i < contour.length; i++) {
      const area = cross(contour[a], contour[c], contour[i]);
      if (area > second) { second = area; d = i; }
    }
    if (first + second > largest) { largest = first + second; best = [contour[a], contour[b], contour[c], contour[d]]; }
  }
  return best;
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
export function detectCorners(image) {
  const { width: w, height: h } = image;
  if (w < 24 || h < 24) return null;
  const gray = grayImage(image), blurred = gaussian3(gray, w, h);
  const edge = new Uint8Array(w * h), connected = new Uint8Array(w * h);
  // The edge mask is detection-only. It never becomes the uploaded image.
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -blurred[i - w - 1] + blurred[i - w + 1] - 2 * blurred[i - 1] + 2 * blurred[i + 1] - blurred[i + w - 1] + blurred[i + w + 1];
    const gy = -blurred[i - w - 1] - 2 * blurred[i - w] - blurred[i - w + 1] + blurred[i + w - 1] + 2 * blurred[i + w] + blurred[i + w + 1];
    if (gx * gx + gy * gy > 90 * 90) edge[i] = 1;
  }
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    if (!edge[i]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) connected[i + dy * w + dx] = 1;
  }
  const queue = new Int32Array(w * h);
  let best = null, largest = 0;
  for (let seed = 0; seed < connected.length; seed++) {
    if (!connected[seed]) continue;
    let head = 0, tail = 1;
    queue[0] = seed; connected[seed] = 0;
    while (head < tail) {
      const i = queue[head++], x = i % w;
      for (const n of [x ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (n >= 0 && n < connected.length && connected[n]) {
          connected[n] = 0; queue[tail++] = n;
        }
      }
    }
    if (tail < Math.max(w, h)) continue;
    const left = new Int32Array(h).fill(w), right = new Int32Array(h).fill(-1);
    for (let j = 0; j < tail; j++) {
      const y = Math.floor(queue[j] / w), x = queue[j] % w;
      left[y] = Math.min(left[y], x); right[y] = Math.max(right[y], x);
    }
    const boundary = [];
    for (let y = 0; y < h; y++) if (right[y] >= 0) boundary.push({ x: left[y], y }, { x: right[y], y });
    const contour = hull(boundary), q = quadrilateral(contour), area = polygonArea(q);
    if (q.length !== 4 || area < .2 * w * h || area <= largest || area < .92 * polygonArea(contour)) continue;
    const ordered = orderCorners(q);
    if (ordered.some((p, i) => distance(p, ordered[(i + 1) % 4]) < 12)) continue;
    // Reject an image frame, curved object or a contour with unsupported sides.
    let supported = 0, contrast = 0, samples = 0;
    for (let side = 0; side < 4; side++) {
      const a = ordered[side], b = ordered[(side + 1) % 4], len = distance(a, b);
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      let hits = 0;
      for (let j = 1; j <= 24; j++) {
        const x = a.x + (b.x - a.x) * j / 25, y = a.y + (b.y - a.y) * j / 25;
        let found = false;
        for (let d = -5; d <= 5; d++) {
          const xx = Math.round(x + nx * d), yy = Math.round(y + ny * d);
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && edge[yy * w + xx]) found = true;
        }
        if (found) hits++;
        const ix = Math.round(x + nx * 8), iy = Math.round(y + ny * 8), ox = Math.round(x - nx * 8), oy = Math.round(y - ny * 8);
        if ([ix, ox].every(v => v >= 0 && v < w) && [iy, oy].every(v => v >= 0 && v < h)) {
          contrast += gray[iy * w + ix] - gray[oy * w + ox]; samples++;
        }
      }
      if (hits >= 16) supported++;
    }
    if (supported !== 4 || !samples || contrast / samples < 10) continue;
    best = ordered.map(p => ({ x: p.x / (w - 1), y: p.y / (h - 1) })); largest = area;
  }
  return best && validCorners(best) ? best : null;
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
    if (lum < Math.max(low[cell], high[cell] * .94 - 3) || lum > high[cell]) continue;
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
  for (let c = 0; c < 3; c++) background[c] = gaussian3(background[c], gw, gh);
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
    const i = (y * w + x) * 4;
    const originalSum = data[i] + data[i + 1] + data[i + 2];
    let castDifference = 0;
    for (let c = 0; c < 3; c++) castDifference = Math.max(castDifference, Math.abs(data[i + c] / Math.max(1, originalSum) - paperColour[c]));
    for (let channel = 0; channel < 3; channel++) {
      const grid = background[channel];
      const a = grid[iy * gw + ix], b = grid[iy * gw + Math.min(ix + 1, gw - 1)], c = grid[Math.min(iy + 1, gh - 1) * gw + ix], d = grid[Math.min(iy + 1, gh - 1) * gw + Math.min(ix + 1, gw - 1)];
      const bg = (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
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
  const gray = grayImage(image), blurred = gaussian3(gray, w, h);
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
async function handle({ type, file, image, points, frame }) {
  let thumbnail;
  if (type === "init") {
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
  const corners = detectCorners(thumbnail);
  return { detected: Boolean(corners), originalFrame: imageFrame(sourcePixels),
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
