// Which medicine a box photo shows: a line-by-line port of the app's BoxMatcher.kt (same clues, weights and
// thresholds), so the panel recognises a box exactly as a pharmacy's phone does. It compares what was read with the
// list and weighs every clue against each candidate (name, strength, active ingredient, form, company, pack size); a
// clue that contradicts a candidate counts against it, and when the best answer isn't clearly ahead it says so.
import { soundOf } from "./names.js";

const isLetter = (c) => c >= "A" && c <= "Z";
const isDigit = (c) => c >= "0" && c <= "9";

const FORM_NOISE = new Set(["TAB", "TABS", "TABLET", "TABLETS", "CAP", "CAPS", "CAPSULE", "CAPSULES", "SYRUP", "SUSP", "SUSPENSION", "CREAM",
  "GEL", "DROPS", "AMP", "AMPS", "VIAL", "INJ", "SUPP", "OINT", "SPRAY", "SACHET", "SACHETS", "CTD", "FC", "MG", "ML", "FILM", "COATED", "ORAL", "EYE", "SYR", "OVU", "CHEW"]);
const STOP_WORDS = new Set(["EACH", "CONTAINS", "STORE", "BELOW", "KEEP", "REACH", "CHILDREN", "PHARMACEUTICAL", "PHARMACEUTICALS", "INDUSTRIES",
  "INDUSTRY", "COMPANY", "MADE", "SYRIA", "SYRIAN", "ARAB", "REPUBLIC", "ORAL", "ONLY", "PRESCRIPTION", "DOSAGE", "LEAFLET",
  "MANUFACTURED", "UNDER", "LICENSE", "LABS", "LABORATORIES", "PHARMA", "WITH", "FILM", "COATED", "TABLETS", "CAPSULES",
  "ADULTS", "ADULT", "INFANTS", "MEDICINE", "PROTECT", "LIGHT", "MOISTURE", "TEMPERATURE", "INFORMATION", "PATIENT",
  "READ", "CAREFULLY", "BEFORE", "USING", "SHAKE", "WELL", "USE", "FOR", "THE", "AND"]);
const SALTS = new Set(["SODIUM", "POTASSIUM", "HCL", "HYDROCHLORIDE", "HYDROBROMIDE", "MALEATE", "SULPHATE", "SULFATE", "PHOSPHATE",
  "ACETATE", "CITRATE", "MESYLATE", "MESILATE", "BESYLATE", "BESILATE", "FUMARATE", "SUCCINATE", "TARTRATE", "TRIHYDRATE",
  "MONOHYDRATE", "DIHYDRATE", "ANHYDROUS", "ACID", "HYDRATE", "BROMIDE", "CHLORIDE", "NITRATE", "OXIDE", "MAGNESIUM",
  "CALCIUM", "DIPROPIONATE", "PROPIONATE", "VALERATE", "BUTYRATE", "DISODIUM", "HYCLATE", "LACTATE", "GLUCONATE",
  "BENZOATE", "PAMOATE", "DECANOATE", "STEARATE", "BITARTRATE", "HEMIHYDRATE", "SESQUIHYDRATE", "TROMETAMOL"]);
const COMMON_WORDS = new Set([...SALTS, "VITAMIN", "VITAMINS", "EXTRACT", "WATER", "ALCOHOL", "GLUCOSE", "DEXTROSE", "SOLUTION", "LACTOSE", "MEDICAL",
  "NATIONAL", "UNITED", "FUTURE", "GOLDEN", "HORIZON", "ULTRA", "MEDICA", "PHARMA", "HUMAN", "HEALTH"]);

export function splitWords(s) {
  return s.toUpperCase().split(/[^A-Z0-9.&]+/).map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean)
    .flatMap((w) => (w.includes(".") && /[A-Z]/.test(w) ? w.split(".").filter(Boolean) : [w]));
}
const ingredientKeyWords = (ing) => [...new Set(splitWords(ing.toUpperCase()).filter((w) => w.length >= 4 && [...w].every(isLetter) && !SALTS.has(w)))];

