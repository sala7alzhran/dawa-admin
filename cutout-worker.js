// The background remover's own thread (see cutout.js): the model runs here, so the panel never freezes while a photo
// is being cut. Box photos as the photo packs have them: background removed by BiRefNet (the same model
// tools/photo_clean.py used for the packs; MIT licence), cropped to the box, centred on white with a small margin,
// 480 px WebP. The box's own pixels are kept as they are: only the background turns white. The model lives next to the
// panel (model/, made by tools/cutout_model.py) and is downloaded once.
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const MANIFEST = new URL("./model/manifest.json", self.location.href).href; // tools/cutout_model.py
const SIZE = 1024; // the model's input
const OUT = 480; // the packs' photo size
const MARGIN = 0.06;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let ort = null;
let session = null;
let loading = null;

/** The model, downloaded once in parts (kept in the browser's cache afterwards), reporting progress 0..1. */
async function modelBytes(progress) {
  const manifest = await (await fetch(MANIFEST, { cache: "no-cache" })).json();
  const key = `${MANIFEST}#${manifest.sha256}`;
  const cache = await caches.open("dawa-models");
  const hit = await cache.match(key);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const bytes = new Uint8Array(manifest.bytes);
  let got = 0;
  for (const part of manifest.parts) {
    const r = await fetch(new URL(part.path, MANIFEST));
    if (!r.ok) throw new Error("model " + r.status);
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.set(value, got);
      got += value.length;
      progress(got / manifest.bytes);
    }
  }
  const sum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (got !== manifest.bytes || sum !== manifest.sha256) throw new Error("model checksum");
  try {
    for (const k of await cache.keys()) await cache.delete(k); // an older model, if any
    await cache.put(key, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  } catch { /* no room to keep it: it is downloaded again next time */ }
  return bytes;
}

/** True when the model is already in this browser (no big download needed). */
async function cached() {
  try {
    const manifest = await (await fetch(MANIFEST, { cache: "no-cache" })).json();
    return !!(await (await caches.open("dawa-models")).match(`${MANIFEST}#${manifest.sha256}`));
  } catch { return false; }
}

/** The graphics card (half precision) when it can, else the processor (slower). */
function load(progress) {
  if (session) return Promise.resolve(session);
  if (loading) return loading;
  loading = (async () => {
    ort = await import(ORT + "ort.webgpu.min.mjs");
    ort.env.wasm.wasmPaths = ORT;
    ort.env.wasm.numThreads = 1; // GitHub Pages can't give the page the isolation threads need
    const gpu = !!self.navigator.gpu && !!(await self.navigator.gpu.requestAdapter().catch(() => null));
    const bytes = await modelBytes(progress);
    let last;
    for (const provider of gpu ? ["webgpu", "wasm"] : ["wasm"]) {
      try {
        session = await ort.InferenceSession.create(bytes, { executionProviders: [provider], graphOptimizationLevel: "all",
          enableCpuMemArena: false, enableMemPattern: false }); // the processor's part holds only small pieces
        session.kind = provider;
        return session;
      } catch (e) { last = e; }
    }
    loading = null;
    throw last;
  })();
  return loading;
}

function canvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  return [c, c.getContext("2d", { willReadFrequently: true })];
}

function toHalf(f32) {
  const out = new Uint16Array(f32.length);
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  for (let i = 0; i < f32.length; i++) {
    f[0] = f32[i];
    const x = u[0];
    const sign = (x >>> 16) & 0x8000;
    const e = ((x >>> 23) & 0xff) - 127 + 15;
    const mnt = x & 0x7fffff;
    out[i] = e <= 0 ? sign : e >= 31 ? sign | 0x7c00 : sign | (e << 10) | (mnt >>> 13);
  }
  return out;
}
function halfToFloat(h) {
  if (h instanceof Float32Array) return h;
  if (typeof Float16Array !== "undefined" && h instanceof Float16Array) return Float32Array.from(h);
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const x = h[i], s = x & 0x8000 ? -1 : 1, e = (x >> 10) & 0x1f, m = x & 0x3ff;
    out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}

