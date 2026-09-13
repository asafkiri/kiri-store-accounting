// Procedural fixtures; no customer documents or real accounts in the repository.
// page.evaluate serialises this function into the page, so it must not reach module scope: every
// helper lives inside it. The `window` parameter only exists so Node can run it against a scratch
// object and lift the pure helpers out (see the export at the bottom); in a browser it is window.
export function installScannerFixtures(window = globalThis.window) {
  // Corner error of a detection against ground truth, both normalised 0..1 in TL/TR/BR/BL order:
  // `max` is the largest corner distance as a percentage of the long edge; `maxInward` is, over the
  // found corners strictly inside the truth quad, the largest distance to the truth outline (same
  // units), so a crop that trims the document is visible even when `max` is small.
  window.cornerDeviation = (found, truth, width, height) => {
    if (!found) return { max: Infinity, maxInward: Infinity };
    const long = Math.max(width, height), toPixels = p => ({ x: p.x * (width - 1), y: p.y * (height - 1) });
    const quad = truth.map(toPixels), cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const orientation = Math.sign(cross(quad[0], quad[1], quad[2]));
    const edgeDistance = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    let max = 0, maxInward = 0;
    found.forEach((point, i) => {
      const p = toPixels(point);
      max = Math.max(max, Math.hypot(p.x - quad[i].x, p.y - quad[i].y) / long * 100);
      if (quad.every((a, j) => cross(a, quad[(j + 1) % 4], p) * orientation > 0))
        maxInward = Math.max(maxInward, Math.min(...quad.map((a, j) => edgeDistance(p, a, quad[(j + 1) % 4]))) / long * 100);
    });
    return { max, maxInward };
  };
  // Seeded photo-like fixtures: portrait 3:4 canvases (`size` wide) with exact corners, drawn from one
  // mulberry32 stream per seed so every noisy pixel is reproducible. Corners are TL/TR/BR/BL.
  const SAMPLE_QUAD = [{ x: .20, y: .12 }, { x: .82, y: .14 }, { x: .80, y: .90 }, { x: .18, y: .88 }], WHITE = [250, 250, 248];
  const PROCEDURAL = {
    "beige-texture": { background: "beige", castShadow: true, paper: [163, 164, 162], lowerBand: true, marks: true, corners: [{ x: .24, y: .09 }, { x: .68, y: .10 }, { x: .71, y: .94 }, { x: .22, y: .93 }] },
    "dark-counter": { background: "dark", paper: WHITE, corners: SAMPLE_QUAD },
    "counter-edge-below": { background: "dark", counter: "bottom", paper: WHITE, corners: SAMPLE_QUAD },
    "metal-behind-page": { background: "dark", counter: "metal", paper: WHITE, corners: SAMPLE_QUAD },
    "wood-grain": { background: "wood", paper: [245, 243, 238], corners: SAMPLE_QUAD },
    "white-table-soft-shadow": { background: "white", edgeShadow: true, paper: [245, 244, 240], corners: SAMPLE_QUAD },
    "cut-off": { background: "dark", paper: WHITE, corners: [{ x: .15, y: .08 }, { x: 1.12, y: .05 }, { x: 1.10, y: .93 }, { x: .13, y: .90 }] },
    "long-1-5": { background: "dark", paper: WHITE, corners: [{ x: .38, y: .05 }, { x: .62, y: .05 }, { x: .63, y: .95 }, { x: .37, y: .95 }] },
    "a4-angle": { background: "beige", paper: [246, 246, 243], a4: true },
    "shadow-across": { background: "dark", paper: WHITE, crossBand: true, corners: SAMPLE_QUAD },
    "crumpled": { background: "dark", paper: WHITE, crumpled: true, corners: SAMPLE_QUAD },
    "texture-only": { background: "beige" },
  };
  const makeProceduralCanvas = (mode, size, seed) => {
    const spec = PROCEDURAL[mode], W = size, H = Math.round(size * 4 / 3), L = Math.max(W, H), k = size / 1000;
    let state = seed | 0;
    const random = () => {
      state = state + 0x6D2B79F5 | 0;
      let t = Math.imul(state ^ state >>> 15, 1 | state);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const segmentDistance = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    const insideQuad = (p, poly) => poly.every((a, i) => cross(a, poly[(i + 1) % 4], p) >= 0);
    const outlineDistance = (p, poly) => Math.min(...poly.map((a, i) => segmentDistance(p, a, poly[(i + 1) % 4])));
    const bounds = poly => ({ x0: Math.min(...poly.map(p => p.x)), x1: Math.max(...poly.map(p => p.x)), y0: Math.min(...poly.map(p => p.y)), y1: Math.max(...poly.map(p => p.y)) });
    // Horizontal extent of a convex polygon at height y, for placing text rows inside it.
    const spanAt = (poly, y) => {
      let lo = Infinity, hi = -Infinity;
      poly.forEach((a, i) => {
        const b = poly[(i + 1) % poly.length];
        if (a.y === b.y || y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) return;
        const x = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y); lo = Math.min(lo, x); hi = Math.max(hi, x);
      });
      return [lo, hi];
    };
    let corners = spec.corners || null, local = null, rotation = null;
    if (spec.a4) {
      // An A4 sheet (long side 62% of the height) turned 25° about the canvas centre; its top edge is
      // 6% narrower than the bottom, so the corners are the exact projection of that trapezoid.
      const longSide = .62 * H, shortSide = longSide / 1.414, angle = 25 * Math.PI / 180, cx = W / 2, cy = H / 2;
      local = [{ x: -.47 * shortSide, y: -longSide / 2 }, { x: .47 * shortSide, y: -longSide / 2 }, { x: .5 * shortSide, y: longSide / 2 }, { x: -.5 * shortSide, y: longSide / 2 }];
      rotation = { angle, cx, cy };
      corners = local.map(p => ({
        x: (cx + p.x * Math.cos(angle) - p.y * Math.sin(angle)) / (W - 1),
        y: (cy + p.x * Math.sin(angle) + p.y * Math.cos(angle)) / (H - 1),
      }));
    }
    const quad = corners && corners.map(p => ({ x: p.x * (W - 1), y: p.y * (H - 1) })), box = quad && bounds(quad);
    // Background shading that depends on the paper: a cast shadow offset below/right with a 2% penumbra,
    // or a Gaussian shadow hugging the right edge (sigma 1.5%).
    const penumbra = .02 * L, shifted = quad && quad.map(p => ({ x: p.x + .025 * L, y: p.y + .03 * L })), shadowBox = shifted && bounds(shifted);
    const castShade = (x, y) => {
      if (x < shadowBox.x0 - penumbra || x > shadowBox.x1 + penumbra || y < shadowBox.y0 - penumbra || y > shadowBox.y1 + penumbra) return 1;
      const p = { x, y }, signed = (insideQuad(p, shifted) ? -1 : 1) * outlineDistance(p, shifted);
      const t = Math.min(1, Math.max(0, signed / penumbra + .5));
      return 1 - .25 * (1 - t * t * (3 - 2 * t));
    };
    const sigma = .015 * L;
    const edgeShade = (x, y) => {
      if (x < Math.min(quad[1].x, quad[2].x) - 4 * sigma || x > Math.max(quad[1].x, quad[2].x) + 4 * sigma || y < quad[1].y - 4 * sigma || y > quad[2].y + 4 * sigma) return 1;
      const d = segmentDistance({ x, y }, quad[1], quad[2]);
      return 1 - .15 * Math.exp(-d * d / (2 * sigma * sigma));
    };
    // Wood grain: stripes parallel to the paper's long edges whose period wanders between 6 and 12 px.
    let profile, grainX = 0, grainY = 0, grainMin = 0;
    if (spec.background === "wood") {
      const along = { x: quad[3].x - quad[0].x + quad[2].x - quad[1].x, y: quad[3].y - quad[0].y + quad[2].y - quad[1].y }, length = Math.hypot(along.x, along.y);
      grainX = -along.y / length; grainY = along.x / length;
      const reach = [0, W].flatMap(x => [0, H].map(y => x * grainX + y * grainY));
      grainMin = Math.min(...reach); profile = new Float32Array(Math.ceil(Math.max(...reach) - grainMin) + 2);
      const phase1 = random() * Math.PI * 2, phase2 = random() * Math.PI * 2;
      for (let i = 0, phase = 0; i < profile.length; i++) {
        const period = k * (9 + 3 * Math.sin(i / (41 * k) + phase1) * Math.cos(i / (113 * k) + phase2));
        phase += 2 * Math.PI / period; profile[i] = 20 * Math.sin(phase);
      }
    }
    const pixels = ctx.createImageData(W, H), data = pixels.data;
    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
      let r, g, b;
      if (spec.background === "beige") {
        // Multiplicative grain of ±6% under a light falling from ×.75 (top-left) to ×1.15 (bottom-right).
        const light = (1 + .06 * (2 * random() - 1)) * (.75 + .4 * (x / (W - 1) + y / (H - 1)) / 2) * (spec.castShadow ? castShade(x, y) : 1);
        r = 142 * light; g = 121 * light; b = 98 * light;
      } else if (spec.background === "dark") {
        const noise = random() * 6 - 3; r = 40 + noise; g = 38 + noise; b = 36 + noise;
      } else if (spec.background === "wood") {
        const v = profile[Math.round(x * grainX + y * grainY - grainMin)] + random() * 8 - 4; r = 150 + v; g = 105 + v; b = 70 + v;
      } else {
        const light = spec.edgeShadow ? edgeShade(x, y) : 1; r = 235 * light; g = 233 * light; b = 230 * light;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    if (spec.counter) {
      // A larger rectangle behind the page, with sides aligned to the paper.
      // The old area-only ranking preferred its bottom edge or its top panel.
      const outline = spec.counter === "bottom"
        ? [quad[0], quad[1], { x: quad[2].x, y: H * .96 }, { x: quad[3].x, y: H * .94 }]
        : [{ x: quad[0].x, y: H * .025 }, { x: quad[1].x, y: H * .045 }, quad[2], quad[3]];
      ctx.beginPath(); outline.forEach((p, i) => ctx[i ? "lineTo" : "moveTo"](p.x, p.y)); ctx.closePath();
      ctx.fillStyle = spec.counter === "bottom" ? "#676767" : "#8a8580"; ctx.fill();
      ctx.save(); ctx.clip();
      for (let y = 0; y < H; y += 9 * k) {
        ctx.strokeStyle = y % (18 * k) < 9 * k ? "#a0a0a0" : "#484848"; ctx.lineWidth = 1.5 * k;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y + 12 * k); ctx.stroke();
      }
      ctx.restore();
    }
    if (!spec.paper) return { canvas, corners };
    // The drawn outline: the straight quad, or each side curled along its normal by 1.5% × sin(πt)
    // for the crumpled sheet (the corners themselves stay on the ground truth).
    const trace = () => {
      ctx.beginPath();
      if (!spec.crumpled) { quad.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); return; }
      quad.forEach((a, i) => {
        const b = quad[(i + 1) % 4], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy), nx = -dy / length, ny = dx / length;
        for (let step = 0; step <= 60; step++) {
          const t = step / 60, bow = .015 * L * Math.sin(Math.PI * t), x = a.x + dx * t + nx * bow, y = a.y + dy * t + ny * bow;
          i || step ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
      });
      ctx.closePath();
    };
    trace(); ctx.fillStyle = `rgb(${spec.paper.join(",")})`; ctx.fill();
    ctx.save(); trace(); ctx.clip();
    const paperHeight = box.y1 - box.y0;
    if (spec.lowerBand) {
      // Shadow over the lower quarter of the sheet (−30%) with a ~1.5% soft upper edge.
      const top = box.y1 - .25 * paperHeight, soft = .015 * L, band = ctx.createLinearGradient(0, top - soft / 2, 0, top + soft / 2);
      band.addColorStop(0, "rgba(0,0,0,0)"); band.addColorStop(1, "rgba(0,0,0,.3)");
      ctx.fillStyle = band; ctx.fillRect(box.x0, top - soft, box.x1 - box.x0, box.y1 - top + soft);
    }
    if (spec.crossBand) { ctx.fillStyle = "rgba(0,0,0,.4)"; ctx.fillRect(box.x0, box.y0 + .45 * paperHeight, box.x1 - box.x0, .10 * paperHeight); }
    if (spec.crumpled) {
      // Three or four faint creases (about ±8 levels) crossing the sheet.
      const creases = 3 + (random() < .5 ? 1 : 0);
      for (let c = 0; c < creases; c++) {
        const across = random() < .5, t0 = .15 + .7 * random(), t1 = .15 + .7 * random();
        const a = across ? lerp(quad[0], quad[3], t0) : lerp(quad[0], quad[1], t0), b = across ? lerp(quad[1], quad[2], t1) : lerp(quad[3], quad[2], t1);
        const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy), ox = -dy / length * 3 * k, oy = dx / length * 3 * k;
        ctx.lineWidth = 3 * k; ctx.strokeStyle = "rgba(0,0,0,.032)";
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,.5)";
        ctx.beginPath(); ctx.moveTo(a.x + ox, a.y + oy); ctx.lineTo(b.x + ox, b.y + oy); ctx.stroke();
      }
    }
    // Text rows inside the sheet (in its own frame for the turned A4), sized so a row fits the width.
    if (rotation) { ctx.translate(rotation.cx, rotation.cy); ctx.rotate(rotation.angle); }
    const sheet = local || quad, ys = sheet.map(p => p.y), top = Math.min(...ys), bottom = Math.max(...ys), height = bottom - top;
    const nominal = size * .025, sample = "22  ";
    ctx.font = `${nominal}px sans-serif`;
    const available = .84 * Math.min(...[.15, .5, .85].map(f => { const [lo, hi] = spanAt(sheet, top + f * height); return hi - lo; }));
    const lines = ["Invoice 3385.50  609.41", "3385.50  609.41", "609.41"];
    const text = lines.find(line => ctx.measureText(sample + line).width <= available) || lines[lines.length - 1];
    const font = Math.min(nominal, nominal * available / ctx.measureText(sample + text).width);
    ctx.font = `${font}px sans-serif`; ctx.fillStyle = "#303030";
    ctx.lineWidth = 1.5 * k; ctx.strokeStyle = "rgba(48,48,48,.55)"; ctx.setLineDash([8 * k, 6 * k]);
    for (let y = top + .10 * height, row = 1; y < bottom - .06 * height; y += 1.5 * font, row++) {
      const [lo, hi] = spanAt(sheet, y), width = hi - lo;
      ctx.fillText(`${row}  ${text}`, lo + .08 * width, y);
      if (spec.marks && row % 2 === 0) { ctx.beginPath(); ctx.moveTo(lo + .06 * width, y + .5 * font); ctx.lineTo(hi - .06 * width, y + .5 * font); ctx.stroke(); }
    }
    if (spec.marks) {
      // A column of small blue squares in the margin just inside the left edge.
      const a = quad[0], b = quad[3], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy), inX = dy / length, inY = -dx / length, side = .012 * size, inset = .02 * size;
      ctx.fillStyle = "#2040a0";
      for (let m = 0; m < 10; m++) {
        const t = .10 + m * .085, x = a.x + dx * t + inX * inset, y = a.y + dy * t + inY * inset;
        ctx.fillRect(x - side / 2, y - side / 2, side, side);
      }
    }
    ctx.restore();
    if (mode !== "cut-off") return { canvas, corners };
    // Two corners lie beyond the right border: `expected` is what a detector can see, the true top and
    // bottom edges cut at x = 1.
    const cut = (a, b) => ({ x: 1, y: a.y + (1 - a.x) / (b.x - a.x) * (b.y - a.y) });
    return { canvas, corners, expected: [corners[0], cut(corners[0], corners[1]), cut(corners[3], corners[2]), corners[3]] };
  };
  window.makeDifficultPaper = (kind = "blue") => {
    const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 1280;
    const pen = canvas.getContext("2d"), pixels = pen.createImageData(canvas.width, canvas.height), samples = [];
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const shaded = y < 700, light = 1 - .05 * x / canvas.width;
      const paper = kind === "dim" ? [60, 56, 50] : kind === "blue"
        ? (shaded ? [123, 168, 216] : [207, 213, 222])
        : (shaded ? [104, 99, 92] : [232, 220, 205]);
      for (let c = 0; c < 3; c++) pixels.data[(y * canvas.width + x) * 4 + c] = paper[c] * light;
      pixels.data[(y * canvas.width + x) * 4 + 3] = 255;
    }
    for (const y of [240, 520, 1000]) for (const x of [120, 480, 840]) for (const [index, ratio] of [.84, .97, .99].entries()) {
      const xx = x + index * 12;
      for (let yy = y - 10; yy <= y + 10; yy++) for (let c = 0; c < 3; c++) pixels.data[(yy * canvas.width + xx) * 4 + c] *= ratio;
      // A decimal point is only one pixel: brightening must not erase it.
      for (let c = 0; c < 3; c++) pixels.data[((y + 4) * canvas.width + xx + 6) * 4 + c] *= ratio;
      samples.push({ x: xx, y, ratio });
    }
    pen.putImageData(pixels, 0, 0);
    pen.font = "28px sans-serif"; pen.fillStyle = "#343434";
    pen.fillText("Invoice 3385.50   VAT 609.41   Total 3995.00", 80, 100);
    pen.fillText("832.89   7.89   07/09/26   99041151", 80, 650);
    return { canvas, samples };
  };
  window.makeShadedPaper = () => {
    const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 1280;
    const pen = canvas.getContext("2d"), pixels = pen.createImageData(canvas.width, canvas.height), samples = [];
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const light = 246 - 42 * x / canvas.width - 46 * Math.exp(-(((y / canvas.height - .58) / .14) ** 2));
      pixels.data.set([light, light * .95, light * .89, 255], (y * canvas.width + x) * 4);
    }
    // Single-pixel printing at several exposure levels, including very pale ink.
    for (const y of [240, 740, 1120]) for (const x of [120, 480, 840]) for (const [index, ratio] of [.84, .97, .99].entries()) {
      const xx = x + index * 12;
      for (let yy = y - 10; yy <= y + 10; yy++) for (let c = 0; c < 3; c++) pixels.data[(yy * canvas.width + xx) * 4 + c] *= ratio;
      samples.push({ x: xx, y, ratio });
    }
    // Multiple gray values and a coloured mark must survive as continuous tones.
    for (let level = 0; level < 48; level++) {
      const value = 30 + level * 4;
      for (let y = 950; y < 970; y++) for (let x = 80 + level * 12; x < 88 + level * 12; x++)
        pixels.data.set([value, value, value, 255], (y * canvas.width + x) * 4);
    }
    pen.putImageData(pixels, 0, 0);
    pen.fillStyle = "#204ca0"; pen.fillRect(720, 960, 90, 60);
    pen.fillStyle = "#808080"; pen.font = "24px sans-serif";
    pen.fillText("Invoice 3385.50   VAT 609.41   Total 3995.00", 90, 100);
    return { canvas, samples };
  };
  window.makeDocumentCanvas = (mode = "perspective", size = 1000, aspect = .85, seed = 1) => {
    if (PROCEDURAL[mode]) return makeProceduralCanvas(mode, size, seed);
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = mode === "long" ? size * 2 : size * aspect;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = mode === "manual" ? "#8e99a8" : "#303847"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    let corners = [{ x: .18, y: .10 }, { x: .88, y: .18 }, { x: .80, y: .92 }, { x: .12, y: .84 }];
    if (mode === "long") corners = [{ x: .28, y: .04 }, { x: .60, y: .055 }, { x: .68, y: .95 }, { x: .36, y: .935 }];
    if (mode === "rotated") {
      const angle = 20 * Math.PI / 180;
      corners = [[-230, -300], [230, -300], [230, 300], [-230, 300]].map(([x, y]) => ({
        x: (500 + x * Math.cos(angle) - y * Math.sin(angle)) / 1000,
        y: (425 + x * Math.sin(angle) + y * Math.cos(angle)) / 850,
      }));
    }
    if (mode === "none") return { canvas, corners: null };
    if (mode === "circle") {
      ctx.fillStyle = "white"; ctx.beginPath(); ctx.arc(size / 2, canvas.height / 2, size * .35, 0, Math.PI * 2); ctx.fill();
      return { canvas, corners: null };
    }
    const pixelCorners = corners.map(p => ({ x: p.x * (canvas.width - 1), y: p.y * (canvas.height - 1) }));
    ctx.beginPath(); pixelCorners.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
    const illumination = ctx.createLinearGradient(0, 0, size, canvas.height);
    illumination.addColorStop(0, mode === "manual" ? "#929dab" : "#f8f5ef");
    illumination.addColorStop(1, mode === "manual" ? "#939dac" : "#d4d1c9");
    ctx.fillStyle = illumination; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = "#303030"; ctx.font = `${size * .025}px sans-serif`;
    for (let row = 0; row < 14; row++) {
      const y = canvas.height * (.24 + row * .039);
      ctx.fillText(`${row + 1}  Invoice 3385.50  609.41`, size * .25, y);
    }
    ctx.restore();
    return { canvas, corners };
  };
  window.makePhoto = async (mode = "perspective", size = 4032) => {
    const { canvas, corners } = window.makeDocumentCanvas(mode, size, .75);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .94));
    canvas.width = canvas.height = 1;
    return { file: new File([blob], `fixture-${mode}.jpg`, { type: "image/jpeg" }), corners };
  };
  window.openScanner = async () => {
    const { scanDialog } = await import("/scan.js");
    document.documentElement.lang = "he"; document.documentElement.dir = "rtl";
    document.body.innerHTML = '<dialog id="modal" open></dialog><div id="toast"></div>';
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/styles.css"; document.head.append(css);
    const cache = new Map(); window.scanRequests = []; window.invoiceSaves = [];
    window.scanDrafts = () => [...cache.entries()];
    const ctx = {
      data: { suppliers: [{ id: "supplier-osem", name: "אסם", active: true }], invoices: [], dailyCash: [] },
      drafts: { load: async key => structuredClone(cache.get(key)), save: async (key, value) => cache.set(key, structuredClone(value)), remove: async key => cache.delete(key) },
      dialog: (title, html) => { document.querySelector("#modal").innerHTML = `<div class="modal-content"><header class="modal-heading"><h2>${title}</h2><button class="icon-button">סגור</button></header>${html}</div>`; return document.querySelector(".modal-content"); },
      setModalBusy(busy) { window.scanBusy = busy; }, closeModal() {}, render() {}, refresh() {}, mergeRecord() {}, previewBlob() {},
      api: {
        request: async (path, options) => {
          window.scanRequests.push({ path, body: structuredClone(options?.body) });
          if (path === "documents") return { documents: options.body.files.map((_, i) => ({ id: `attachment-${i}` })) };
          throw Error("unexpected request " + path);
        },
        save: async value => { window.invoiceSaves.push(value); return { record: { id: "invoice-fixture" } }; },
      },
    };
    await scanDialog(ctx);
  };
  window.chooseScanPhoto = async (inputId = "camera-file", mode = "perspective") => {
    const { file } = await window.makePhoto(mode);
    window.selectedPhoto = file;
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.getElementById(inputId); input.files = transfer.files;
    window.pendingPhotoSelection = input.onchange();
  };
}
// The same pure helper for Node-side callers: cornerDeviation(found, truth, width, height) →
// { max, maxInward } in percent of the long edge (both Infinity when nothing was found).
const helpers = {}; installScannerFixtures(helpers);
export const cornerDeviation = helpers.cornerDeviation;