// ------------------------------------------------------------------ amounts

const amountRx = /(\d+(?:[.,]\d+)?)\s*(?:\/\s*(\d+(?:[.,]\d+)?)\s*)?(MCG|µG|UG|MG|GM|G|ML|IU|I\.U\.?|%|UNITS?|MMOL|MEQ)(?![A-Z])/g;
function normUnit(u) {
  switch (u.toUpperCase().replaceAll(".", "")) {
    case "MCG": case "µG": case "UG": return "mcg";
    case "MG": return "mg";
    case "G": case "GM": return "g";
    case "ML": return "ml";
    case "IU": case "UNIT": case "UNITS": return "iu";
    case "%": return "%";
    case "MMOL": return "mmol";
    case "MEQ": return "meq";
    default: return u.toLowerCase();
  }
}
const toBase = (v, unit) => (unit === "g" ? { value: v * 1000, unit: "mg" } : unit === "mcg" ? { value: v / 1000, unit: "mg" } : { value: v, unit });
const sameAmount = (a, b) => a.unit === b.unit && Math.abs(a.value - b.value) <= 0.011 * Math.max(a.value, b.value);
function amountsOf(m) {
  const unit = normUnit(m[3]);
  const a = Number(m[1].replace(",", "."));
  if (!Number.isFinite(a)) return [];
  const b = m[2] != null ? Number(m[2].replace(",", ".")) : null;
  return [toBase(a, unit), ...(b != null && Number.isFinite(b) ? [toBase(b, unit)] : [])];
}

function cleanLine(s) {
  return s.replaceAll("µ", "MC").replaceAll("μ", "MC").toUpperCase()
    .replaceAll("®", " ").replaceAll("™", " ").replaceAll("©", " ")
    .replace(/(\d)\s*(?:RNG|GNG|RN9|MQ|M9|MGG)\b/g, "$1MG")
    .replace(/\b(\d{1,3})(?:([.,\s])(\d{3}))\2(\d{3})\b/g, (_, a, __, b, c) => a + b + c)
    .replace(/\b(\d{1,3})[,\s](\d{3})(?!\d)/g, "$1$2")
    .replace(/\b(\d{1,3})\.(\d{3})(?=\s*(?:IU|I\.U|UNITS?)\b)/g, "$1$2");
}

function parseCandidateStrength(s) {
  if (!s || !s.trim()) return [];
  const main = cleanLine(s).split("/")[0];
  return [...main.replaceAll(" + ", " ").matchAll(amountRx)].flatMap(amountsOf);
}

/** One medicine that could be on the box. */
export function candidate({ id, brand, ingredient = "", strength = "", formCode = "", packCount = 0, makerKey = "", makerLatin = [] }) {
  const words = splitWords(brand);
  const brandWords = words.map((w) => [...w].filter(isLetter).join("")).filter((w) => w.length >= 2 && !FORM_NOISE.has(w));
  const amounts = parseCandidateStrength(strength);
  const brandJoined = brandWords.join("");
  return {
    id, brand, ingredient, strength, formCode, packCount, makerKey, makerLatin,
    brandWords,
    brandNumbers: words.filter((w) => [...w].every((c) => isDigit(c) || c === ".")).map(Number).filter(Number.isFinite),
    brandJoined,
    ingredientKeys: ingredientKeyWords(ingredient),
    amounts,
    identity: `${brandJoined}|${amounts.map((a) => `${a.value}${a.unit}`).join(", ")}|${formCode}`,
  };
}

// ------------------------------------------------------------------ OCR-aware similarity