/** The model's mask (0..1 per pixel, at 1024 x 1024) for this picture. */
async function mask(bitmap) {
  const [, g] = canvas(SIZE, SIZE);
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const px = g.getImageData(0, 0, SIZE, SIZE).data;
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let ch = 0; ch < 3; ch++) input[ch * plane + i] = (px[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
  }
  const name = session.inputNames[0];
  const half = () => new ort.Tensor("float16", typeof Float16Array !== "undefined" ? Float16Array.from(input) : toHalf(input), [1, 3, SIZE, SIZE]);
  // the half-precision model still takes ordinary numbers in and out (its own casts inside); some exports don't
  let out;
  try {
    out = await session.run({ [name]: session.halfInput ? half() : new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) });
  } catch (e) {
    if (session.halfInput || !/float16/.test(String(e))) throw e;
    session.halfInput = true;
    out = await session.run({ [name]: half() });
  }
  const t = out[session.outputNames[session.outputNames.length - 1]];
  const raw = halfToFloat(t.type === "float16" ? t.data : await t.getData?.() ?? t.data);
  // as rembg does: sigmoid, then stretched to the full 0..1 range
  const m = new Float32Array(plane);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < plane; i++) {
    const v = 1 / (1 + Math.exp(-raw[i]));
    m[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  for (let i = 0; i < plane; i++) m[i] = (m[i] - lo) / span;
  return m;
}

/** The picture's grey levels averaged over a gw x gh grid (each pixel counted for the part of it inside a cell). */
function grid(d, w, h, gw, gh) {
  const cells = new Float64Array(gw * gh), area = new Float64Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const y0 = (y * gh) / h, y1 = ((y + 1) * gh) / h;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, grey = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const x0 = (x * gw) / w, x1 = ((x + 1) * gw) / w;
      for (let cy = Math.floor(y0); cy < Math.min(gh, Math.ceil(y1)); cy++) {
        const fy = Math.min(y1, cy + 1) - Math.max(y0, cy);
        if (fy <= 0) continue;
        for (let cx = Math.floor(x0); cx < Math.min(gw, Math.ceil(x1)); cx++) {
          const fx = Math.min(x1, cx + 1) - Math.max(x0, cx);
          if (fx > 0) { cells[cy * gw + cx] += grey * fx * fy; area[cy * gw + cx] += fx * fy; }
        }
      }
    }
  }
  return cells.map((v, i) => v / area[i]);
}

/**
 * 128-bit difference hash ("are these two the same photo?"), as 32 hex digits: on a 9 x 8 grid each cell against the
 * one to its right, then on an 8 x 9 grid each against the one below. Coarse on purpose: the same photo cut twice
 * (a pixel off here and there) comes out the same, different boxes photographed alike don't. "Brighter by more than
 * one grey level": white areas, all but equal, never decide a bit. tools/pack_hashes.py computes the same.
 */
function dhash(source) {
  const w = source.width, h = source.height;
  const [, g] = canvas(w, h);
  g.drawImage(source, 0, 0);
  const d = g.getImageData(0, 0, w, h).data;
  const across = grid(d, w, h, 9, 8), down = grid(d, w, h, 8, 9);
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += across[y * 9 + x] > across[y * 9 + x + 1] + 1 ? "1" : "0";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += down[y * 8 + x] > down[(y + 1) * 8 + x] + 1 ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart(32, "0");
}

/** A picture centred on a white square with the packs' margin, as a 480 px WebP. */
async function square(source, sx, sy, sw, sh, alpha) {
  const side = Math.round(Math.max(sw, sh) * (1 + 2 * MARGIN));
  const [c, g] = canvas(OUT, OUT);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, OUT, OUT);
  g.imageSmoothingQuality = "high";
  const k = OUT / side;
  const dx = ((side - sw) / 2) * k, dy = ((side - sh) / 2) * k;
  if (alpha) {
    // the box over white through the soft mask (its own pixels, nothing repainted)
    const [lc, lg] = canvas(sw, sh);
    lg.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    const img = lg.getImageData(0, 0, sw, sh);
    for (let i = 0; i < sw * sh; i++) img.data[i * 4 + 3] = alpha[i];
    lg.putImageData(img, 0, 0);
    g.drawImage(lc, 0, 0, sw, sh, dx, dy, sw * k, sh * k);
  } else {
    g.drawImage(source, sx, sy, sw, sh, dx, dy, sw * k, sh * k);
  }
  const blob = await c.convertToBlob({ type: "image/webp", quality: 0.8 });
  return { blob, hash: dhash(c) };
}

