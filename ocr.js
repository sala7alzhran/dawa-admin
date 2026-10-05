// Reads a box photo: its printed text, line by line with the letters' height (PaddleOCR in cutout-worker.js), and any
// barcode on it (zxing, MIT). Both run in this browser.
import * as Cut from "./cutout.js";
const ZXING = "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.4/reader/+esm";
const ZXING_WASM = "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.4/dist/reader/zxing_reader.wasm";

let zxing = null;

async function barcodeReader() {
  if (!zxing) {
    zxing = (async () => {
      const z = await import(ZXING);
      z.prepareZXingModule?.({ overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? ZXING_WASM : prefix + path) } });
      return z;
    })();
  }
  return zxing;
}

/** The photo at most 1800 px wide or high (enough to read a box, and much faster). */
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

/** A GS1 code ("(01)06251234567890…") as the product's EAN-13; other codes as they are. */
function gtin(text) {
  const t = text.replace(/[()\u001d]/g, "");
  const m = t.match(/^(?:\]d2)?01(\d{14})/);
  if (m) return m[1].startsWith("0") ? m[1].slice(1) : m[1];
  return /^\d{8,14}$/.test(t) ? t : null;
}

/**
 * Everything readable on the box: lines [{ text, confidence 0..1, height }] (the box matcher's input) and the
 * barcodes found [string].
 */
export async function readBox(file) {
  const img = await shrink(file);
  const [lines, codes] = await Promise.all([
    Cut.read(file).then((r) => r.lines),
    (async () => {
      try {
        const z = await barcodeReader();
        const found = await z.readBarcodes(img, { tryHarder: true, formats: ["EAN13", "EAN8", "UPCA", "UPCE", "DataMatrix", "QRCode"] });
        return [...new Set(found.map((r) => gtin(r.text ?? "")).filter(Boolean))];
      } catch (e) {
        console.warn("barcode", e);
        return [];
      }
    })(),
  ]);
  return { lines, codes };
}
