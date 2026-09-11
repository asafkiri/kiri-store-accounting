// Local document geometry and gentle photographic correction. No network or OCR.
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
export function warpImage(image, points, maxEdge = 2500) {
  if (!validCorners(points)) throw Error("Invalid corners");
  const q = points.map(p => ({ x: p.x * (image.width - 1), y: p.y * (image.height - 1) }));
  const naturalWidth = Math.max(distance(q[0], q[1]), distance(q[3], q[2])) + 1;
  const naturalHeight = Math.max(distance(q[0], q[3]), distance(q[1], q[2])) + 1;
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
  // A small grid of bright paper samples estimates illumination, then a broad
  // blur smooths it. Text is not used as the background or thresholded away.
  const gw = Math.max(2, Math.round(w / Math.max(w, h) * 64)), gh = Math.max(2, Math.round(h / Math.max(w, h) * 64));
  let background = new Float32Array(gw * gh);
  const means = [0, 0, 0]; let count = 0;
  const histogram = new Uint32Array(256);
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = (y * w + x) * 4, lum = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
    const cell = Math.min(gh - 1, Math.floor(y * gh / h)) * gw + Math.min(gw - 1, Math.floor(x * gw / w));
    background[cell] = Math.max(background[cell], lum); histogram[Math.round(lum)]++;
    if (lum > 160) { for (let c = 0; c < 3; c++) means[c] += data[i + c]; count++; }
  }
  for (let pass = 0; pass < 5; pass++) background = gaussian3(background, gw, gh);
  const mean = (means[0] + means[1] + means[2]) / 3;
  const balance = means.map(v => count && v ? clamp(mean / v, .96, 1.04) : 1);
  const samples = histogram.reduce((s, n) => s + n, 0);
  let low = 0, high = 255, sum = 0;
  for (let i = 0; i < 256; i++) { sum += histogram[i]; if (sum >= samples * .01) { low = i; break; } }
  sum = 0;
  for (let i = 255; i >= 0; i--) { sum += histogram[i]; if (sum >= samples * .01) { high = i; break; } }
  const contrast = high - low > 80 ? Math.min(1.06, 255 / (high - low)) : 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = x * (gw - 1) / Math.max(1, w - 1), gy = y * (gh - 1) / Math.max(1, h - 1), ix = Math.floor(gx), iy = Math.floor(gy), dx = gx - ix, dy = gy - iy;
    const a = background[iy * gw + ix], b = background[iy * gw + Math.min(ix + 1, gw - 1)], c = background[Math.min(iy + 1, gh - 1) * gw + ix], d = background[Math.min(iy + 1, gh - 1) * gw + Math.min(ix + 1, gw - 1)];
    const bg = (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
    const gain = clamp(248 / Math.max(1, bg), .97, 1.18), i = (y * w + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      let value = (data[i + channel] - 128) * contrast + 128;
      value *= gain * balance[channel];
      // Smooth highlight roll-off retains differences in pale, thin printing.
      data[i + channel] = value > 248 ? 248 + 7 * (1 - Math.exp(-(value - 248) / 7)) : value;
    }
  }
  const gray = grayImage(image), blurred = gaussian3(gray, w, h);
  for (let i = 0; i < gray.length; i++) {
    const detail = clamp((gray[i] - blurred[i]) * .25, -8, 8);
    for (let c = 0; c < 3; c++) data[i * 4 + c] += detail;
  }
  return image;
}
let original, thumbnail;
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
async function handle({ type, file, image, points }) {
  if (type === "init") {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") return { needsPixels: true };
    original?.close();
    try {
      original = await createImageBitmap(file, { imageOrientation: "from-image" });
      if (!original.width || original.width * original.height > 80_000_000) throw Error("Image too large");
      thumbnail = bitmapPixels(original, 1000);
    } catch {
      original?.close(); original = null;
      return { needsPixels: true };
    }
  } else if (type === "initPixels") thumbnail = image;
  else if (type === "preview") return output(enhanceImage(warpImage(thumbnail, points, 1000)));
  else if (type === "process") {
    const pixels = image || bitmapPixels(original);
    return output(enhanceImage(warpImage(pixels, points)));
  } else throw Error("Unknown image operation");
  return { corners: detectCorners(thumbnail), ...(await output(thumbnail, true)) };
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