async function clean(file, plain) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const w = bitmap.width, h = bitmap.height;
  const notes = [];
  if (Math.max(w, h) < OUT) notes.push(`صورة صغيرة (${Math.max(w, h)} بكسل): ستبدو أقل وضوحًا`);
  if (plain) return { ...(await square(bitmap, 0, 0, w, h, null)), notes, cut: false };

  const m = await mask(bitmap);
  // the mask at the photo's own size
  const [mc, mg] = canvas(SIZE, SIZE);
  const mi = mg.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) { const v = Math.round(m[i] * 255); mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = v; mi.data[i * 4 + 3] = 255; }
  mg.putImageData(mi, 0, 0);
  const [, fg] = canvas(w, h);
  fg.imageSmoothingQuality = "high";
  fg.drawImage(mc, 0, 0, w, h);
  const full = fg.getImageData(0, 0, w, h).data;
  // the box's extent: pixels clearly inside it (as photo_clean.py: above 16 of 255)
  let x0 = w, y0 = h, x1 = -1, y1 = -1, inside = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (full[(y * w + x) * 4] > 16) { inside++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const coverage = inside / (w * h);
  if (x1 < 0 || coverage < 0.06) {
    notes.push("لم يُعرف شكل العلبة: وُضعت الصورة كما هي على خلفية بيضاء");
    return { ...(await square(bitmap, 0, 0, w, h, null)), notes, cut: false };
  }
  if (coverage < 0.15) notes.push("العلبة جزء صغير من الصورة: تأكّد أن القص لم يأخذ شيئًا منها");
  const sw = x1 - x0 + 1, sh = y1 - y0 + 1;
  const alpha = new Uint8ClampedArray(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) alpha[y * sw + x] = full[((y + y0) * w + (x + x0)) * 4];
  return { ...(await square(bitmap, x0, y0, sw, sh, alpha)), notes, cut: true };
}

// ---------------------------------------------------------------- reading the box's printed text
// PaddleOCR (PP-OCRv4, Apache licence; the ONNX export of RapidOCR), as tools measured it on the companies' photos:
// find the text lines (DB detection), read each one (CTC). Small models (15 MB), on the processor: a second or two.

const OCR_DIR = new URL("./model/ocr/", self.location.href).href;
let ocr = null;

async function runtime() {
  if (!ort) {
    ort = await import(ORT + "ort.webgpu.min.mjs");
    ort.env.wasm.wasmPaths = ORT;
    ort.env.wasm.numThreads = 1;
  }
  return ort;
}

async function ocrModels() {
  if (ocr) return ocr;
  const rt = await runtime();
  const bytes = async (name) => new Uint8Array(await (await fetch(OCR_DIR + name)).arrayBuffer());
  const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const [det, rec, keys] = await Promise.all([
    bytes("det.onnx").then((b) => rt.InferenceSession.create(b, opts)),
    bytes("rec.onnx").then((b) => rt.InferenceSession.create(b, opts)),
    fetch(OCR_DIR + "keys.txt").then((r) => r.text()),
  ]);
  // one character a line (whatever the line ends), then the space; 0 is CTC's blank
  ocr = { det, rec, chars: ["", ...keys.replace(/\r?\n$/, "").split(/\r?\n/), " "] };
  return ocr;
}

/** An image's pixels as the network wants them: BGR planes, (v / 255 - 0.5) / 0.5. */
function planes(data, w, h, out = new Float32Array(3 * w * h), stride = w) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, o = y * stride + x, plane = stride * h;
    out[o] = data[i + 2] / 127.5 - 1;
    out[plane + o] = data[i + 1] / 127.5 - 1;
    out[2 * plane + o] = data[i] / 127.5 - 1;
  }
  return out;
}

