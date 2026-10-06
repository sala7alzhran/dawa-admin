// Box photos cleaned like the photo packs' (background removed, box centred on white, 480 px WebP), and their printed
// text read. The work runs in its own thread (cutout-worker.js), so the panel stays responsive; the model (about 490 MB) is downloaded once and
// kept by the browser.
let worker = null;
let next = 0;
const waiting = new Map();
// one request at a time: the boxes the admin cuts out are read while the batch's photos are still being cleaned
let line = Promise.resolve();

function ask(type, extra = {}, onProgress) {
  const p = line.then(() => send(type, extra, onProgress));
  line = p.catch(() => {});
  return p;
}

function send(type, extra, onProgress) {
  if (!worker) {
    // the worker of this same version of the panel (its ?v=…)
    worker = new Worker(new URL("./cutout-worker.js" + new URL(import.meta.url).search, import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      if (!w) return;
      if ("progress" in data) return w.onProgress?.(data.progress);
      waiting.delete(data.id);
      data.ok ? w.ok(data.value) : w.bad(new Error(data.error));
    };
  }
  const id = ++next;
  return new Promise((ok, bad) => { waiting.set(id, { ok, bad, onProgress }); worker.postMessage({ type, id, ...extra }); });
}

/** True when the model is already in this browser (no big download needed). */
export const ready = () => ask("ready").catch(() => false);

/** Loads the model, reporting download progress 0..1; resolves to where it runs ("webgpu" or "wasm"). */
export const load = (progress = () => {}) => ask("load", {}, progress);

/** The box's printed text, line by line: { lines: [{ text, confidence, height, x, y, w, ar? }], ms } (PaddleOCR, Latin and Arabic, in the same thread). */
export const read = (file) => ask("read", { file });

/**
 * Cleans one photo: { blob, hash, notes, cut, ms, kind }. [plain] only centres it on white (no model).
 * Where several boxes stand apart in it: { blobs: [[x, y, w, h]] } (0..1 of the photo). [seeds]: where each box of a
 * photo of several is, from its text ([{ pos: [[x, y]], neg: [[x, y]] }], the photo's pixels): { boxes: [[x, y, w, h]] }.
 */
export const clean = (file, { plain = false, seeds = [] } = {}) => ask("clean", { file, plain, seeds });

/** A photo's 128-bit hash (32 hex digits), the same way the cleaned photos and the packs' are hashed. */
export const hash = (file) => ask("hash", { file });

/** How many of the bits differ between two photo hashes (0 = the same picture). */
export function distance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity; // hashes of another kind (an older pack or panel photo) say nothing
  let x = BigInt("0x" + a) ^ BigInt("0x" + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

