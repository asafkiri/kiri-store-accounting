const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_PIXELS = 80_000_000;
const MAX_EDGE = 2500;
export function encodeFile(file, name = file.name) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        name,
        mime: file.type,
        data: String(reader.result).split(",")[1],
      });
    reader.onerror = () =>
      reject(Error("לא ניתן לקרוא את הקובץ. בחר אותו שוב."));
    reader.readAsDataURL(file);
  });
}
export async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* Older browsers can decode through an image element. */
    }
  }
  const url = URL.createObjectURL(file),
    image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () =>
        reject(Error("לא ניתן לפתוח את התמונה. בחר צילום אחר."));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export function validateFile(file) {
  if (
    !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
      file.type,
    )
  )
    throw Error("בחר תמונה בפורמט JPG, PNG או WebP, או קובץ PDF.");
  if (!file.size || file.size > MAX_SOURCE_BYTES)
    throw Error("הקובץ ריק או גדול מדי. בחר קובץ עד 40 מגה.");
}
export async function readFile(file) {
  validateFile(file);
  if (file.type === "application/pdf") return encodeFile(file);
  let image;
  const canvas = document.createElement("canvas");
  try {
    image = await decodeImage(file);
    const width = image.naturalWidth || image.width,
      height = image.naturalHeight || image.height;
    if (!width || !height || width * height > MAX_PIXELS)
      throw Error("התמונה גדולה מדי לפענוח. בחר צילום ברזולוציה נמוכה יותר.");
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("לא ניתן להכין את התמונה. נסה לבחור אותה שוב.");
    // Preserve the full page, EXIF orientation and white paper; never crop or threshold.
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.88),
    );
    if (!blob) throw Error("הכנת התמונה נכשלה. בחר את הצילום שוב.");
    return await encodeFile(blob, file.name.replace(/\.[^.]+$/, "") + ".jpg");
  } finally {
    image?.close?.();
    canvas.width = canvas.height = 1;
  }
}
