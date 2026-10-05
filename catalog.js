// «الأدوية والصور»: the medicines list as phones have it, with the admin's own additions laid over it. Add a
// medicine or a box photo; before anything is saved the panel checks whether it is there already (same barcode, same
// name + strength + form, a name that sounds the same, a photo the medicine already has, the same photo twice) and
// asks. Every change reaches pharmacies within a day (function "lists", action "changes") and can be undone.
import * as N from "./names.js";
import * as Packs from "./packs.js";
import * as Cut from "./cutout.js";

const COUNTRY = "SY";
const SQLJS = "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/";
const COLS = ["id", "trade", "trade_ar", "brand", "brand_key", "maker", "composition", "strength", "pack_count", "pack_unit", "form_ar",
  "form_code", "category_ar", "category_en", "search", "ar_key", "sound", "maker_short", "usd", "source", "cost_usd"];
const SOURCE = { MOH: "قائمة وزارة الصحة", UP: "قائمة الصيادلة المتحدين", CO: "من صور شركة", DW: "أضفته من اللوحة" };
const UNITS = [["TAB", "أقراص"], ["CAP", "محافظ"], ["ML", "مل"], ["G", "غرام"], ["AMP", "أمبولات"], ["VIAL", "فيالات"], ["SACHET", "ظروف"],
  ["SUPP", "تحاميل"], ["", "لا شيء"]];

let ctx; // { call, toast, esc, $ }
let db = null;
let listInfo = null;
let upto = 0; // the newest change the published list already has
let changes = []; // every change, oldest first
const panelPhotos = new Map(); // ref id -> { change, data, url }
const latestOf = new Map(); // "kind/ref" -> change id
let started = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => ctx.esc(s);
const fmtTime = (s) => new Intl.DateTimeFormat("ar-SY-u-nu-latn", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(s));

// ---------------------------------------------------------------- loading

function script(src) {
  return new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = bad; document.head.append(s); });
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadList(progress) {
  progress("أُحمّل قائمة الأدوية…");
  if (!window.initSqlJs) await script(SQLJS + "sql-wasm.js");
  const SQL = await window.initSqlJs({ locateFile: (f) => SQLJS + f });
  listInfo = await ctx.call("catalog_list", { country: COUNTRY });
  if (!listInfo.url) throw new Error("list");
  const gz = new Uint8Array(await (await fetch(listInfo.url)).arrayBuffer());
  if ((await sha256(gz)) !== listInfo.sha256) throw new Error("checksum");
  const raw = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  db = new SQL.Database(raw);
  upto = Number(one("SELECT value FROM meta WHERE key = 'changes'")?.value ?? 0) || 0;
}

function all(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free();
  return out;
}
const one = (sql, params) => all(sql, params)[0] ?? null;

/** Lays one change over the list, as a phone does. */
function apply(c, links = {}) {
  latestOf.set(`${c.kind}/${c.ref_id}`, c.id);
  if (c.kind === "drug") {
    if (c.id <= upto) return;
    db.run("DELETE FROM barcodes WHERE drug_id = ?", [c.ref_id]);
    if (c.action === "put") {
      const d = c.data;
      db.run(`INSERT OR REPLACE INTO drugs (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`,
        COLS.map((k) => (k === "id" ? c.ref_id : d[k] ?? null)));
      for (const code of d.barcodes ?? []) db.run("INSERT OR REPLACE INTO barcodes VALUES (?, ?)", [code, c.ref_id]);
    } else db.run("DELETE FROM drugs WHERE id = ?", [c.ref_id]);
  } else if (c.action === "put") panelPhotos.set(c.ref_id, { change: c.id, data: c.data, url: links[c.data.path] });
  else panelPhotos.delete(c.ref_id);
}

async function loadChanges() {
  const after = changes.length ? changes[changes.length - 1].id : 0;
  const j = await ctx.call("catalog_changes", { country: COUNTRY, after });
  for (const c of j.changes) {
    // an undo marks the change it undid
    if (c.note?.startsWith("undo #")) { const was = changes.find((x) => x.id === Number(c.note.slice(6))); if (was) was.undone_by = c.id; }
    changes.push(c);
    apply(c, j.links);
  }
  // fresh photo links for older ones too (they last an hour)
  for (const [path, url] of Object.entries(j.links)) for (const p of panelPhotos.values()) if (p.data.path === path) p.url = url;
}

async function start() {
  if (started) return;
  started = true;
  const box = $("med-body");
  const progress = (t) => { box.innerHTML = `<div class="card empty">${esc(t)}</div>`; };
  try {
    await Promise.all([loadList(progress), Packs.load(COUNTRY).catch(() => null)]);
    progress("أُحمّل ما أضفته…");
    await loadChanges();
    renderMain();
  } catch (e) {
    started = false;
    box.innerHTML = `<div class="card empty">تعذّر تحميل قائمة الأدوية. تأكّد من الإنترنت ثم <button class="btn small" id="med-retry">حاول مرة أخرى</button></div>`;
    $("med-retry").onclick = start;
    console.error(e);
  }
}

// ---------------------------------------------------------------- looking things up