/** Convex hull (monotone chain) of [x, y] points. */
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The smallest rectangle around a set of points (any angle): { c: centre, u: unit along, a: length, b: width }. */
function minRect(points) {
  const h = hull(points);
  if (h.length < 3) {
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, y0 = Math.min(...ys), y1 = Math.max(...ys) + 1;
    return { c: [(x0 + x1) / 2, (y0 + y1) / 2], u: [1, 0], a: x1 - x0, b: y1 - y0 };
  }
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const u = [(q[0] - p[0]) / len, (q[1] - p[1]) / len], v = [-u[1], u[0]];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const r of h) {
      const pa = r[0] * u[0] + r[1] * u[1], pb = r[0] * v[0] + r[1] * v[1];
      if (pa < a0) a0 = pa; if (pa > a1) a1 = pa; if (pb < b0) b0 = pb; if (pb > b1) b1 = pb;
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) {
      const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
      best = { area, c: [ca * u[0] + cb * v[0], ca * u[1] + cb * v[1]], u, a: a1 - a0 + 1, b: b1 - b0 + 1 };
    }
  }
  return best;
}

/** The text lines' rectangles on the photo: [{ p: [tl, tr, br, bl] }] in the photo's pixels. */
async function detect(bitmap, m) {
  const W = bitmap.width, H = bitmap.height;
  let ratio = Math.min(W, H) < 736 ? 736 / Math.min(W, H) : 1;
  if (Math.max(W, H) * ratio > 2400) ratio = 2400 / Math.max(W, H);
  const rw = Math.max(32, Math.round((W * ratio) / 32) * 32), rh = Math.max(32, Math.round((H * ratio) / 32) * 32);
  const [, g] = canvas(rw, rh);
  g.drawImage(bitmap, 0, 0, rw, rh);
  const input = planes(g.getImageData(0, 0, rw, rh).data, rw, rh);
  const out = await m.det.run({ [m.det.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, rh, rw]) });
  const pred = out[m.det.outputNames[0]].data;
  // text where the map is above 0.3, widened by one pixel (as PaddleOCR's 2x2 dilation)
  const on = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = y * rw + x;
    on[i] = pred[i] > 0.3 || (x > 0 && pred[i - 1] > 0.3) || (y > 0 && pred[i - rw] > 0.3) || (x > 0 && y > 0 && pred[i - rw - 1] > 0.3) ? 1 : 0;
  }
  const seen = new Uint8Array(rw * rh);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < on.length && boxes.length < 1000; start++) {
    if (!on[start] || seen[start]) continue;
    // one piece of text: its pixels (8 neighbours), the row ends for the hull, the map's mean inside it
    const rows = new Map();
    let sum = 0, n = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % rw, y = (i / rw) | 0;
      sum += pred[i]; n++;
      const r = rows.get(y);
      if (!r) rows.set(y, [x, x]); else { if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
        const j = ny * rw + nx;
        if (on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (n < 4 || sum / n < 0.5) continue;
    const pts = [];
    for (const [y, [x0, x1]] of rows) { pts.push([x0, y], [x1 + 1, y], [x0, y + 1], [x1 + 1, y + 1]); }
    const rect = minRect(pts);
    if (Math.min(rect.a, rect.b) < 3) continue;
    // grown as PaddleOCR's unclip (ratio 1.6)
    const d = (rect.a * rect.b * 1.6) / (2 * (rect.a + rect.b));
    const a = rect.a + 2 * d, b = rect.b + 2 * d;
    if (Math.min(a, b) < 5) continue;
    const u = rect.u, v = [-u[1], u[0]];
    const corner = (sa, sb) => [
      Math.min(W - 1, Math.max(0, ((rect.c[0] + sa * a / 2 * u[0] + sb * b / 2 * v[0]) / rw) * W)),
      Math.min(H - 1, Math.max(0, ((rect.c[1] + sa * a / 2 * u[1] + sb * b / 2 * v[1]) / rh) * H)),
    ];
    const p = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    // corners as top-left, top-right, bottom-right, bottom-left
    const byX = [...p].sort((s, t) => s[0] - t[0]);
    const [tl, bl] = byX.slice(0, 2).sort((s, t) => s[1] - t[1]);
    const [tr, br] = byX.slice(2).sort((s, t) => s[1] - t[1]);
    const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    if (w <= 3 || h <= 3) continue;
    boxes.push({ p: [tl, tr, br, bl], w, h });
  }
  // top to bottom, then left to right on the same line (as PaddleOCR)
  boxes.sort((s, t) => s.p[0][1] - t.p[0][1] || s.p[0][0] - t.p[0][0]);
  for (let i = 0; i < boxes.length - 1; i++) {
    for (let j = i; j >= 0 && Math.abs(boxes[j + 1].p[0][1] - boxes[j].p[0][1]) < 10 && boxes[j + 1].p[0][0] < boxes[j].p[0][0]; j--) {
      [boxes[j], boxes[j + 1]] = [boxes[j + 1], boxes[j]];
    }
  }
  return boxes;
}

/** Reads one text line: the rectangle straightened, 48 px high, then the most likely characters (CTC). */
async function recognise(bitmap, box, m) {
  const [tl, tr, , bl] = box.p;
  let w = Math.max(1, Math.round(box.w)), h = Math.max(1, Math.round(box.h));
  const ux = (tr[0] - tl[0]) / box.w, uy = (tr[1] - tl[1]) / box.w, vx = (bl[0] - tl[0]) / box.h, vy = (bl[1] - tl[1]) / box.h;
  let [c, g] = canvas(w, h);
  // source point = tl + x·u + y·v; the canvas needs source → output, the inverse of that
  const det = ux * vy - vx * uy || 1;
  g.setTransform(vy / det, -uy / det, -vx / det, ux / det, (vx * tl[1] - vy * tl[0]) / det, (uy * tl[0] - ux * tl[1]) / det);
  g.drawImage(bitmap, 0, 0);
  if (h / w >= 1.5) {
    // a line written upwards: turned a quarter (as PaddleOCR's rot90)
    const [c2, g2] = canvas(h, w);
    g2.setTransform(0, -1, 1, 0, 0, w);
    g2.drawImage(c, 0, 0);
    [c, g, w, h] = [c2, g2, h, w];
  }
  const outW = Math.max(320, Math.round(48 * (w / h)));
  const rw = Math.min(outW, Math.ceil(48 * (w / h)));
  const [, sg] = canvas(rw, 48);
  sg.drawImage(c, 0, 0, rw, 48);
  const input = new Float32Array(3 * 48 * outW);
  planes(sg.getImageData(0, 0, rw, 48).data, rw, 48, input, outW);
  const out = await m.rec.run({ [m.rec.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 48, outW]) });
  const t = out[m.rec.outputNames[0]];
  const [, steps, classes] = t.dims;
  let text = "", last = -1, conf = 0, kept = 0;
  for (let s = 0; s < steps; s++) {
    let bi = 0, bp = -Infinity;
    for (let k = 0; k < classes; k++) { const v = t.data[s * classes + k]; if (v > bp) { bp = v; bi = k; } }
    if (bi !== 0 && bi !== last) { text += m.chars[bi] ?? ""; conf += bp; kept++; }
    last = bi;
  }
  return { text, confidence: kept ? conf / kept : 0 };
}

