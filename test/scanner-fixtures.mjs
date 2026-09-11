// Procedural fixtures; no customer documents or real accounts in the repository.
export function installScannerFixtures() {
  window.makeShadedPaper = () => {
    const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 1280;
    const pen = canvas.getContext("2d"), pixels = pen.createImageData(canvas.width, canvas.height), samples = [];
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const light = 246 - 42 * x / canvas.width - 46 * Math.exp(-(((y / canvas.height - .58) / .14) ** 2));
      pixels.data.set([light, light * .95, light * .89, 255], (y * canvas.width + x) * 4);
    }
    // Single-pixel printing at several exposure levels, including very pale ink.
    for (const y of [240, 740, 1120]) for (const x of [120, 480, 840]) for (const ratio of [.84, .97]) {
      const xx = x + (ratio > .9 ? 12 : 0);
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
  window.makeDocumentCanvas = (mode = "perspective", size = 1000, aspect = .85) => {
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = mode === "long" ? size * 2 : size * aspect;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#303847"; ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    illumination.addColorStop(0, "#f8f5ef"); illumination.addColorStop(1, "#d4d1c9");
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
          return { id: "scan-fixture", status: "completed", attachmentIds: ["attachment-0"], result: {
            supplierName: "אסם", documentNumber: "fixture-1", documentType: "invoice", invoiceDate: "2026-09-11",
            subtotalAgorot: 338550, vatAgorot: 60941, totalAgorot: 399500, finalAgorot: 399500,
            deductions: [{ label: "הנחה", amountAgorot: 93728, includedInTotal: true }, { label: "הפרש עיגול", amountAgorot: 9, includedInTotal: true }],
            uncertainFields: [], warnings: [], needsReview: false,
          } };
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