const drug = (id) => one(`SELECT * FROM drugs WHERE id = ?`, [id]);
const codesOf = (id) => all("SELECT code FROM barcodes WHERE drug_id = ?", [id]).map((r) => r.code);
const byCode = (code) => one("SELECT d.* FROM barcodes b JOIN drugs d ON d.id = b.drug_id WHERE b.code = ?", [code.trim()]);

function search(q, limit = 60) {
  q = q.trim();
  if (!q) return [];
  if (/^\d{6,}$/.test(q)) { const d = byCode(q); return d ? [d] : []; }
  if (/^#\d+$/.test(q)) { const d = drug(Number(q.slice(1))); return d ? [d] : []; }
  const text = N.normalize(q), sq = N.squash(q), snd = N.soundOf(q);
  if (!text) return [];
  return all(
    `SELECT * FROM drugs WHERE (' ' || search) LIKE ? OR (? AND search LIKE ?) OR (? AND sound LIKE ?)
     ORDER BY CASE WHEN ar_key LIKE ? OR brand_key LIKE ? THEN 0 ELSE 1 END, brand, strength LIMIT ?`,
    [`% ${text}%`, sq.length >= 3 ? 1 : 0, `%${sq}%`, snd.length >= 3 ? 1 : 0, `% ${snd}%`, `${text}%`, `${sq}%`, limit],
  );
}

/** Where this medicine's photo comes from now: "panel" (added here), "pack" (the photo pack), or null. */
function photoOf(id) {
  const p = panelPhotos.get(Number(id));
  if (p) return { source: "panel", ...p };
  if (Packs.has(COUNTRY, id)) return { source: "pack" };
  return null;
}
async function photoUrl(id) {
  const p = photoOf(id);
  if (!p) return null;
  return p.source === "panel" ? p.url : Packs.photoUrl(COUNTRY, id);
}

const title = (d) => [d.brand, d.strength].filter(Boolean).join(" ");
const subtitle = (d) => [d.form_ar, d.pack_count ? `${d.pack_count} ${UNITS.find((u) => u[0] === d.pack_unit)?.[1] ?? d.pack_unit}` : "", d.maker_short || d.maker]
  .filter(Boolean).join(" · ");

/** Fills every img[data-photo] inside el with its medicine's photo, when it comes into view. */
function lazyPhotos(el) {
  const seen = new IntersectionObserver((items) => {
    for (const it of items) {
      if (!it.isIntersecting) continue;
      seen.unobserve(it.target);
      photoUrl(it.target.dataset.photo).then((u) => { if (u) { it.target.src = u; it.target.classList.remove("nophoto"); } }).catch(() => {});
    }
  }, { rootMargin: "200px" });
  el.querySelectorAll("img[data-photo]").forEach((img) => seen.observe(img));
}

function medRow(d, i) {
  const has = photoOf(d.id);
  const mine = latestOf.has(`drug/${d.id}`) && d.source === "DW";
  return `<div class="card row med" data-i="${i}">
    <img class="thumb nophoto" data-photo="${d.id}" alt="">
    <div class="main"><div class="name" dir="auto">${esc(title(d))}</div><div class="meta">${esc(d.trade_ar)} · ${esc(subtitle(d))}</div>
    <div class="badges">${has ? "" : `<span class="pill p-ended">بلا صورة</span>`}${d.usd == null ? `<span class="pill p-exp">بلا سعر</span>` : ""}${mine ? `<span class="pill p-sub">أضفته أنت</span>` : ""}</div></div></div>`;
}

// ---------------------------------------------------------------- the main view

function renderMain() {
  const count = one("SELECT COUNT(*) AS n FROM drugs").n;
  $("med-body").innerHTML = `
    <p class="sub">${count.toLocaleString("en")} دواء في القائمة. ما تضيفه هنا يصل إلى الصيدليات خلال يوم.</p>
    <div class="actions">
      <button class="btn" id="add-photos">أضف صورًا</button>
      <button class="btn" id="add-med">أضف دواءً</button>
    </div>
    <input type="file" id="photo-files" accept="image/*" multiple class="hidden">
    <input id="mq" type="search" placeholder="ابحث عن دواء: بالاسم، بالعربي أو الإنجليزي، أو بالباركود" style="margin-top:16px">
    <div class="list" id="mlist" style="margin-top:12px"></div>
    <h2>آخر ما أضفته وغيّرته</h2>
    <div class="card" id="recent"></div>`;
  $("add-med").onclick = () => medForm(null);
  $("add-photos").onclick = () => $("photo-files").click();
  $("photo-files").onchange = (e) => { const files = [...e.target.files]; e.target.value = ""; if (files.length) batch(files); };
  let t;
  $("mq").oninput = () => { clearTimeout(t); t = setTimeout(renderSearch, 180); };
  renderSearch();
  renderRecent();
}

let shown = [];
function renderSearch() {
  const q = $("mq")?.value ?? "";
  shown = search(q);
  const el = $("mlist");
  if (!q.trim()) { el.innerHTML = ""; return; }
  el.innerHTML = shown.length ? shown.map(medRow).join("") : `<div class="card empty">لا دواء بهذا الاسم في القائمة. <button class="btn small" id="add-this">أضفه</button></div>`;
  if (!shown.length) $("add-this").onclick = () => medForm(null, { brand: /[a-z]/i.test(q) ? q : "", trade_ar: /[a-z]/i.test(q) ? "" : q });
  el.querySelectorAll(".med").forEach((r) => (r.onclick = () => medSheet(shown[Number(r.dataset.i)].id)));
  lazyPhotos(el);
}

/** The change now in effect for its medicine or photo (every newer one undone, or an undo): the one that can be undone. */
function inEffect(c) {
  if (c.undone_by || c.note?.startsWith("undo #")) return false;
  return changes.every((n) => n.id <= c.id || n.kind !== c.kind || n.ref_id !== c.ref_id || n.undone_by || n.note?.startsWith("undo #"));
}

const ACT = {
  drug: { put: (c) => (c.before ? "عُدّلت بياناته" : "أُضيف إلى القائمة"), remove: () => "حُذف من القائمة" },
  photo: { put: (c) => (c.before ? "استُبدلت صورته" : "أُضيفت صورته"), remove: () => "أُعيدت صورته السابقة" },
};
function changeName(c) {
  const d = drug(c.ref_id) ?? c.data ?? c.before?.row;
  return d?.brand ? title(d) : c.data?.name || `#${c.ref_id}`;
}
function renderRecent() {
  const el = $("recent");
  if (!el) return;
  const list = changes.slice(-40).reverse();
  el.innerHTML = list.length ? list.map((c) => {
    const isUndo = c.note?.startsWith("undo #");
    const canUndo = inEffect(c);
    const what = isUndo ? "تراجعتَ عن تغيير" : ACT[c.kind][c.action](c);
    return `<div class="logrow"><div class="t">${fmtTime(c.at)}</div><div style="flex:1"><a href="#" data-open="${c.ref_id}" dir="auto">${esc(changeName(c))}</a> · ${what}
      ${c.undone_by ? `<span class="pill p-exp">تراجعتَ عنه</span>` : ""}</div>
      ${canUndo ? `<button class="btn ghost small" data-undo="${c.id}">تراجع</button>` : ""}</div>`;
  }).join("") : `<div class="empty">لم تضف شيئًا بعد.</div>`;
  el.querySelectorAll("[data-open]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); if (drug(Number(a.dataset.open))) medSheet(Number(a.dataset.open)); }));
  el.querySelectorAll("[data-undo]").forEach((b) => (b.onclick = () => undo(Number(b.dataset.undo))));
}

async function undo(id) {
  const c = changes.find((x) => x.id === id);
  const text = c.kind === "drug" ? (c.before ? "سترجع بيانات الدواء كما كانت قبل هذا التعديل." : "سيُحذف هذا الدواء الذي أضفته من القائمة.")
    : (c.before?.source === "panel" ? "سترجع الصورة التي كانت قبلها." : c.before?.source === "pack" ? "سترجع صورته من حزمة الصور." : "ستُحذف هذه الصورة، ويبقى الدواء بلا صورة.");
  if (!confirm(`${changeName(c)}\n\n${text}\nيصل التراجع إلى الصيدليات خلال يوم. متأكد؟`)) return;
  const j = await ctx.call("undo", { change: id });
  if (!j.ok) return ctx.toast(j.error === "newer_change" ? "هناك تغيير أحدث لهذا الدواء: تراجع عنه أولًا." : "لم يتم. حاول مرة أخرى.");
  await loadChanges();
  ctx.toast("تم التراجع.");
  refresh();
}

function refresh() { renderSearch(); renderRecent(); }

// ---------------------------------------------------------------- dialogs (over the sheet)

function dialog(html) {
  const bg = document.createElement("div");
  bg.className = "sheet-bg dlg";
  bg.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.append(bg);
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  return bg;
}
const closeAll = () => document.querySelectorAll(".dlg").forEach((d) => d.remove());

// ---------------------------------------------------------------- one medicine

async function medSheet(id) {
  const d = drug(id);
  if (!d) return;
  const codes = codesOf(id);
  const hist = changes.filter((c) => c.ref_id === id).reverse();
  const kv = (k, v, ltr) => (v || v === 0 ? `<div class="kv"><span class="k">${k}</span><span class="v" ${ltr ? 'dir="ltr"' : 'style="direction:rtl"'}>${esc(v)}</span></div>` : "");
  const p = photoOf(id);
  const bg = dialog(`
    <div style="display:flex;align-items:center;gap:10px;justify-content:space-between"><h1 style="margin:0" dir="auto">${esc(title(d))}</h1>
    <button class="btn ghost small" data-x>إغلاق</button></div>
    <p class="sub" style="margin:4px 0 12px">${esc(d.trade_ar)}</p>
    <div class="photo-big">${p ? `<img id="big-photo" alt="">` : `<div class="empty">لا صورة لهذا الدواء</div>`}</div>
    <p class="note" style="text-align:center">${p?.source === "panel" ? "صورة أضفتها من اللوحة" : p?.source === "pack" ? "من حزمة الصور" : ""}</p>
    <div class="actions"><button class="btn" data-photo>${p ? "غيّر الصورة" : "أضف صورة"}</button><button class="btn ghost" data-edit>عدّل بياناته</button></div>
    <input type="file" accept="image/*" class="hidden" data-file>
    <div class="card" style="margin-top:12px">
      ${kv("العيار", d.strength, true)}${kv("الشكل", d.form_ar)}${kv("العبوة", d.pack_count ? subtitle({ ...d, form_ar: "", maker_short: "", maker: "" }) : "")}
      ${kv("المادة الفعالة", d.composition, true)}${kv("الشركة", d.maker)}${kv("الفئة", d.category_ar)}
      ${kv("سعر البيع", d.usd != null ? `${d.usd} $` : "لا سعر")}${kv("التكلفة", d.cost_usd != null ? `${d.cost_usd} $` : "")}
      ${kv("الباركود", codes.join("، "), true)}${kv("المصدر", SOURCE[d.source] ?? d.source)}${kv("رقمه في القائمة", String(d.id), true)}
    </div>
    ${hist.length ? `<h2>تغييراته</h2><div class="card">${hist.map((c) => `<div class="logrow"><div class="t">${fmtTime(c.at)}</div><div>${c.note?.startsWith("undo #") ? "تراجع" : ACT[c.kind][c.action](c)}${c.undone_by ? " · تراجعتَ عنه" : ""}</div></div>`).join("")}</div>` : ""}`);
  bg.querySelector("[data-x]").onclick = () => bg.remove();
  if (p) photoUrl(id).then((u) => { if (u && bg.querySelector("#big-photo")) bg.querySelector("#big-photo").src = u; });
  bg.querySelector("[data-edit]").onclick = () => { bg.remove(); medForm(d); };
  bg.querySelector("[data-photo]").onclick = () => bg.querySelector("[data-file]").click();
  bg.querySelector("[data-file]").onchange = (e) => { const f = e.target.files[0]; if (f) { bg.remove(); batch([f], d.id); } };
}

// ---------------------------------------------------------------- add or change a medicine

const FIELDS = [
  ["brand", "الاسم بالإنجليزية (كما على العلبة)", "AUGMENTIN", true],
  ["trade_ar", "الاسم بالعربية", "يُقترح وحده من الإنجليزي، ويمكنك تغييره"],
  ["strength", "العيار", "500 mg"],
  ["form_ar", "الشكل", "أقراص", true],
  ["pack_count", "عدد ما في العبوة", "30"],
  ["pack_unit", "الوحدة", ""],
  ["composition", "المادة الفعالة", "AMOXICILLIN+CLAVULANIC ACID"],
  ["maker", "الشركة", "ابدأ بالكتابة واختر من القائمة"],
  ["barcodes", "الباركود (إن وُجد)", "6251234567890"],
  ["usd", "سعر البيع بالدولار", "2.50"],
  ["cost_usd", "التكلفة بالدولار (اختياري)", "1.85"],
];
const LABEL = Object.fromEntries(FIELDS.map(([k, l]) => [k, l.replace(/ \(.*\)$/, "")]));

function options(sql) { return all(sql).map((r) => Object.values(r)[0]).filter(Boolean); }

/** The admin's form: empty for a new medicine, filled to change one ([d] from the list). */
function medForm(d, preset = {}) {
  const editing = !!d;
  const v = editing ? { ...d, barcodes: codesOf(d.id).join(" ") } : { pack_unit: "TAB", ...preset };
  const forms = options("SELECT form_ar FROM drugs WHERE form_ar != '' GROUP BY form_ar ORDER BY COUNT(*) DESC LIMIT 80");
  const makers = options("SELECT DISTINCT maker FROM drugs WHERE maker != '' ORDER BY maker");
  const comps = options("SELECT composition FROM drugs WHERE composition != '' GROUP BY composition ORDER BY COUNT(*) DESC LIMIT 3000");
  const input = ([k, label, ph, req]) => {
    const val = v[k] ?? "";
    let field;
    if (k === "pack_unit") field = `<select id="f-${k}">${UNITS.map(([c, n]) => `<option value="${c}" ${c === val ? "selected" : ""}>${n}</option>`).join("")}</select>`;
    else field = `<input id="f-${k}" type="text" value="${esc(val)}" placeholder="${esc(ph)}" ${["brand", "strength", "composition", "barcodes", "usd", "cost_usd", "pack_count"].includes(k) ? 'dir="ltr"' : ""}
      ${k === "form_ar" ? 'list="dl-forms"' : k === "maker" ? 'list="dl-makers"' : k === "composition" ? 'list="dl-comps"' : ""} ${["usd", "cost_usd", "pack_count"].includes(k) ? 'inputmode="decimal"' : ""}>`;
    return `<div class="${["pack_count", "pack_unit", "usd", "cost_usd"].includes(k) ? "half" : "full"}"><label for="f-${k}">${label}${req ? " *" : ""}</label>${field}</div>`;
  };
  const bg = dialog(`
    <div style="display:flex;align-items:center;gap:10px;justify-content:space-between"><h1 style="margin:0">${editing ? "تعديل دواء" : "دواء جديد"}</h1>
    <button class="btn ghost small" data-x>إغلاق</button></div>
    ${editing ? `<p class="sub" dir="auto">${esc(title(d))}</p>` : `<p class="sub">اكتب ما على العلبة. أثناء الكتابة أبحث في القائمة كلها، وأنبّهك إن كان الدواء موجودًا.</p>`}
    <div class="form">${FIELDS.map(input).join("")}</div>
    <datalist id="dl-forms">${forms.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
    <datalist id="dl-makers">${makers.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
    <datalist id="dl-comps">${comps.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
    <div id="f-check"></div>
    <button class="btn wide" data-save>${editing ? "احفظ التعديل" : "أضف الدواء"}</button>
    <p class="note">${editing ? "يصل التعديل إلى الصيدليات خلال يوم، وتستطيع التراجع عنه." : "الحقول التي عليها * لازمة. الباقي يمكن إضافته لاحقًا."}</p>`);
  bg.querySelector("[data-x]").onclick = () => bg.remove();
  // the Arabic name follows the English one until the admin types their own
  const ar = bg.querySelector("#f-trade_ar");
  let arTouched = editing || !!v.trade_ar;
  const read = () => {
    const f = {};
    for (const [k] of FIELDS) f[k] = bg.querySelector("#f-" + k).value.trim();
    f.barcodes = f.barcodes.split(/[\s,،]+/).filter(Boolean);
    const cs = N.cleanStrength(f.strength);
    if (cs) f.strength = cs;
    f.auto = new Set([...(arTouched ? [] : ["trade_ar"]), ...(f.pack_count ? [] : ["pack_unit"])]); // filled in by the form, not by the admin
    return f;
  };
  ar.oninput = () => { arTouched = true; check(); };
  const suggestAr = () => { if (!arTouched) ar.value = N.arabicName(bg.querySelector("#f-brand").value.trim().toUpperCase(), bg.querySelector("#f-maker").value.trim()); };
  let t;
  const check = () => { clearTimeout(t); t = setTimeout(() => showCheck(bg, read(), d), 200); };
  bg.querySelectorAll("input,select").forEach((el) => { if (el !== ar) el.addEventListener("input", () => { suggestAr(); check(); }); });
  suggestAr();
  check();
  bg.querySelector("[data-save]").onclick = () => saveMed(bg, read(), d);
}

/** What the list already has that looks like this: exact (same barcode, or same name, strength and form) and close. */
function findSame(f, selfId) {
  const exact = [];
  const why = new Map();
  for (const code of f.barcodes) {
    const hit = byCode(code);
    if (hit && hit.id !== selfId) { exact.push(hit); why.set(hit.id, `الباركود ${code} له`); }
  }
  const brand = f.brand.toUpperCase();
  const otherPack = [];
  if (brand.length >= 2) {
    const key = N.squash(brand), fc = f.form_ar ? N.formCode(f.form_ar) : "";
    const pack = Number(f.pack_count) || 0;
    for (const r of all("SELECT * FROM drugs WHERE brand_key = ?", [key])) {
      if (r.id === selfId || why.has(r.id)) continue;
      if (N.squash(r.strength) !== N.squash(f.strength) || (fc && r.form_code !== fc)) continue;
      // the same medicine in another pack size is a different item in the list (unless no size was written)
      if (pack && r.pack_count && r.pack_count !== pack) { otherPack.push(r); why.set(r.id, `نفسه بعبوة أخرى (${r.pack_count})`); continue; }
      exact.push(r);
      why.set(r.id, "نفس الاسم والعيار والشكل");
    }
  }
  let close = [...otherPack];
  if (brand.length >= 3) {
    const key = N.squash(brand), snd = N.soundOf(brand);
    close.push(...all(`SELECT * FROM drugs WHERE brand_key LIKE ? OR (? AND (' ' || sound) LIKE ?) ORDER BY brand_key = ? DESC, brand LIMIT 12`,
      [key.slice(0, Math.max(3, key.length - 2)) + "%", snd.length >= 3 ? 1 : 0, `% ${snd} %`, key])
      .filter((r) => r.id !== selfId && !why.has(r.id)));
  }
  return { exact, why, close: close.slice(0, 8) };
}

function showCheck(bg, f, d) {
  const el = bg.querySelector("#f-check");
  if (!f.brand && !f.barcodes.length) { el.innerHTML = ""; return; }
  const { exact, why, close } = findSame(f, d?.id);
  const item = (r, reason) => `<div class="row hit" data-open="${r.id}"><img class="thumb small nophoto" data-photo="${r.id}" alt="">
    <div class="main"><div class="name" dir="auto">${esc(title(r))}</div><div class="meta">${esc(subtitle(r))}${reason ? " · " + esc(reason) : ""}</div></div></div>`;
  el.innerHTML = (exact.length ? `<div class="msg err" style="margin-top:12px"><b>هذا الدواء موجود في القائمة</b>${exact.map((r) => item(r, why.get(r.id))).join("")}</div>` : "")
    + (close.length ? `<div class="msg warn" style="margin-top:12px"><b>أدوية قريبة في القائمة: هل تقصد أحدها؟</b>${close.map((r) => item(r, why.get(r.id) ?? "")).join("")}</div>` : "")
    + (!exact.length && !close.length && f.brand.length >= 3 ? `<div class="msg ok" style="margin-top:12px">لا يوجد دواء بهذا الاسم في القائمة.</div>` : "");
  el.querySelectorAll("[data-open]").forEach((r) => (r.onclick = () => { bg.remove(); medSheet(Number(r.dataset.open)); }));
  lazyPhotos(el);
}

const SHOWN = ["brand", "trade_ar", "strength", "form_ar", "pack_count", "pack_unit", "composition", "maker", "barcodes", "usd", "cost_usd"];
const show = (k, v) => (k === "barcodes" ? (v || []).join("، ") : k === "pack_unit" ? UNITS.find((u) => u[0] === v)?.[1] ?? v : v ?? "");
const same = (k, a, b) => (k === "barcodes" ? [...(a || [])].sort().join() === [...(b || [])].sort().join() : String(a ?? "").trim() === String(b ?? "").trim());

/** A medicine's row from the list (with its barcodes), in the form's terms. */
const asForm = (r) => ({ ...r, pack_count: r.pack_count ? String(r.pack_count) : "", usd: r.usd ?? "", cost_usd: r.cost_usd ?? "", barcodes: codesOf(r.id) });
/** A medicine's row exactly as the list has it, kept with a change so that undoing puts it back. */
const keep = (r) => { const { id, ...row } = r; return { ...row, barcodes: codesOf(id) }; };
/** Fields the admin filled in themselves (not left empty, not filled in by the form). */
const filled = (f, k) => !f.auto?.has(k) && (k === "barcodes" ? f[k].length > 0 : String(f[k] ?? "") !== "");

/** The table of differences: what the list has, what the admin wrote; only what they wrote counts. */
function diffTable(old, f) {
  const rows = SHOWN.filter((k) => filled(f, k)).map((k) => {
    const differs = !same(k, old[k], f[k]);
    return `<tr><td class="k">${LABEL[k]}</td><td dir="auto">${esc(show(k, old[k])) || '<span class="muted">لا شيء</span>'}</td>
      <td dir="auto">${differs ? `<span class="diff">${esc(show(k, f[k]))}</span>` : esc(show(k, f[k]))}</td></tr>`;
  });
  return `<table class="cmp"><tr class="muted"><td></td><td>الموجود</td><td>ما كتبته</td></tr>${rows.join("")}</table>`;
}

/** The row to save: the list's row with every field the admin filled in replaced (empty fields keep what was there). */
function merged(old, f) {
  const out = { ...old };
  for (const k of SHOWN) {
    if (k === "barcodes") { out.barcodes = [...new Set([...(old.barcodes || []), ...f.barcodes])]; continue; }
    if (filled(f, k)) out[k] = f[k];
  }
  return out;
}

async function put(row, ref, before, note) {
  const data = N.drugRow({ ...row, barcodes: row.barcodes, category_ar: before?.row && N.squash(before.row.composition) === N.squash(row.composition) ? before.row.category_ar : "",
    category_en: before?.row && N.squash(before.row.composition) === N.squash(row.composition) ? before.row.category_en : "",
    source: before?.row?.source || "DW", maker_short: before?.row && before.row.maker === row.maker ? before.row.maker_short : "" });
  const j = await ctx.call("drug_put", { country: COUNTRY, ref_id: ref ?? null, data, before, note });
  if (!j.ok) { ctx.toast("لم يُحفظ: " + (j.error || "حاول مرة أخرى")); return null; }
  await loadChanges();
  refresh();
  return j.ref_id;
}

async function saveMed(bg, f, d) {
  if (!f.brand) return ctx.toast("اكتب اسم الدواء بالإنجليزية كما على العلبة.");
  if (!f.form_ar) return ctx.toast("اختر شكل الدواء (أقراص، شراب…).");
  for (const k of ["usd", "cost_usd", "pack_count"]) if (f[k] && !(Number(f[k]) >= 0)) return ctx.toast(`${LABEL[k]}: اكتب رقمًا.`);
  if (d) {
    // changing a medicine: show what changes, then save
    const old = asForm(d);
    const full = { ...f, barcodes: f.barcodes };
    const changed = SHOWN.filter((k) => !same(k, old[k], full[k]));
    if (!changed.length) return ctx.toast("لم تغيّر شيئًا.");
    const dlg = dialog(`<h1>احفظ هذه التغييرات؟</h1><p class="sub" dir="auto">${esc(title(d))}</p>
      <table class="cmp"><tr class="muted"><td></td><td>كان</td><td>يصبح</td></tr>${changed.map((k) => `<tr><td class="k">${LABEL[k]}</td><td dir="auto">${esc(show(k, old[k])) || '<span class="muted">لا شيء</span>'}</td><td dir="auto"><span class="diff">${esc(show(k, full[k])) || "لا شيء"}</span></td></tr>`).join("")}</table>
      <div class="actions"><button class="btn" data-ok>احفظ</button><button class="btn ghost" data-no>رجوع</button></div>`);
    dlg.querySelector("[data-no]").onclick = () => dlg.remove();
    dlg.querySelector("[data-ok]").onclick = async () => {
      const ref = await put({ ...old, ...full }, d.id, { row: keep(d), source: "list" });
      if (ref) { closeAll(); ctx.toast("حُفظ. يصل إلى الصيدليات خلال يوم."); }
    };
    return;
  }
  const { exact } = findSame(f, null);
  if (exact.length) {
    const old = asForm(exact[0]);
    const dlg = dialog(`<h1>هذا الدواء موجود في القائمة</h1>
      <p class="sub" dir="auto">${esc(title(exact[0]))} · ${esc(subtitle(exact[0]))}</p>
      <p class="note">المختلف ملوّن. «حدّث المختلف فقط» يضع ما كتبتَه مكان القديم، ولا يمحو شيئًا تركته فارغًا.</p>
      ${diffTable(old, f)}
      <div class="actions" style="grid-template-columns:1fr"><button class="btn" data-upd>حدّث المختلف فقط</button>
      <button class="btn ghost" data-new>إنه دواء آخر، أضفه</button><button class="btn ghost" data-no>إلغاء</button></div>`);
    dlg.querySelector("[data-no]").onclick = () => dlg.remove();
    dlg.querySelector("[data-upd]").onclick = async () => {
      if (!SHOWN.some((k) => filled(f, k) && !same(k, old[k], f[k]))) { closeAll(); return ctx.toast("لا جديد فيما كتبتَه: الدواء كما هو."); }
      const ref = await put(merged(old, f), exact[0].id, { row: keep(exact[0]), source: "list" });
      if (ref) { closeAll(); ctx.toast("حُدّث الدواء الموجود."); }
    };
    dlg.querySelector("[data-new]").onclick = async () => {
      const ref = await put(f, null, null);
      if (ref) { closeAll(); ctx.toast("أُضيف الدواء."); medSheet(ref); }
    };
    return;
  }
  if (!confirm(`سيُضاف «${title({ brand: f.brand.toUpperCase(), strength: f.strength })}» إلى قائمة الأدوية عند كل الصيدليات. متأكد؟`)) return;
  const ref = await put(f, null, null);
  if (ref) { closeAll(); ctx.toast("أُضيف الدواء. يصل إلى الصيدليات خلال يوم."); medSheet(ref); }
}

// ---------------------------------------------------------------- box photos

const toBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Photos waiting in the add-photos screen: { file, src, out, ref, state, note } */
let queue = [];

function batch(files, ref = null) {
  queue = files.map((file) => ({ file, src: URL.createObjectURL(file), out: null, outUrl: null, ref, state: "wait", plain: false }));
  const bg = dialog(`
    <div style="display:flex;align-items:center;gap:10px;justify-content:space-between"><h1 style="margin:0">إضافة صور</h1>
    <button class="btn ghost small" data-x>إغلاق</button></div>
    <p class="sub">تُقصّ خلفية كل صورة وتصبح بيضاء مثل صور التطبيق. اختر لكل صورة دواءها، ثم احفظ.</p>
    <div id="model-state"></div>
    <div class="list" id="queue"></div>
    <button class="btn wide" data-all>احفظ كل الصور الجاهزة</button>`);
  bg.classList.add("wide-sheet");
  bg.querySelector("[data-x]").onclick = () => { bg.remove(); queue = []; };
  bg.querySelector("[data-all]").onclick = saveAll;
  renderQueue();
  work();
}

async function work() {
  const state = $("model-state");
  try {
    if (!(await Cut.ready())) state.innerHTML = `<div class="msg warn">أداة قص الخلفية تُنزَّل الآن مرة واحدة فقط (نحو 490 ميغابايت)، ثم تبقى في هذا المتصفح. <span id="model-pct"></span></div>`;
    else state.innerHTML = `<div class="msg ok">أُجهّز أداة قص الخلفية…</div>`;
    await Cut.load((x) => { const el = $("model-pct"); if (el) el.textContent = Math.round(x * 100) + "٪"; });
    state.innerHTML = "";
  } catch (e) {
    console.error(e);
    state.innerHTML = `<div class="msg err">تعذّر تشغيل أداة قص الخلفية في هذا المتصفح. تستطيع حفظ الصور كما هي على خلفية بيضاء.</div>`;
    for (const q of queue) q.plain = true;
  }
  for (const q of queue) {
    if (q.state !== "wait") continue;
    q.state = "busy";
    renderQueue();
    try {
      const r = await Cut.clean(q.file, { plain: q.plain });
      q.out = r;
      if (q.outUrl) URL.revokeObjectURL(q.outUrl);
      q.outUrl = URL.createObjectURL(r.blob);
      q.state = "done";
    } catch (e) {
      console.error(e);
      q.state = "error";
    }
    renderQueue();
  }
}

/** Another photo (in the list or in this batch) that looks the same as this one. */
function lookalike(q) {
  if (!q.out) return null;
  for (const [ref, p] of panelPhotos) if (p.data.dhash && ref !== q.ref && Cut.distance(p.data.dhash, q.out.hash) <= 6) return drug(ref);
  for (const o of queue) if (o !== q && o.out && Cut.distance(o.out.hash, q.out.hash) <= 6) return { brand: "صورة أخرى في هذه الدفعة", strength: "" };
  return null;
}

function renderQueue() {
  const el = $("queue");
  if (!el) return;
  el.innerHTML = queue.map((q, i) => {
    const d = q.ref ? drug(q.ref) : null;
    const p = d ? photoOf(d.id) : null;
    const twin = lookalike(q);
    const status = { wait: "تنتظر دورها…", busy: "أقصّ الخلفية…", error: "تعذّر قصها." }[q.state] ?? "";
    return `<div class="card qcard" data-i="${i}">
      <div class="qimgs">
        <figure><img src="${q.src}" alt=""><figcaption>الأصلية</figcaption></figure>
        <figure>${q.outUrl ? `<img src="${q.outUrl}" alt="">` : `<div class="ph">${status}</div>`}<figcaption>الجديدة</figcaption></figure>
        ${p ? `<figure><img data-photo="${d.id}" alt=""><figcaption>الحالية للدواء</figcaption></figure>` : ""}
      </div>
      ${q.out?.notes?.length ? `<div class="note">${q.out.notes.map(esc).join("<br>")}</div>` : ""}
      ${q.state === "done" ? `<label class="tick"><input type="checkbox" data-plain ${q.plain ? "checked" : ""}> القص غير صحيح؟ استعمل الصورة كما هي على خلفية بيضاء</label>` : ""}
      ${d ? `<div class="row" style="margin-top:8px"><div class="main"><div class="name" dir="auto">${esc(title(d))}</div><div class="meta">${esc(subtitle(d))}</div></div>
          <button class="btn ghost small" data-change>غيّر الدواء</button></div>`
        : `<label>لأي دواء هذه الصورة؟</label><input type="search" data-q placeholder="اكتب اسم الدواء أو امسح باركوده"><div class="list picks" data-picks></div>`}
      ${twin ? `<div class="msg warn">هذه الصورة تشبه صورة «${esc(title(twin))}». تأكّد أنك لم تضعها مرتين.</div>` : ""}
      ${d && p && q.state === "done" ? `<div class="msg warn"><b>لهذا الدواء صورة من قبل</b> (${p.source === "panel" ? "أضفتها من اللوحة" : "من حزمة الصور"}). قارن، ثم اختر.</div>
          <div class="actions"><button class="btn" data-save>استبدلها بالجديدة</button><button class="btn ghost" data-drop>أبقِ الحالية</button></div>`
        : d && q.state === "done" ? `<div class="actions"><button class="btn" data-save>احفظ الصورة</button><button class="btn ghost" data-drop>احذفها من هنا</button></div>`
        : `<div class="actions"><button class="btn ghost" data-drop>احذفها من هنا</button></div>`}
    </div>`;
  }).join("") || `<div class="card empty">انتهت الصور.</div>`;
  el.querySelectorAll(".qcard").forEach((card) => {
    const q = queue[Number(card.dataset.i)];
    const search_ = card.querySelector("[data-q]");
    if (search_) {
      search_.oninput = () => {
        const res = search(search_.value, 6);
        const picks = card.querySelector("[data-picks]");
        picks.innerHTML = res.map((r, j) => `<div class="row hit" data-j="${j}"><img class="thumb small nophoto" data-photo="${r.id}" alt="">
          <div class="main"><div class="name" dir="auto">${esc(title(r))}</div><div class="meta">${esc(subtitle(r))}${photoOf(r.id) ? "" : " · بلا صورة"}</div></div></div>`).join("");
        picks.querySelectorAll("[data-j]").forEach((p) => (p.onclick = () => { q.ref = res[Number(p.dataset.j)].id; renderQueue(); }));
        lazyPhotos(picks);
      };
    }
    card.querySelector("[data-change]")?.addEventListener("click", () => { q.ref = null; renderQueue(); });
    card.querySelector("[data-drop]")?.addEventListener("click", () => { queue.splice(queue.indexOf(q), 1); renderQueue(); });
    card.querySelector("[data-save]")?.addEventListener("click", () => savePhoto(q));
    card.querySelector("[data-plain]")?.addEventListener("change", async (e) => {
      q.plain = e.target.checked; q.state = "wait"; renderQueue(); work();
    });
  });
  lazyPhotos(el);
}

async function savePhoto(q, quiet = false) {
  const d = drug(q.ref);
  const p = photoOf(q.ref);
  const before = p?.source === "panel" ? { source: "panel", change: p.change, data: p.data } : p?.source === "pack" ? { source: "pack" } : null;
  const j = await ctx.call("photo_put", { country: COUNTRY, ref_id: q.ref, image: await toBase64(q.out.blob), dhash: q.out.hash,
    name: title(d), before });
  if (!j.ok) { ctx.toast("لم تُحفظ الصورة: " + (j.error || "حاول مرة أخرى")); return false; }
  queue.splice(queue.indexOf(q), 1);
  await loadChanges();
  renderQueue();
  refresh();
  if (!quiet) ctx.toast(before ? "استُبدلت الصورة. تصل إلى الصيدليات خلال يوم." : "حُفظت الصورة. تصل إلى الصيدليات خلال يوم.");
  return true;
}

async function saveAll() {
  // only the ready ones that don't need a decision (a medicine chosen, and it has no photo yet)
  const ready = queue.filter((q) => q.state === "done" && q.ref && !photoOf(q.ref) && !lookalike(q));
  const waiting = queue.length - ready.length;
  if (!ready.length) return ctx.toast(waiting ? "كل صورة باقية تحتاج قرارك: اختر دواءها، أو قرّر هل تستبدل الصورة الموجودة." : "لا صور جاهزة.");
  let n = 0;
  for (const q of ready) if (await savePhoto(q, true)) n++;
  ctx.toast(`حُفظت ${n} صورة.` + (queue.length ? ` باقي ${queue.length} تحتاج قرارك.` : ""));
}

// ---------------------------------------------------------------- entry

export function initCatalog(c) {
  ctx = c;
  return { open: start };
}