const CONFUSABLE = ["O0QD", "I1LJ|", "S5", "B8", "G6C", "Z2", "UV", "EF", "MN", "KX", "RP"];
function cost(a, b) {
  if (a === b) return 0;
  for (const g of CONFUSABLE) if (g.includes(a) && g.includes(b)) return 0.35;
  return 1;
}
/** 1 = identical; letters a camera often confuses (O/0, I/L/1, S/5…) cost less. */
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

// ------------------------------------------------------------------ reading the box

const excludedLine = /\b(EXP|EXPIRY|MFG|MFD|MANUF\w*|PROD\.?\s*DATE|BATCH|LOT|B\.\s?N|BN|REG\.?|REGISTRATION|PRICE|S\.\s?P|P\.\s?P|SYP|DATE|L\.\s?S)\b/;
const packRx = /(\d{1,3})\s*(?:X\s*)?(?:[A-Z.\-]+\s+){0,2}?(TABLETS?|TABS?|CAPLETS?|CAPSULES?|CAPS?|SACHETS?|AMPOULES?|AMPS?|VIALS?|SUPPOSITORIES|SUPP|OVULES?|LOZENGES?)\b/g;
const oddCase = /\b[a-z]+[A-Z]/;
const blisterRx = /\b(\d{1,2})\s*[X×]\s*(\d{1,2})\b/g;
const volumeRx = /\b(\d{2,3})\s*ML\b/g;

function splitLettersDigits(w) {
  const m = w.match(/^([A-Z]{2,})(\d{2,}(?:\.\d+)?)$/);
  return m ? [m[1], m[2]] : [w];
}
/** "V0LTA" → "VOLTA": digits a camera reads inside a word are almost always letters. */
function letterize(w) {
  const letters = [...w].filter(isLetter).length, digits = [...w].filter(isDigit).length;
  if (letters < 3 || digits === 0 || digits > 2) return w;
  return [...w].map((c) => ({ 0: "O", 1: "I", 5: "S", 8: "B" }[c] ?? c)).join("");
}

const FORM_WORDS = [
  ["TAB", ["TABLET", "TABLETS", "TAB", "TABS", "CAPLET", "CAPLETS"]], ["CAP", ["CAPSULE", "CAPSULES", "CAPS", "CAP"]],
  ["SYRUP", ["SYRUP"]], ["SUSP", ["SUSPENSION", "SUSP"]], ["DROPS", ["DROPS"]], ["CREAM", ["CREAM"]], ["OINT", ["OINTMENT", "OINT"]],
  ["GEL", ["GEL", "EMULGEL"]], ["SUPP", ["SUPPOSITORY", "SUPPOSITORIES", "SUPP", "OVULES", "OVULE"]],
  ["INJ", ["AMPOULE", "AMPOULES", "AMP", "AMPS", "INJECTION", "INJECTABLE", "VIAL", "VIALS", "INJ"]],
  ["SACHET", ["SACHET", "SACHETS", "GRANULES"]], ["SPRAY", ["SPRAY"]], ["INHALER", ["INHALER", "INHALATION"]], ["LOTION", ["LOTION", "SHAMPOO"]],
];
function formsIn(tokens) {
  const out = new Set();
  const words = tokens.map((t) => t.text);
  for (const [code, list] of FORM_WORDS) {
    if (words.some((w) => list.some((f) => w === f || (f.length >= 6 && Math.abs(w.length - f.length) <= 1 && similarity(f, w) >= 0.84)))) out.add(code);
  }
  if (out.has("DROPS") && words.some((w) => w === "EYE" || w === "OPHTHALMIC")) out.add("EYE_DROPS");
  return out;
}

