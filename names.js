// A medicine's names and search keys, made exactly as tools/build_ref_db.py makes them (and TextTools.kt reads them),
// so a medicine added from the panel is found on a phone like any other: Arabic or Latin, any common spelling.
// tools/panel_names_check.mjs checks these against every medicine in the list.
import { RULES } from "./rules.js";

const TASHKEEL = /[ً-ْٰـ]/g;
const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /\p{Nd}/u;

export function normalize(s) {
  s = String(s ?? "").toLowerCase().replace(TASHKEEL, "");
  let out = "";
  for (let ch of s) {
    if ("أإآٱ".includes(ch)) ch = "ا";
    else if (ch === "ة") ch = "ه";
    else if (ch === "ى") ch = "ي";
    else if (ch === "ؤ") ch = "و";
    else if (ch === "ئ") ch = "ي";
    else if (ch >= "٠" && ch <= "٩") ch = String.fromCharCode(48 + ch.charCodeAt(0) - 0x660);
    else if (!(ALNUM.test(ch) || ch === "." || ch === "%")) ch = " ";
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

export const squash = (s) => normalize(s).replaceAll(" ", "");

export function searchKey(...parts) {
  const joined = parts.filter((p) => p && p.trim()).join(" ");
  return normalize(joined) + " " + squash(joined);
}

// ---------------------------------------------------------------- transliteration

const VOWELS = "aeiouy";

function translitLetters(w) {
  const out = [];
  const at = (k) => (k >= 0 && k < w.length ? w[k] : " ");
  const append = (s) => {
    if (s.length === 1 && out.length && out[out.length - 1] === s && !"اوي".includes(s)) return;
    if (s.length === 1 && "اوي".includes(s) && out.length && out[out.length - 1] === s) return;
    out.push(s);
  };
  let i = 0;
  while (i < w.length) {
    const c = w[i];
    const start = i === 0;
    const three = w.slice(i, i + 3);
    const two = w.slice(i, i + 2);
    if (three === "sch") { append("ش"); i += 3; }
    else if (w.startsWith("tion", i)) { append("شن"); i += 4; }
    else if (two === "sh") { append("ش"); i += 2; }
    else if (two === "ch") { append("ك"); i += 2; }
    else if (two === "ph") { append("ف"); i += 2; }
    else if (two === "th") { append("ت"); i += 2; }
    else if (two === "kh") { append("خ"); i += 2; }
    else if (two === "gh") { append("غ"); i += 2; }
    else if (two === "ck") { append("ك"); i += 2; }
    else if (two === "qu") { append("كو"); i += 2; }
    else if (start && (two === "au" || two === "ou")) { append("أو"); i += 2; }
    else if (two === "ou" || two === "oo" || two === "au") { append("و"); i += 2; }
    else if (two === "ee" || two === "ea" || two === "ie") { append("ي"); i += 2; }
    else if (two === "ai" || two === "ay" || two === "ei" || two === "ey") { append("اي"); i += 2; }
    else if (VOWELS.includes(c) && c !== "y") {
      const last = i === w.length - 1;
      if (start) append({ a: "أ", e: "إ", i: "إ" }[c] ?? "أو");
      else if (last && c === "e" && w.length > 3 && !VOWELS.includes(at(i - 1))) { /* silent final e */ }
      else append({ a: "ا", e: "ي", i: "ي" }[c] ?? "و");
      i += 1;
    }
    else if (c === "y") { append("ي"); i += 1; }
    else if (c === "c") { append("eiy".includes(at(i + 1)) ? "س" : "ك"); i += 1; }
    else if (c === "g") { append("eiy".includes(at(i + 1)) ? "ج" : "غ"); i += 1; }
    else if (c === "x") { append(start ? "إكس" : "كس"); i += 1; }
    else { append(RULES.CONS[c] ?? c); i += 1; }
  }
  return out.join("");
}

function translitWord(raw) {
  let w = [...raw.toLowerCase()].filter((ch) => ALNUM.test(ch) || ch === ".").join("").replace(/\.+$/, "");
  if (!w) return "";
  if ([...w].every((ch) => DIGIT.test(ch) || ch === ".")) return w;
  if (w in RULES.WORD_MAP) return RULES.WORD_MAP[w];
  if ([...w].length === 1) return RULES.LETTER_NAMES[w] ?? w;
  const letters = w.match(/^[^0-9]*/)[0];
  let rest = w.slice(letters.length);
  const base = letters ? translitLetters(letters) : "";
  rest = [...rest].filter((ch) => DIGIT.test(ch) || ch === ".").join("");
  return rest ? (base + " " + rest).trim() : base;
}

const tokensOf = (name) => name.trim().split(/[\s\-_/]+/).filter(Boolean);
const isAlpha = (s) => s.length > 0 && [...s].every((ch) => /\p{L}/u.test(ch));

function translitTokens(tokens) {
  const out = tokens.map(translitWord);
  for (let i = 0; i < tokens.length - 1; i++) {
    const nxt = tokens[i + 1];
    if (RULES.ARTICLES.includes(tokens[i].toLowerCase()) && isAlpha(nxt) && nxt.length > 2 && out[i + 1]) {
      out[i + 1] = "ال" + out[i + 1];
      out[i] = "";
    }
  }
  return out;
}

export const toArabic = (name) => translitTokens(tokensOf(name)).filter(Boolean).join(" ");

export function smartTitle(s) {
  const part = (p) => (p.length <= 2 || /[0-9]/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return s.split(" ").map((w) => w.split("-").map(part).join("-")).join(" ");
}

// ---------------------------------------------------------------- sound keys

const isArabic = (w) => [...w].some((ch) => ch >= "؀" && ch <= "ۿ");

function soundWord(w) {
  let out = "";
  const add = (code) => { for (const ch of code) if (!out || out[out.length - 1] !== ch) out += ch; };
  if (isArabic(w)) {
    for (const ch of w) if (ch in RULES.AR_SOUND) add(RULES.AR_SOUND[ch]);
    return out;
  }
  let i = 0;
  const n = w.length;
  while (i < n) {
    const c = w[i];
    const nx = i + 1 < n ? w[i + 1] : "";
    if (w.startsWith("sch", i)) { add("X"); i += 3; continue; }
    if (w.startsWith("tion", i)) { add("XN"); i += 4; continue; }
    const two = w.slice(i, i + 2);
    if (two === "sh") { add("X"); i += 2; continue; }
    if (two === "ph") { add("F"); i += 2; continue; }
    if (two === "th") { add("T"); i += 2; continue; }
    if (two === "kh" || two === "ck" || two === "ch" || two === "qu") { add("K"); i += 2; continue; }
    if (c === "x") { add(i === 0 ? "Z" : "KZ"); i += 1; continue; }
    if (c === "c") { add(nx && "eiy".includes(nx) ? "Z" : "K"); i += 1; continue; }
    if (c in RULES.EN_SOUND) add(RULES.EN_SOUND[c]);
    i += 1;
  }
  return out;
}

const sounds = (text) => normalize(text).split(" ").filter((w) => w !== "").map(soundWord);

function soundTokens(text) {
  const ws = sounds(text).filter(Boolean);
  const toks = [];
  if (ws.length) toks.push(ws.join(""));
  toks.push(...ws);
  for (let i = 0; i < ws.length - 1; i++) toks.push(ws[i] + ws[i + 1]);
  return [...new Set(toks)];
}

export function soundKey(...parts) {
  const toks = [];
  for (const p of parts) for (const t of soundTokens(p ?? "")) if (!toks.includes(t)) toks.push(t);
  return " " + toks.join(" ") + " ";
}

/** A spelling-free skeleton of one name, for "did you mean" (same as the phone's search by sound). */
export const soundOf = (text) => sounds(text).join("");

// ---------------------------------------------------------------- companies, forms, families

export function makerInfo(maker) {
  for (const [needle, short, en] of RULES.MAKERS) if (maker.includes(needle)) return [short, en];
  return ["", []];
}

function fixCompanyWords(tokens, arWords, shortAr, enNames) {
  if (!shortAr) return arWords;
  const targets = new Set([sounds(shortAr).join(""), ...enNames.map((e) => sounds(e).join(""))].filter((t) => t.length >= 2));
  const out = [...arWords];
  let i = 0;
  while (i < tokens.length) {
    let done = false;
    for (const span of [3, 2, 1]) {
      const seg = tokens.slice(i, i + span);
      if (seg.length < span || !seg.every((t) => isAlpha(t.replaceAll("&", "")))) continue;
      const snd = sounds(seg.join(" ")).join("");
      if (targets.has(snd) && (i > 0 || span === tokens.length)) {
        let name = shortAr;
        if (name.endsWith(" فارما") && !seg.map((t) => t.toLowerCase()).includes("pharma") && seg.join("").length > 3) {
          name = name.slice(0, -" فارما".length);
        }
        out[i] = name;
        for (let k = i + 1; k < i + span; k++) out[k] = "";
        i += span;
        done = true;
        break;
      }
    }
    if (!done) i += 1;
  }
  return out;
}

/** The Arabic name the list builder would give this brand (the admin may type a better one). */
export function arabicName(brand, maker) {
  const toks = tokensOf(smartTitle(brand));
  const ar = translitTokens(toks);
  toks.forEach((t, i) => { if (ar[i] && t.toLowerCase() in RULES.FIX_WORDS) ar[i] = RULES.FIX_WORDS[t.toLowerCase()]; });
  const [short, en] = makerInfo(maker);
  return fixCompanyWords(toks, ar, short, en).filter(Boolean).join(" ");
}

const UNIT_NAMES = { MG: "mg", MCG: "mcg", "µG": "mcg", G: "g", GM: "g", ML: "ml", IU: "IU", "I U": "IU", "%": "%", MMOL: "mmol", MEQ: "mEq", U: "IU" };
const unitName = (u) => { u = u.toUpperCase().replaceAll(".", ""); return UNIT_NAMES[u] ?? u.toLowerCase(); };

/** "500MG", "500 mg", "250mg/5ml" → the list's way of writing a strength ("500 mg", "250 mg/5 ml"); "" if none. */
export function cleanStrength(s) {
  if (!s || s.includes("غير")) return "";
  s = s.replaceAll("\\\\", "\\").trim().replace(/(\d)[, ](\d{3})(?!\d)/g, "$1$2");
  const cut = s.indexOf("/");
  const main = cut < 0 ? s : s.slice(0, cut), per = cut < 0 ? "" : s.slice(cut + 1);
  const unit = /(\d+(?:[.,]\d+)?)\s*(MG|MCG|µG|GM|G|ML|IU|I\.U\.?|%|MMOL|MEQ|U)(?![A-Z])\.?/gi;
  const parts = [...main.matchAll(unit)].map((m) => `${m[1].replace(",", ".")} ${unitName(m[2])}`);
  if (!parts.length) return "";
  let txt = parts.join(" + ");
  const pm = per.match(/^\s*(\d+(?:\.\d+)?)?\s*(ML|G|GM)\b/i);
  if (pm) txt += `/${pm[1] && pm[1] !== "1" ? pm[1] + " " : ""}${unitName(pm[2])}`;
  return txt;
}

export function formCode(formAr) {
  for (const [code, words] of RULES.FORM_RULES) if (words.some((w) => formAr.includes(w))) return code;
  return "OTHER";
}

const FAMILY_RX = RULES.FAMILIES.map(([ar, en, rx]) => [ar, en, new RegExp(rx)]);

export function family(composition) {
  const comp = composition.toUpperCase();
  const first = comp.split(/[+,]/)[0].trim();
  for (const target of [first, comp]) for (const [ar, en, rx] of FAMILY_RX) if (rx.test(target)) return [ar, en];
  return ["", ""];
}

/**
 * A complete list row from what the admin typed, with every derived column the phone searches by. Same columns as
 * the drugs table in the list (plus barcodes).
 */
export function drugRow(f) {
  const brand = f.brand.trim().replace(/\s+/g, " ").toUpperCase();
  const trade = (f.trade || brand).trim().replace(/\s+/g, " ");
  const maker = f.maker.trim().replace(/\s+/g, " ");
  const [short] = makerInfo(maker);
  const makerShort = (f.maker_short || "").trim() || short || maker;
  const comp = f.composition.trim().toUpperCase().replace(/\s*\+\s*/g, "+").replace(/\s+/g, " ");
  const arName = (f.trade_ar || "").trim().replace(/\s+/g, " ") || arabicName(brand, maker);
  const [catAr, catEn] = f.category_ar ? [f.category_ar, f.category_en || ""] : family(comp);
  return {
    trade, trade_ar: arName, brand, brand_key: squash(brand), maker, composition: comp, strength: f.strength.trim(),
    pack_count: Number(f.pack_count) || 0, pack_unit: (f.pack_unit || "").trim(), form_ar: f.form_ar.trim(),
    form_code: formCode(f.form_ar.trim()), category_ar: catAr, category_en: catEn,
    search: searchKey(brand, trade, arName, comp, maker, makerShort), ar_key: normalize(arName),
    sound: soundKey(brand, arName, comp.replaceAll("+", " ")), maker_short: makerShort,
    price: f.price === "" || f.price == null ? null : Number(f.price), source: f.source || "DW",
    // the cost is the pharmacy's own (the owner's decision of 2026-10-09): never from the list
    cost: null,
    barcodes: (f.barcodes || []).map((b) => String(b).trim()).filter(Boolean),
  };
}
