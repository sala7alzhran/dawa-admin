// Boxes whose name is printed in Arabic (only, or in the biggest letters): the Arabic lines read on them
// (cutout-worker's PP-OCRv5 Arabic reader, marked { ar: true }) matched to the list's Arabic names (trade_ar), with the
// strength and the form the box shows. The Latin box matcher (boxmatch.js) reads the rest of the box as before.
import * as N from "./names.js";
import { RULES } from "./rules.js";

// letters the list doesn't use, as the list writes them (ڤاليريان = فاليريان)
const MORE = { "ڤ": "ف", "ڨ": "ف", "پ": "ب", "چ": "ج", "گ": "ك", "ک": "ك", "ی": "ي", "ھ": "ه", "ۀ": "ه" };
const fold = (s) => [...String(s ?? "")].map((c) => MORE[c] ?? c).join("");

/** Only the Arabic letters, normalised as the list's keys are (أ→ا, ة→ه, ى→ي…): "فاست ك" → "فاستك". */
export const letters = (s) => N.normalize(fold(s)).replace(/[^ء-ي]/g, "");
const sound = (s) => N.soundOf(fold(s).replace(/[0-9٠-٩]/g, " "));

// letters a camera often misreads for one another: their dots
const CONFUSABLE = ["بتثني", "جحخ", "دذ", "رز", "سش", "صض", "طظ", "عغ", "فق", "هة"];
function cost(a, b) {
  if (a === b) return 0;
  for (const g of CONFUSABLE) if (g.includes(a) && g.includes(b)) return 0.35;
  return 1;
}
/** 1 = identical (edit distance, the dots' mistakes cheaper). */
export function similarity(a, b) {
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost(a[i - 1], b[j - 1]));
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

const UNITS = [[/(ملغم|ملغ|مغ|ملخ)/, "MG"], [/(ميكروغرام|مكغ|ميكغ)/, "MCG"], [/(مل)/, "ML"], [/(غرام|غم|غ|جرام)/, "G"], [/(وحده دوليه)/, "IU"]];

/**
 * The lines the Latin matcher reads: the Arabic ones left out (they would only be noise to it, and their big letters
 * would make its own lines look small), their amounts kept in its words ("٥٠ ملغ" → "50 MG").
 */
export function forLatin(lines) {
  const out = lines.filter((l) => !l.ar);
  for (const l of lines.filter((x) => x.ar)) {
    let t = N.normalize(fold(l.text)); // Arabic digits → 0-9
    const amounts = [];
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*([ء-ي]+(?:\s[ء-ي]+)?|%)/g)) {
      if (m[2] === "%") { amounts.push(m[1] + "%"); continue; }
      const u = UNITS.find(([rx]) => rx.test(m[2].split(" ")[0]) && m[2].split(" ")[0].replace(rx, "") === "");
      if (u) amounts.push(`${m[1]} ${u[1]}`);
    }
    if (amounts.length) out.push({ ...l, text: amounts.join(" "), ar: undefined, height: Math.min(l.height, 20) });
  }
  return out;
}

/** The forms the box's Arabic names ("شراب", "أقراص", "بخاخ"…), as the list's codes (build_ref_db's FORM_RULES). */
export function formsOf(lines) {
  const out = new Set();
  for (const l of lines.filter((x) => x.ar)) {
    const t = N.normalize(fold(l.text));
    for (const [code, words] of RULES.FORM_RULES) if (words.some((w) => t.includes(N.normalize(w)))) out.add(code);
  }
  if (out.has("DROPS") && out.has("EYE_DROPS")) out.delete("DROPS");
  return out;
}
const near = (a, b) => a === b || [a, b].every((f) => ["DROPS", "EYE_DROPS"].includes(f)) || [a, b].every((f) => ["SYRUP", "SUSP"].includes(f))
  || [a, b].every((f) => ["SPRAY", "INHALER"].includes(f)) || [a, b].every((f) => ["CREAM", "OINT", "GEL"].includes(f));

/** The list's Arabic names, built once: [{ c: box matcher candidate, key: the name's letters, snd: its sound }]. */
export function index(rows, byId) {
  const out = [];
  for (const r of rows) {
    const c = byId.get(r.id);
    const name = String(r.trade_ar ?? "").replace(/[0-9٠-٩.%/]+/g, " ");
    const key = letters(name);
    // the company, as boxes print it in Arabic ("فيتا فارما")
    const mk = letters(r.maker_short || r.maker || "");
    if (c && key.length >= 3) out.push({ c, key, snd: sound(name), mk: mk.length >= 3 ? mk : "" });
  }
  return out;
}