/** Everything useful read from the box, independent of any candidate. lines: [{ text, confidence 0..1, height }] */
export function read(lines) {
  const usable = lines.filter((l) => l.confidence >= 0.35 && /[\p{L}\p{N}]/u.test(l.text));
  const maxH = Math.max(1, ...usable.filter((l) => [...l.text].filter((c) => /\p{L}/u.test(c)).length >= 2).map((l) => l.height));
  const tokens = [], variants = [], amounts = [], bare = new Set(), big = [];
  let textForPacks = "";
  usable.forEach((line, li) => {
    const upper = cleanLine(line.text);
    const weight = Math.min(1, Math.max(0.05, line.height / maxH));
    const excluded = excludedLine.test(upper);
    if (!excluded) {
      for (const m of upper.matchAll(amountRx)) amounts.push(...amountsOf(m));
      textForPacks += upper + "\n";
    }
    const words = splitWords(upper).flatMap(splitLettersDigits).map(letterize);
    if (!excluded) {
      words.filter((w) => [...w].every((c) => isDigit(c) || c === ".") && w.length >= 1 && w.length <= 5).map(Number)
        .filter((v) => Number.isFinite(v) && !(v >= 1990 && v <= 2045)).forEach((v) => bare.add(v));
    }
    const alpha = words.filter((w) => [...w].filter(isLetter).length >= 2 && [...w].filter(isDigit).length <= 1)
      .map((w) => [...w].filter(isLetter).join(""));
    if (excluded) return;
    alpha.forEach((t) => tokens.push({ text: t, line: li, weight }));
    for (let i = 0; i < alpha.length; i++) {
      variants.push({ text: alpha[i], line: li, weight });
      if (i + 1 < alpha.length) variants.push({ text: alpha[i] + alpha[i + 1], line: li, weight });
      if (i + 2 < alpha.length) variants.push({ text: alpha[i] + alpha[i + 1] + alpha[i + 2], line: li, weight });
    }
    const trusted = line.confidence >= 0.55 && !oddCase.test(line.text);
    if (weight >= 0.8 && trusted) alpha.filter((w) => w.length >= 4 && /[AEIOUY]/.test(w) && !STOP_WORDS.has(w) && !FORM_NOISE.has(w)).forEach((w) => big.push(w));
  });
  const windows = new Set();
  const byLine = new Map();
  for (const t of tokens) { if (!byLine.has(t.line)) byLine.set(t.line, []); byLine.get(t.line).push(t); }
  for (const ws of byLine.values()) for (let i = 0; i < ws.length; i++) for (let n = 1; n <= 3; n++) if (i + n <= ws.length) windows.add(soundOf(ws.slice(i, i + n).map((w) => w.text).join(" ")));
  const packs = new Set();
  for (const m of textForPacks.matchAll(packRx)) { const v = Number(m[1]); if (v >= 1 && v <= 500) packs.add(v); }
  for (const m of textForPacks.matchAll(blisterRx)) { const a = Number(m[1]), b = Number(m[2]); if (a >= 1 && a <= 10 && b >= 2 && b <= 30) packs.add(a * b); }
  for (const m of textForPacks.matchAll(volumeRx)) { const v = Number(m[1]); if (v >= 15) packs.add(v); }
  return { tokens, variants, amounts, bareNumbers: bare, forms: formsIn(tokens), packs, bigWords: [...new Set(big)], soundWindows: new Set([...windows].filter((w) => w.length >= 3)), isEmpty: tokens.length === 0 };
}

// ------------------------------------------------------------------ matching

function threshold(len) {
  if (len <= 2) return 1;
  if (len === 3) return 0.85;
  if (len <= 5) return 0.74;
  if (len <= 8) return 0.72;
  return 0.7;
}

function best(target, words) {
  let bestWord = null, bestSim = 0;
  const slack = Math.max(2, Math.floor(target.length / 3));
  for (const w of words) {
    if (Math.abs(w.text.length - target.length) > slack) continue;
    const sim = similarity(target, w.text);
    if (sim > bestSim || (sim === bestSim && bestWord && w.weight > bestWord.weight)) { bestSim = sim; bestWord = w; }
  }
  return bestWord ? [bestWord, bestSim] : null;
}

