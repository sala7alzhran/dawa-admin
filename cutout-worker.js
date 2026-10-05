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

/** 64-bit difference hash ("are these two the same photo?"), as 16 hex digits. */
function dhash(source) {
  const [, g] = canvas(9, 8);
  g.drawImage(source, 0, 0, 9, 8);
  const d = g.getImageData(0, 0, 9, 8).data;
  const grey = (x, y) => { const i = (y * 9 + x) * 4; return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; };
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += grey(x, y) > grey(x + 1, y) ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
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

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === "ready") {
      self.postMessage({ id: msg.id, ok: true, value: !!session || (await cached()) });
    } else if (msg.type === "load") {
      const s = await load((x) => self.postMessage({ id: msg.id, progress: x }));
      self.postMessage({ id: msg.id, ok: true, value: s.kind });
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