/** The box's text lines for the box matcher: [{ text, confidence, height }]. */
async function readText(file) {
  const m = await ocrModels();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const lines = [];
  for (const box of await detect(bitmap, m)) {
    const r = await recognise(bitmap, box, m);
    if (!r.text.trim() || r.confidence < 0.5) continue;
    // where it stands on the photo too: the biggest words side by side are the medicine's name
    lines.push({ text: r.text, confidence: r.confidence, height: r.text.length > 2 ? Math.min(box.w, box.h) : box.h,
      x: box.p[0][0], y: box.p[0][1], w: box.w });
  }
  return lines;
}

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === "ready") {
      self.postMessage({ id: msg.id, ok: true, value: !!session || (await cached()) });
    } else if (msg.type === "load") {
      const s = await load((x) => self.postMessage({ id: msg.id, progress: x }));
      self.postMessage({ id: msg.id, ok: true, value: s.kind });
    } else if (msg.type === "hash") {
      self.postMessage({ id: msg.id, ok: true, value: dhash(await createImageBitmap(msg.file)) });
    } else if (msg.type === "read") {
      const t0 = performance.now();
      const lines = await readText(msg.file);
      self.postMessage({ id: msg.id, ok: true, value: { lines, ms: Math.round(performance.now() - t0) } });
    } else if (msg.type === "clean") {
      if (!msg.plain) await load(() => {});
      const t0 = performance.now();
      const r = await clean(msg.file, msg.plain);
      self.postMessage({ id: msg.id, ok: true, value: { ...r, ms: Math.round(performance.now() - t0), kind: session?.kind } });
    }
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e?.message ?? e) });
  }
};