function phraseFound(words, r, minSim) {
  if (!words.length) return false;
  const joined = words.join("");
  if (joined.length >= 4) {
    const b = best(joined, r.variants);
    if (b && b[1] >= Math.max(minSim, threshold(joined.length))) return true;
  }
  return words.length > 1 && words.every((w) => (w.length <= 2 ? r.tokens.some((t) => t.text === w) : (best(w, r.tokens)?.[1] ?? 0) >= Math.max(minSim, threshold(w.length))));
}

const SOLID = new Set(["TAB", "CAP"]);
const COMPATIBLE = [new Set(["SYRUP", "SUSP", "DROPS"]), new Set(["CREAM", "OINT", "GEL", "LOTION"]), new Set(["DROPS", "EYE_DROPS"])];
const compatible = (a, b) => COMPATIBLE.some((g) => g.has(a) && g.has(b));

function explains(c, w) {
  return [c.brandJoined, ...c.brandWords, ...c.ingredientKeys].some((x) => similarity(x, w) >= 0.75 || (x.length >= 5 && w.startsWith(x))) ||
    c.makerLatin.some((n) => splitWords(n.toUpperCase()).some((x) => similarity(x, w) >= 0.8)) ||
    (c.makerKey && ((s) => s.length >= 3 && s === soundOf(w))(soundOf(c.makerKey))) ||
    STOP_WORDS.has(w);
}

function score(c, r, cache, presentIngredients, presentMakers) {
  const found = new Set(), conflicts = new Set();
  let s = 0;
  let name = 0, prominence = 0;
  if (c.brandJoined.length >= 2) {
    const full = cache.best(c.brandJoined);
    if (full && full[1] >= threshold(c.brandJoined.length)) { name = full[1]; prominence = full[0].weight; }
    else if (c.brandWords.length > 1) {
      let total = 0, got = 0, prom = 0;
      for (const w of c.brandWords) {
        const weight = c.ingredientKeys.includes(w) || w.length <= 2 ? 0.5 * Math.max(w.length, 2) : w.length;
        total += weight;
        const b = cache.best(w);
        if (b && b[1] >= threshold(w.length)) { got += weight * b[1]; prom = Math.max(prom, b[0].weight); }
      }
      name = total > 0 ? got / total : 0;
      prominence = prom;
    }
  }
  if (name >= 0.8) found.add("NAME");
  s += 0.5 * name * (0.75 + 0.25 * prominence) + 0.04 * name * prominence;

  if (c.amounts.length) {
    const left = [...r.amounts];
    const hits = c.amounts.filter((a) => { const i = left.findIndex((x) => sameAmount(x, a)); if (i >= 0) { left.splice(i, 1); return true; } return false; }).length;
    const sameKind = r.amounts.some((b) => c.amounts.some((a) => a.unit === b.unit));
    if (hits === c.amounts.length) { s += 0.2; found.add("STRENGTH"); }
    else if (hits > 0) s += 0.1;
    else if (sameKind) { s -= 0.25; conflicts.add("STRENGTH"); }
    else if (c.amounts.every((a) => r.bareNumbers.has(a.value) || r.bareNumbers.has(a.value / 1000))) { s += 0.12; found.add("STRENGTH"); }
  }
  if (c.brandNumbers.length && (r.bareNumbers.size || r.amounts.length)) {
    const seen = c.brandNumbers.filter((n) => r.bareNumbers.has(n) || r.amounts.some((a) => Math.abs(a.value - n) < 1e-6 || Math.abs(a.value - n * 1000) < 1e-6)).length;
    if (seen === c.brandNumbers.length) s += 0.05;
    else if (seen === 0 && !found.has("STRENGTH")) { s -= 0.1; conflicts.add("STRENGTH"); }
  }

  if (c.ingredientKeys.length) {
    const hit = c.ingredientKeys.filter((k) => { const b = cache.best(k); return b && b[1] >= (k.length >= 6 ? 0.8 : 0.86); }).length;
    if (hit > 0) { s += (0.1 * hit) / c.ingredientKeys.length; if (hit === c.ingredientKeys.length) found.add("INGREDIENT"); }
    const foreign = [...presentIngredients].filter((ing) =>
      !c.ingredientKeys.some((k) => k.startsWith(ing.slice(0, 6)) || ing.startsWith(k.slice(0, 6))) && !c.brandWords.some((w) => similarity(w, ing) >= 0.75)).length;
    if (foreign > 0) { s -= 0.12 * Math.min(foreign, 2); conflicts.add("INGREDIENT"); }
  }

  if (r.forms.size && c.formCode && c.formCode !== "OTHER") {
    if (r.forms.has(c.formCode)) { s += 0.05; found.add("FORM"); }
    else if ([...r.forms].some((f) => compatible(f, c.formCode))) s += 0.025;
    else { s -= [...r.forms].every((f) => SOLID.has(f)) && SOLID.has(c.formCode) ? 0.03 : 0.06; conflicts.add("FORM"); }
  }

  const makerSeen = c.makerLatin.some((n) => {
    if (!cache.phrase.has(n)) cache.phrase.set(n, phraseFound(splitWords(n.toUpperCase()).map((w) => [...w].filter(isLetter).join("")).filter(Boolean), r, 0.8));
    return cache.phrase.get(n);
  }) || (c.makerKey && (() => {
    if (!cache.sound.has(c.makerKey)) { const k = soundOf(c.makerKey); cache.sound.set(c.makerKey, k.length >= 3 && r.soundWindows.has(k)); }
    return cache.sound.get(c.makerKey);
  })());
  if (makerSeen) { s += 0.07; found.add("MAKER"); }
  else if (presentMakers.size && c.makerKey && !presentMakers.has(c.makerKey)) { s -= 0.07; conflicts.add("MAKER"); }

  if (c.packCount > 0 && r.packs.has(c.packCount)) { s += 0.03; found.add("PACK"); }

  const unexplained = r.bigWords.filter((w) => !explains(c, w)).length;
  if (unexplained > 0) s -= 0.06 * Math.min(unexplained, 2);
  return { candidate: c, score: s, nameScore: name, found, conflicts };
}

