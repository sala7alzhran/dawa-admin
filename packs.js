// The photo packs phones download (public repository sala7alzhran/raff-photos: packs.json + zip parts), read without
// downloading them: only each zip's table of contents, then one photo at a time when it is shown (HTTP ranges).
const BASE = "https://raw.githubusercontent.com/sala7alzhran/raff-photos/main/";

let index = null; // country -> { version, count, entries: Map(refId -> { part, offset, size }) }

async function range(path, from, to) {
  const r = await fetch(BASE + path, { headers: { Range: `bytes=${from}-${to}` }, cache: "no-store" });
  if (r.status !== 206 && r.status !== 200) throw new Error(`pack ${r.status}`);
  return new DataView(await r.arrayBuffer());
}

/** Every photo in the country's pack: which part and where. */
async function contents(part) {
  const size = part.bytes;
  const tailLen = Math.min(size, 65557);
  const tail = await range(part.path, size - tailLen, size - 1);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip");
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = await range(part.path, cdOffset, cdOffset + cdSize - 1);
  const out = [];
  const dec = new TextDecoder();
  let p = 0;
  while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50) {
    const comp = cd.getUint32(p + 20, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    const m = name.match(/^(\d+)\.webp$/);
    if (m) out.push([Number(m[1]), { part: part.path, offset: local, size: comp }]);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The country's pack: version and the ids it has a photo for. */
export async function load(country) {
  if (index?.[country]) return index[country];
  const manifest = await (await fetch(BASE + "packs.json", { cache: "no-store" })).json();
  const pack = manifest.countries?.[country];
  const entries = new Map();
  if (pack) for (const part of pack.parts) for (const [id, e] of await contents(part)) entries.set(id, e);
  index = { ...(index || {}), [country]: { version: pack?.version ?? 0, count: entries.size, entries } };
  return index[country];
}

export const has = (country, id) => !!index?.[country]?.entries.has(Number(id));

const urls = new Map();

/** A link to one pack photo (fetched once, then kept for this visit). */
export async function photoUrl(country, id) {
  const key = country + "/" + id;
  if (urls.has(key)) return urls.get(key);
  const e = index?.[country]?.entries.get(Number(id));
  if (!e) return null;
  const head = await range(e.part, e.offset, e.offset + 29);
  const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const body = await range(e.part, start, start + e.size - 1); // stored, not compressed (photo_pack.py)
  const url = URL.createObjectURL(new Blob([body.buffer], { type: "image/webp" }));
  urls.set(key, url);
  return url;
}