/**
 * The medicines the box's Arabic text names, best first: { matches: [{ candidate, score, name, found, conflicts }],
 * confident }. Sure only when the name is clearly one medicine's, its strength (when it has several) is on the box,
 * and no form on the box says otherwise.
 */
export function match(lines, entries, limit = 6) {
  const ar = lines.filter((l) => l.ar && l.confidence >= 0.6);
  if (!ar.length || !entries?.length) return { matches: [], confident: false };
  const top = Math.max(...ar.map((l) => l.height));
  // the name is in the biggest letters
  const names = ar.filter((l) => l.height >= 0.55 * top).map((l) => ({ key: letters(l.text), snd: sound(l.text), w: l.height / top }))
    .filter((n) => n.key.length >= 3);
  if (!names.length) return { matches: [], confident: false };
  const numbers = new Set();
  for (const l of lines) for (const m of N.normalize(fold(l.text)).matchAll(/\d+(?:\.\d+)?/g)) numbers.add(Number(m[0]));
  const forms = formsOf(ar);
  const all = ar.map((l) => letters(l.text)).join(" ");

  const scored = [];
  for (const e of entries) {
    let name = 0;
    for (const n of names) {
      let s = similarity(e.key, n.key);
      // the box shortening the name ("فاست ك" for "فاست كيه"), or the name and more in the same line (less sure:
      // "فاليريان" is in "فاليريان فيتا", another medicine)
      const k = Math.min(e.key.length, n.key.length);
      if (k >= 4 && k >= 0.65 * Math.max(e.key.length, n.key.length)) s = Math.max(s, (n.key.length < e.key.length ? 0.95 : 0.88) * similarity(e.key.slice(0, k), n.key.slice(0, k)));
      if (e.snd.length >= 3 && e.snd === n.snd) s = Math.max(s, 0.86);
      name = Math.max(name, s * (0.9 + 0.1 * n.w));
    }
    if (name < 0.7) continue;
    const c = e.c;
    const found = new Set(), conflicts = new Set();
    if (name >= 0.82) found.add("NAME");
    let score = 0.6 * name;
    const want = c.amounts.length ? c.amounts.map((a) => a.value) : c.brandNumbers;
    if (want.length) {
      const hits = want.filter((v) => numbers.has(v) || numbers.has(v * 1000)).length;
      if (hits === want.length) { score += 0.2; found.add("STRENGTH"); } else if (hits) score += 0.1;
    }
    if (forms.size && c.formCode && c.formCode !== "OTHER") {
      if ([...forms].some((f) => near(f, c.formCode))) { score += 0.05; found.add("FORM"); } else { score -= 0.15; conflicts.add("FORM"); }
    }
    if (c.packCount && numbers.has(c.packCount)) score += 0.02;
    if (e.mk && all.includes(e.mk)) { score += 0.07; found.add("MAKER"); }
    scored.push({ candidate: c, score, name, found, conflicts });
  }
  scored.sort((a, b) => b.score - a.score);
  // one medicine in several pack sizes counts once
  const seen = new Set(), grouped = [];
  for (const m of scored) if (!seen.has(m.candidate.identity)) { seen.add(m.candidate.identity); grouped.push(m); }
  const best = grouped[0];
  if (!best) return { matches: [], confident: false };
  const second = grouped[1];
  // another medicine with the same Arabic name (another strength, another form) close behind: the box must say which
  const sameName = grouped.slice(1).some((m) => m.name >= best.name - 0.02 && m.score >= best.score - 0.1);
  const confident = best.found.has("NAME") && !best.conflicts.has("FORM") && best.score - (second?.score ?? 0) >= 0.1 && !sameName;
  return { matches: grouped.slice(0, limit), confident };
}

/** The biggest Arabic line: the medicine's Arabic name as printed, for a new medicine's form. */
export function nameOnBox(lines) {
  const ar = lines.filter((l) => l.ar && l.confidence >= 0.7 && letters(l.text).length >= 3);
  if (!ar.length) return "";
  return ar.reduce((a, b) => (b.height > a.height ? b : a)).text.replace(/[0-9٠-٩]+\s*\S*$/, "").trim();
}