/** Quick shortlist from the whole list: names that start like a word on the box (or like it after a misread first letter), or ingredients seen on it. */
export class Index {
  constructor(all, makers) {
    this.byStart = new Map(); this.byInner = new Map(); this.byIngredient = new Map();
    const add = (m, k, c) => { if (!m.has(k)) m.set(k, []); m.get(k).push(c); };
    for (const c of all) {
      for (const k of [...new Set([...c.brandWords, c.brandJoined].filter((x) => x.length >= 3))]) {
        add(this.byStart, k.slice(0, 3), c);
        if (k.length >= 4) add(this.byInner, k.slice(1, 4), c);
      }
      for (const k of c.ingredientKeys) add(this.byIngredient, k, c);
    }
    const ingredients = new Set([...this.byIngredient.keys()].filter((w) => w.length >= 6 && !COMMON_WORDS.has(w)));
    const distinctiveMakers = makers.map(([key, names]) => [key, names.map((n) => splitWords(n.toUpperCase()).filter((w) => /[A-Z]/.test(w)))
      .filter((ws) => ws.join("").length >= 6 && !(ws.length === 1 && COMMON_WORDS.has(ws[0])))]).filter(([, ns]) => ns.length);
    this.vocabulary = { ingredients, distinctiveMakers };
  }

  shortlist(r) {
    const out = new Set();
    for (const w of r.tokens) {
      if (w.text.length < 3) continue;
      (this.byStart.get(w.text.slice(0, 3)) ?? []).forEach((c) => out.add(c));
      if (w.text.length >= 4) (this.byInner.get(w.text.slice(1, 4)) ?? []).forEach((c) => out.add(c));
    }
    for (const [k, list] of this.byIngredient) {
      if (k.length >= 5 && r.variants.some((v) => Math.abs(v.text.length - k.length) <= 2 && similarity(k, v.text) >= 0.84)) list.forEach((c) => out.add(c));
    }
    return [...out];
  }
}

/**
 * True when the photo shows more than one medicine of the same name (a company's group photo: "UROMAX 10" next to
 * "UROMAX 5"): the best match may then be the wrong one of them, so nothing is decided without the admin.
 */
export function several(lines, best) {
  const family = best?.candidate.brandWords[0];
  if (!family || family.length < 3) return false;
  const numbers = new Set();
  const rx = new RegExp(`${family}[\\s\\-]*(\\d+(?:[.,]\\d+)?)`, "g");
  for (const l of lines) for (const m of cleanLine(l.text).replace(/[^A-Z0-9.,\s-]/g, " ").matchAll(rx)) numbers.add(Number(m[1].replace(",", ".")));
  return numbers.size >= 2;
}

/** The medicines the box could show, best first, and whether the first one is certain. */
export function match(r, candidates, vocabulary, limit = 8) {
  if (r.isEmpty || !candidates.length) return { matches: [], confident: false };
  const presentIngredients = new Set();
  for (const v of r.variants) {
    if (v.text.length < 6) continue;
    let bestIng = null, bestSim = 0;
    for (const ing of vocabulary.ingredients) {
      if (Math.abs(v.text.length - ing.length) > 2) continue;
      const sim = similarity(ing, v.text);
      if (sim > bestSim) { bestSim = sim; bestIng = ing; }
    }
    if (bestIng && bestSim >= 0.86) presentIngredients.add(bestIng);
  }
  const presentMakers = new Set(vocabulary.distinctiveMakers.filter(([, names]) => names.some((ws) => phraseFound(ws, r, 0.86))).map(([k]) => k));
  const memo = new Map();
  const cache = { best: (t) => { if (!memo.has(t)) memo.set(t, best(t, r.variants)); return memo.get(t); }, phrase: new Map(), sound: new Map() };
  const scored = candidates.map((c) => score(c, r, cache, presentIngredients, presentMakers)).filter((m) => m.score > 0.05).sort((a, b) => b.score - a.score);
  // the same medicine in several pack sizes counts once; keep the pack the box shows
  const groups = new Map();
  for (const m of scored) {
    const g = groups.get(m.candidate.identity);
    if (!g || m.score > g.score || (m.score === g.score && r.packs.has(m.candidate.packCount) && !r.packs.has(g.candidate.packCount))) groups.set(m.candidate.identity, m);
  }
  const grouped = [...groups.values()].sort((a, b) => b.score - a.score);
  const top = grouped[0];
  if (!top) return { matches: [], confident: false };
  const second = grouped[1]?.score ?? 0;
  const unexplained = r.bigWords.some((w) => !explains(top.candidate, w));
  const confident = top.score >= 0.62 && top.nameScore >= 0.8 && !top.conflicts.has("STRENGTH") && top.score - second >= 0.1 && !unexplained;
  // another product under the same identity, told apart only by words the box doesn't show ("ORAL VIAL" and "-TAB",
  // "FINLEPSIN-UNI" and "FINLEPSIN-UNI 200 C.R-TAB") or by small signs (a number in the name, the pack's count):
  // which one it is can't be told for sure (the panel asks; the app's matcher has no such case to warn of)
  const alike = scored.some((m) => m !== top && m.candidate.identity === top.candidate.identity && m.candidate.brand !== top.candidate.brand && m.score >= top.score - 0.06);
  const family = top.candidate.brandWords[0];
  const kept = [...grouped.slice(0, limit), ...grouped.slice(limit).filter((m) => family && m.candidate.brandWords[0] === family).slice(0, 4)];
  return { matches: kept, confident, alike, read: r, seenIngredients: [...presentIngredients], seenMakers: [...presentMakers] };
}
