/* Reader view: an open book where each sentence is one row, with the
   Catalan text on the left and the translation on the right (or below). */

import { $, $$, esc, toast, ICON, dialog, downloadJSON, slug, copyText } from "./ui.js";
import { prefs, kv } from "./store.js";
import { tokens, lineCount, normalize } from "./text.js";
import { LANGUAGES, lang as langInfo, isRtl, fontFor, tallScript } from "./languages.js";
import { sectionBlocks, TrMemory, allTexts, translationPack, bookPack, importPack } from "./books.js";
import { translateTexts, translateWord, explainSentence, resolveProvider, providerLabel, settings as trSettings } from "./translate.js";
import * as speech from "./speech.js";

const PAGE_LINES = 16;

/* ---------- preferences (per device) ---------- */
export const P = Object.assign(
  { lang: "en", lang2: "none", show: "both", fs: 21, lh: 1.6, view: "pages", pos: "side", hide: false, slow: false, focus: false, theme: "auto", voiceTr: false },
  prefs.get("reader", {})
);
export const savePrefs = () => prefs.set("reader", P);

/* ---------- state of the open book ---------- */
const R = { book: null, mems: {}, pivots: {}, sec: 0, page: 0, level: null, teacher: false, saved: [], token: 0, pages: [], dictIdx: null, glossIdx: null };
let onExit = () => {};
export function setExitHandler(fn) { onExit = fn; }

const src = () => R.book.lang || "ca";
const sec = () => R.book.sections[R.sec];

/* Two translation languages: the main one and an optional second one.
   langsAll(): both, for words and vocabulary · langsShown(): the ones the
   sentences show now (main, second or both, the second one below). */
const usable = l => l && l !== "none" && l !== src();
export function langsAll() {
  return [P.lang, P.lang2].filter((l, i, a) => usable(l) && a.indexOf(l) === i);
}
function langsShown() {
  const all = langsAll();
  if (all.length < 2) return all;
  return P.show === "1" ? [all[0]] : P.show === "2" ? [all[1]] : all;
}
const noTr = () => !langsShown().length;
const mem = l => R.mems[l];
const lhFor = l => tallScript(l) ? Math.max(P.lh + 0.5, 2.1) : P.lh;
/** lang, direction and font of a text in language l. */
const trAttrs = l => `lang="${esc(l)}" dir="${isRtl(l) ? "rtl" : "ltr"}" style="--f-tr:${esc(fontFor(l))};--lh-tr:${lhFor(l)}"`;
const trName = l => langInfo(l).native;

/* ---------- word indexes: book dictionary and glossary ---------- */
const NOUN_CUE = new Set(["el", "la", "les", "els", "un", "una", "unes", "uns", "seva", "seves", "meva", "l"]);
function buildIndexes(book) {
  const dict = book.dict || {};
  const forms = {};
  for (const [k, v] of Object.entries(dict)) for (const f of v.f || [k]) (forms[f] = forms[f] || []).push(k);
  const gloss = {};
  for (const g of book.glossary || []) {
    for (const f of new Set([g.term, ...(g.forms || [])])) {
      if (!f || /\s/.test(f)) continue;
      for (const v of [f, f + "s", f + "es", f.replace(/a$/, "es")]) if (!gloss[v]) gloss[v] = g;
    }
  }
  // expressions ("a la deriva"): their longest word points to the entry
  for (const g of book.glossary || []) {
    for (const f of new Set([g.term, ...(g.forms || [])])) {
      if (!f || !/\s/.test(f)) continue;
      const w = f.split(/[\s'’]+/).sort((a, b) => b.length - a.length)[0];
      if (w && w.length >= 4 && !gloss[w]) gloss[w] = g;
    }
  }
  R.dictIdx = forms;
  R.glossIdx = gloss;
}
const isNoun = k => /^nom [mf]\./.test((R.book.dict[k] || {}).p || "");
function lemmasFor(word, prev) {
  const list = (R.dictIdx[word.toLowerCase()] || []).slice();
  if (list.length > 1) list.sort((a, b) => (NOUN_CUE.has(prev) ? isNoun(b) - isNoun(a) : isNoun(a) - isNoun(b)));
  return list;
}
function headword(k) {
  const e = R.book.dict[k], w = e.w || k;
  if (isNoun(k)) return /^[aeiouhàèéíòóú]/i.test(w) ? "l’" + w : (e.p.startsWith("nom f.") ? "la " : "el ") + w;
  return w;
}

/* ---------- open / close ---------- */
export async function openBook(book, { sec = null, lang = null } = {}) {
  R.book = book;
  R.teacher = false;
  buildIndexes(book);
  const pos = await kv.get("pos:" + book.id, {});
  R.level = book.levels ? (pos.level && book.levels.some(l => l.id === pos.level) ? pos.level : book.levels[0].id) : null;
  R.sec = sec != null ? sec : Math.min(pos.sec || 0, book.sections.length - 1);
  R.page = sec != null ? 0 : pos.page || 0;
  R.saved = await kv.get("words:" + book.id, []);
  if (lang) { P.lang = lang; savePrefs(); }
  R.pivots = {};
  await loadMemory();
  fillChrome();
  render();
}

async function loadMemory() {
  const mems = {};
  for (const l of langsAll()) mems[l] = R.mems[l] && R.mems[l].book === R.book ? R.mems[l] : await new TrMemory(R.book, l).load();
  R.mems = mems;
}

/* Chrome's built-in translator does not know Catalan: it can translate
   from an existing English, Spanish or French version of each sentence. */
const PIVOTS = ["en", "es", "fr"];
function pivotFor(target) {
  return async texts => {
    for (const p of PIVOTS) {
      if (p !== target && !R.pivots[p]) R.pivots[p] = R.mems[p] || await new TrMemory(R.book, p).load();
    }
    return texts.map(t => {
      for (const p of PIVOTS) {
        if (p === target) continue;
        const v = R.pivots[p].get(t);
        if (v) return { lang: p, text: v };
      }
      return null;
    });
  };
}
/** Translates texts of this book into language l. */
const tr = (texts, l, opts = {}) => translateTexts(texts, src(), l, Object.assign({ pivot: pivotFor(l), onStatus: m => toast(m) }, opts));

export function closeBook() { stopReading(); closePop(); R.book = null; }

function savePos() { if (R.book) kv.set("pos:" + R.book.id, { sec: R.sec, page: R.page, level: R.level }); }

/* ---------- top bar ---------- */
function fillChrome() {
  const b = R.book;
  $("#rTitle").textContent = b.title;
  $("#rSub").textContent = [b.subtitle, b.author].filter(Boolean).join(" · ");
  $("#chap").innerHTML = b.sections.map((s, i) => `<option value="${i}">${esc(sectionLabel(s))}</option>`).join("");
  const lv = $("#lvlWrap");
  lv.hidden = !b.levels;
  if (b.levels) $("#lvl").innerHTML = b.levels.map(l => `<button type="button" data-v="${esc(l.id)}">${esc(l.label)}</button>`).join("");
  fillLangSelect($("#trLang"), "lang");
  fillLangSelect($("#trLang2"), "lang2");
}

/** Fills a language <select> bound to P.lang (main) or P.lang2 (second). */
export function fillLangSelect(sel, key = "lang") {
  const v = P[key];
  const opts = LANGUAGES.filter(l => l.code !== "ca").map(l => `<option value="${l.code}">${esc(l.native)} · ${esc(l.name)}</option>`);
  const custom = !LANGUAGES.some(l => l.code === v) && v !== "none" ? `<option value="${esc(v)}">${esc(v)}</option>` : "";
  sel.innerHTML = `<option value="none">${key === "lang" ? "Sense traducció" : "Cap"}</option>${custom}${opts.join("")}`;
  sel.value = v;
}

const sectionLabel = s => s.kind === "chapter" ? `${s.n}. ${s.title}` : s.title;

/* ---------- pagination ---------- */
function buildPages() {
  const s = sec();
  const blocks = sectionBlocks(s, R.level);
  const vocab = vocabEntries(s);
  if (P.view === "scroll" || R.printing) return [{ blocks, vocab: vocab.length ? vocab : null }];
  const pages = [];
  let cur = [], used = 3; // the chapter title takes the top of the first page
  const newPage = () => { pages.push({ blocks: cur }); cur = []; used = 0; };
  for (const b of blocks) {
    if (b.type === "p") {
      const cost = b.s.reduce((a, x) => a + lineCount(x), 0) + 1;
      if (used + cost <= PAGE_LINES || (used === 0 && cost <= PAGE_LINES)) { cur.push(b); used += cost; continue; }
      // a long paragraph continues on the next page, sentence by sentence
      let part = { type: "p", s: [] };
      for (const x of b.s) {
        const c = lineCount(x);
        if (used + c + 1 > PAGE_LINES && used > 0) { if (part.s.length) cur.push(part); newPage(); part = { type: "p", s: [], cont: true }; }
        part.s.push(x); used += c;
      }
      if (part.s.length) { cur.push(part); used += 1; }
    } else {
      const cost = b.type === "img" ? 7 : 2;
      if (used + cost > PAGE_LINES && used > 0) newPage();
      cur.push(b); used += cost;
    }
  }
  if (cur.length || !pages.length) newPage();
  if (vocab.length) pages.push({ blocks: [], vocab });
  return pages;
}

/* ---------- rendering ---------- */
function trCell(text) {
  return langsShown().map((l, i) => {
    const t = mem(l).get(text);
    const cls = "trt" + (i ? " sec" : "") + (t == null ? " pending" : mem(l).isReviewed(text) ? "" : " auto");
    return `<div class="${cls}" ${trAttrs(l)} data-lang="${esc(l)}" data-src="${esc(text)}"${R.teacher ? ' contenteditable="true" spellcheck="false"' : ""}>${t == null ? "…" : esc(t)}</div>`;
  }).join("");
}

/** Switch, on the translation page, between the main language, the second one or both. */
function trSwitch() {
  const all = langsAll();
  if (all.length < 2) return "";
  const b = (v, label, extra = "") => `<button type="button" data-show="${v}" aria-pressed="${P.show === v}" ${extra}>${label}</button>`;
  return `<div class="trswitch seg" role="group" aria-label="Llengua de la traducció (tecla T)" title="Tecla T">
    ${b("1", esc(trName(all[0])), `lang="${esc(all[0])}"`)}${b("2", esc(trName(all[1])), `lang="${esc(all[1])}"`)}${b("both", "Les dues")}</div>`;
}

function sentenceHTML(text) {
  let prev = "";
  return tokens(text).map(([part, isWord]) => {
    if (!isWord) return esc(part).replace(/'/g, "’").replace(/\n/g, "<br>");
    const lw = part.toLowerCase();
    const ks = lemmasFor(part, prev);
    const g = R.glossIdx[lw];
    prev = lw;
    let cls = "w";
    if (ks.some(k => R.book.dict[k].k) || g) cls += " k";
    if (R.saved.some(x => (x.k && ks.includes(x.k)) || x.form === lw || (g && x.g === g.id))) cls += " saved";
    return `<span class="${cls}" tabindex="0" role="button"${ks.length ? ` data-k="${ks.join("|")}"` : ""}${g ? ` data-g="${g.id}"` : ""}>${esc(part)}</span>`;
  }).join("");
}

function render() {
  if (!R.book) return;
  stopReading(); closePop();
  const token = ++R.token;
  const s = sec();
  R.pages = buildPages();
  R.page = Math.max(0, Math.min(R.page, R.pages.length - 1));
  const page = R.pages[R.page];
  applyPrefs();

  let h = trSwitch();
  if (R.page === 0) {
    const num = s.kind === "chapter" ? `<div class="num">Capítol ${s.n}</div>` : "";
    h += `<div class="row chead"><div class="cell ca">${num}<h2 lang="${esc(src())}">${esc(s.title)}</h2></div>
      <div class="cell tr">${noTr() ? "" : `${s.kind === "chapter" ? `<div class="num">${s.n}</div>` : ""}<div class="tr-title">${trCell(s.title)}</div>`}</div></div>
      <div class="row rules" aria-hidden="true"><div class="rule"></div><div class="rule r"></div></div>`;
  }
  let i = 0;
  h += `<div class="rows">`;
  for (const b of page.blocks) {
    if (b.type === "img") {
      h += `<div class="row img"><figure class="cell ca fig"><img src="${esc(b.src)}" alt="${esc(b.alt)}" loading="lazy"></figure><div class="cell tr"></div></div>`;
    } else if (b.type === "h") {
      h += `<div class="row sub"><div class="cell ca"><h3 lang="${esc(src())}">${esc(b.t)}</h3></div><div class="cell tr">${trCell(b.t)}</div></div>`;
    } else {
      b.s.forEach((x, j) => {
        h += `<div class="row${j === 0 && !b.cont ? " pstart" : ""}" data-i="${i++}">
          <div class="cell ca"><div class="acts"><button type="button" class="say" aria-label="Escolta la frase">${ICON.speak}</button>${trSettings().claudeKey ? `<button type="button" class="explain" aria-label="Explica-m’ho fàcil" title="Explica-m’ho fàcil">?</button>` : ""}</div><div class="txt" lang="${esc(src())}">${sentenceHTML(x)}</div></div>
          <div class="cell tr">${trCell(x)}</div></div>`;
      });
    }
  }
  h += `</div>`;
  if (page.vocab) h += vocabHTML(page.vocab);
  if (R.page === R.pages.length - 1) h += endNav();
  const n = R.page + 1, tot = R.pages.length;
  h += `<div class="folio"><span>Pàgina ${n} de ${tot}</span><span>${langsShown().map(l => esc(trName(l))).join(" · ")}</span></div>`;

  const spread = $("#spread");
  spread.innerHTML = h;
  R.rowTexts = page.blocks.filter(b => b.type === "p").flatMap(b => b.s);

  $("#prev").disabled = R.page === 0 && R.sec === 0;
  $("#next").disabled = R.page === tot - 1 && R.sec === R.book.sections.length - 1;
  $("#fill").style.width = ((R.sec + (R.page + 1) / tot) / R.book.sections.length * 100) + "%";
  $("#ptext").textContent = `${sectionLabel(s)} · pàgina ${n} de ${tot}`;
  $("#chap").value = R.sec;
  $$("#lvl button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === R.level));
  $("#trLang").value = P.lang;
  $("#trLang2").value = P.lang2;
  $("#hideBtn").setAttribute("aria-pressed", P.hide);
  $("#hideBtn").disabled = noTr();
  $("#wcount").textContent = R.saved.length ? `(${R.saved.length})` : "";
  $("#teacherBadge").hidden = !R.teacher;
  savePos();
  fillTranslations(token);
  if (page.vocab) fillVocab(token, page.vocab);
}

function applyPrefs() {
  const root = document.documentElement;
  root.style.setProperty("--fs", P.fs + "px");
  root.style.setProperty("--lh", P.lh);
  const b = document.body;
  b.classList.toggle("hide-tr", P.hide && !noTr());
  b.classList.toggle("no-tr", noTr());
  b.classList.toggle("tr-below", P.pos === "below");
  b.classList.toggle("focus-mode", P.focus);
  b.classList.toggle("teacher", R.teacher);
  b.classList.toggle("tr-two", langsShown().length > 1);
}

function endNav() {
  const next = R.book.sections[R.sec + 1];
  return `<div class="endnav">
    <button type="button" class="btn" data-go="restart">Torna a començar</button>
    ${next ? `<button type="button" class="btn primary" data-go="nextch">${esc(next.kind === "chapter" ? `Capítol ${next.n}: ${next.title}` : next.title)} ${ICON.next}</button>` : `<span class="muted">Fi del llibre.</span>`}
  </div>
  ${!next && (R.book.credits || []).length ? `<div class="credits muted">${R.book.credits.map(c => `<p>${esc(c)}</p>`).join("")}</div>` : ""}`;
}

/* ---------- translations on the page ---------- */
let trError = null;
const cellsOf = (l, extra = "") => $$(`.trt${extra}[data-lang="${CSS.escape(l)}"]`, $("#spread"));

async function fillTranslations(token) {
  for (const l of langsShown()) {
    const texts = mem(l).missing(cellsOf(l, ".pending").map(c => c.dataset.src));
    for (let i = 0; i < texts.length; i += 20) {
      const part = texts.slice(i, i + 20);
      try {
        await mem(l).setAuto(part, await tr(part, l));
        trError = null;
      } catch (e) {
        if (token !== R.token) return;
        console.warn(e);
        if (trError !== e.message) toast(`${trName(l)}: ${e.message || "no s'ha pogut traduir."}`, 6000);
        trError = e.message;
        cellsOf(l, ".pending").forEach(c => { c.classList.remove("pending"); c.classList.add("fail"); c.innerHTML = `<button type="button" class="linkb" data-retry>Sense traducció · torna-ho a provar</button>`; });
        break;
      }
      if (token !== R.token) return;
      updateCells(part, l);
    }
  }
}

function updateCells(texts, l) {
  const set = new Set(texts.map(normalize));
  cellsOf(l).forEach(c => {
    if (!set.has(normalize(c.dataset.src))) return;
    const t = mem(l).get(c.dataset.src);
    if (t == null) return;
    c.classList.remove("pending", "fail");
    c.classList.toggle("auto", !mem(l).isReviewed(c.dataset.src));
    c.textContent = t;
  });
}

/* ---------- chapter vocabulary ---------- */
function vocabEntries(s) {
  const text = sectionBlocks(s, R.level).flatMap(b => b.type === "p" ? b.s : b.type === "h" ? [b.t] : []).join(" ");
  const seen = new Set(), out = [];
  let prev = "";
  for (const [w, isWord] of tokens(text)) {
    if (!isWord) continue;
    const lw = w.toLowerCase();
    for (const k of lemmasFor(w, prev)) if (R.book.dict[k].k && !seen.has("d" + k)) { seen.add("d" + k); out.push({ k }); }
    const g = R.glossIdx[lw];
    if (g && !seen.has(g.id)) { seen.add(g.id); out.push({ g: g.id }); }
    prev = lw;
  }
  return out;
}

const glossById = id => (R.book.glossary || []).find(g => g.id === id);

/** Known translation of a vocabulary item in language l ("" if none yet). */
function itemTr(it, l) {
  if (it.k) return R.book.dict[it.k][l] || mem(l).word("d:" + it.k) || "";
  if (it.g) { const g = glossById(it.g); return g ? mem(l).get(g.def) || "" : ""; }
  return (mem(l).word("w:" + it.form) || {}).t || "";
}

function vitemHTML(it, removable) {
  let ca, def = "";
  if (it.k) { const e = R.book.dict[it.k]; ca = headword(it.k); def = e.d; }
  else if (it.g) { const g = glossById(it.g); if (!g) return ""; ca = g.term; def = g.def; }
  else { ca = it.form; def = it.d || ""; }
  const data = it.k ? `data-k="${esc(it.k)}"` : it.g ? `data-g="${esc(it.g)}"` : `data-form="${esc(it.form)}"`;
  return `<div class="vitem" ${data} tabindex="0" role="button">
    <span class="vca" lang="${esc(src())}">${esc(ca)}</span>
    ${def ? `<span class="vdef" lang="${esc(src())}">${esc(def)}</span>` : ""}
    ${langsAll().map((l, i) => { const t = itemTr(it, l); return `<span class="vtr${i ? " sec" : ""}${t ? "" : " pending"}" ${trAttrs(l)}>${t ? esc(t) : "…"}</span>`; }).join("")}
    ${removable ? `<button type="button" class="ibtn sm" data-rm="${esc(JSON.stringify(it))}" aria-label="Treu la paraula">${ICON.close}</button>` : ""}
  </div>`;
}

function vocabHTML(items) {
  const s = sec();
  return `<section class="vocab"><h3>Paraules ${s.kind === "chapter" ? "del capítol " + s.n : "importants"}</h3>
    <p class="sub">Clica una paraula per veure-la amb més detall.</p>
    <div class="vgrid">${items.map(it => vitemHTML(it)).join("")}</div></section>`;
}

async function fillVocab(token, items) {
  for (const l of langsAll()) {
    try {
      const dictMissing = items.filter(it => it.k && !itemTr(it, l));
      if (dictMissing.length) {
        const res = await tr(dictMissing.map(it => R.book.dict[it.k].w || it.k), l);
        for (const [i, it] of dictMissing.entries()) await mem(l).setWord("d:" + it.k, res[i]);
      }
      const defs = mem(l).missing(items.filter(it => it.g).map(it => (glossById(it.g) || {}).def));
      if (defs.length) await mem(l).setAuto(defs, await tr(defs, l));
    } catch (e) { console.warn(e); }
  }
  if (token !== R.token) return;
  $$(".vocab .vitem").forEach((el, i) => {
    const html = vitemHTML(items[i]);
    if (html) el.outerHTML = html;
  });
}

/* ---------- word popover ---------- */
const pop = () => $("#pop");
let popAnchor = null;

function closePop() {
  const p = pop(); if (!p) return;
  p.hidden = true; popAnchor = null;
  $$(".w.on").forEach(w => w.classList.remove("on"));
}

function placePop() {
  const p = pop();
  if (p.hidden) return;
  const narrow = matchMedia("(max-width: 760px)").matches;
  p.classList.toggle("sheet", narrow || !popAnchor);
  if (narrow || !popAnchor) { p.style.left = ""; p.style.top = ""; return; }
  const r = popAnchor.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
  let left = r.left + r.width / 2 - pw / 2 + scrollX;
  left = Math.max(scrollX + 16, Math.min(left, scrollX + innerWidth - pw - 16));
  let top = r.bottom + 10 + scrollY;
  if (r.bottom + ph + 20 > innerHeight && r.top - ph - 10 > 0) top = r.top - ph - 10 + scrollY;
  p.style.left = left + "px"; p.style.top = top + "px";
}

function showPop(html, anchor) {
  $$(".w.on").forEach(w => w.classList.remove("on"));
  popAnchor = anchor || null;
  if (anchor && anchor.classList.contains("w")) anchor.classList.add("on");
  const p = pop();
  p.innerHTML = html;
  p.hidden = false;
  placePop();
  const c = p.querySelector("[data-close]");
  if (c) c.focus({ preventScroll: true });
}

const isSaved = it => R.saved.some(x => (it.k && x.k === it.k) || (it.g && x.g === it.g) || (it.form && x.form === it.form));

function entryTools(it, sayText) {
  return `<div class="tools">
    <button type="button" class="ibtn" data-say="${esc(sayText)}" aria-label="Escolta">${ICON.speak}</button>
    <button type="button" class="ibtn" data-save='${esc(JSON.stringify(it))}' aria-pressed="${isSaved(it)}" aria-label="Desa la paraula">${ICON.save}</button>
    <button type="button" class="ibtn" data-close aria-label="Tanca">${ICON.close}</button></div>`;
}

const trRow = (id, l, value) =>
  `<div><dt>${esc(trName(l))}</dt><dd class="trd${value ? "" : " pending"}" id="${id}" ${trAttrs(l)}>${value ? esc(value) : "…"}</dd></div>`;

/** Opens the popover for a word of the text. */
async function openWord(el) {
  const form = el.textContent;
  const lw = form.toLowerCase();
  const row = el.closest(".row");
  const sentence = row && row.dataset.i != null ? R.rowTexts[+row.dataset.i] : form;
  const ks = el.dataset.k ? el.dataset.k.split("|") : [];
  const g = el.dataset.g ? glossById(el.dataset.g) : null;
  const parts = [];
  const pending = [];

  // every word shows both languages (main and second)
  const langs = langsAll();
  const rows = (base, kind, extra, knownFn) => langs.map(l => {
    const known = knownFn(l);
    const id = `${base}-${l}`;
    if (!known) pending.push(Object.assign({ id, kind, l }, extra));
    return trRow(id, l, known);
  }).join("");

  ks.forEach((k, i) => {
    const e = R.book.dict[k];
    parts.push(`<div class="${i ? "alt" : ""}"><div class="head"><div><div class="hw" lang="ca">${esc(headword(k))}</div><div class="pos">${esc(e.p)}</div>
      ${form.toLowerCase() !== (e.w || k).toLowerCase() && !/^nom propi/.test(e.p) ? `<div class="form">Al text: <b>${esc(form)}</b></div>` : ""}</div>
      ${i === 0 ? entryTools({ k }, e.w || k) : ""}</div>
      <dl><div><dt>Què vol dir</dt><dd lang="ca">${esc(e.d)}</dd></div>${rows("pt-d" + i, "d", { k, text: e.w || k }, l => itemTr({ k }, l))}</dl></div>`);
  });
  if (g) {
    parts.push(`<div class="${parts.length ? "alt" : ""}"><div class="head"><div><div class="hw" lang="ca">${esc(g.term)}</div><div class="pos">Glossari del llibre</div></div>
      ${parts.length ? "" : entryTools({ g: g.id }, g.term)}</div>
      <dl><div><dt>Què vol dir</dt><dd lang="ca">${esc(g.def)}</dd></div>${rows("pt-g", "g", { text: g.def }, l => mem(l).get(g.def))}</dl></div>`);
  }
  if (!parts.length) {
    const known = langs.map(l => mem(l).word("w:" + lw)).find(Boolean);
    parts.push(`<div><div class="head"><div><div class="hw" lang="ca">${esc(known && known.lemma || form)}</div>
      ${known && known.lemma && known.lemma.toLowerCase() !== lw ? `<div class="form">Al text: <b>${esc(form)}</b></div>` : ""}</div>${entryTools({ form: lw }, form)}</div>
      <dl>${known && known.d ? `<div><dt>Què vol dir</dt><dd lang="ca">${esc(known.d)}</dd></div>` : `<div id="pt-wd" hidden></div>`}
      ${rows("pt-w", "w", {}, l => (mem(l).word("w:" + lw) || {}).t)}</dl>
      ${langs.length ? `<div class="note">Traducció automàtica${known && known.by ? " · " + esc(providerLabel(known.by)) : ""}.</div>` : ""}</div>`);
  }
  showPop(parts.join("") + (ks.length > 1 ? `<div class="note">Aquesta paraula pot tenir més d’un significat.</div>` : ""), el);

  for (const p of pending) {
    try {
      let value;
      const m = mem(p.l);
      if (p.kind === "d") { [value] = await tr([p.text], p.l); await m.setWord("d:" + p.k, value); }
      else if (p.kind === "g") { [value] = await tr([p.text], p.l); await m.setAuto([p.text], [value]); }
      else {
        const r = await translateWord(form, sentence, src(), p.l);
        await m.setWord("w:" + lw, r);
        value = r.t;
        const wd = $("#pt-wd");
        if (wd && r.d) { wd.outerHTML = `<div><dt>Què vol dir</dt><dd lang="ca">${esc(r.d)}</dd></div>`; }
      }
      const dd = $("#" + p.id);
      if (dd) { dd.textContent = value; dd.classList.remove("pending"); }
    } catch (e) {
      const dd = $("#" + p.id);
      if (dd) { dd.textContent = e.message || "No s'ha pogut traduir."; dd.classList.remove("pending"); dd.classList.add("err"); }
    }
    placePop();
  }
}

/** Opens a saved / vocabulary item. */
function openItem(el) {
  const it = el.dataset.k ? { k: el.dataset.k } : el.dataset.g ? { g: el.dataset.g } : { form: el.dataset.form };
  const span = document.createElement("span");
  span.className = "w";
  if (it.k) { span.dataset.k = it.k; span.textContent = R.book.dict[it.k].w || it.k; }
  else if (it.g) { span.dataset.g = it.g; span.textContent = glossById(it.g).term; }
  else span.textContent = it.form;
  // reuse the word popover, anchored to the list item
  openWord(span).then(() => { popAnchor = el; placePop(); });
  popAnchor = el;
}

async function openExplain(row) {
  const text = R.rowTexts[+row.dataset.i];
  showPop(`<div class="head"><div><div class="hw">Explica-m’ho fàcil</div><div class="pos">${esc(text)}</div></div>
    <div class="tools"><button type="button" class="ibtn" data-close aria-label="Tanca">${ICON.close}</button></div></div>
    <dl id="explain"><div><dd class="pending">…</dd></div></dl>`, row.querySelector(".explain"));
  try {
    const l = langsAll()[0];
    const r = await explainSentence(text, src(), l || "en");
    const box = $("#explain");
    if (box) box.innerHTML = `<div><dt>Més fàcil</dt><dd lang="ca">${esc(r.simple_ca)}</dd></div>
      ${!l ? "" : `<div><dt>${esc(trName(l))}</dt><dd ${trAttrs(l)} class="trd">${esc(r.translation)}</dd></div>
      <div><dt>Nota</dt><dd ${trAttrs(l)} class="trd">${esc(r.note)}</dd></div>`}`;
  } catch (e) {
    const box = $("#explain");
    if (box) box.innerHTML = `<div><dd class="err">${esc(e.message)}</dd></div>`;
  }
  placePop();
}

/* ---------- saved words ---------- */
async function toggleSave(it) {
  const i = R.saved.findIndex(x => (it.k && x.k === it.k) || (it.g && x.g === it.g) || (it.form && x.form === it.form));
  if (i >= 0) { R.saved.splice(i, 1); toast("Paraula treta"); }
  else { R.saved.push(Object.assign({ sec: R.sec }, it)); toast("Paraula desada"); }
  await kv.set("words:" + R.book.id, R.saved);
  $$("[data-save]").forEach(b => b.setAttribute("aria-pressed", isSaved(JSON.parse(b.dataset.save))));
  $("#wcount").textContent = R.saved.length ? `(${R.saved.length})` : "";
  $$(".w", $("#spread")).forEach(w => {
    const ks = w.dataset.k ? w.dataset.k.split("|") : [];
    w.classList.toggle("saved", R.saved.some(x => (x.k && ks.includes(x.k)) || (x.g && x.g === w.dataset.g) || x.form === w.textContent.toLowerCase()));
  });
  if (!$("#drawer").hidden) drawWords();
}

function drawWords() {
  const d = $("#drawer");
  d.innerHTML = `<div class="dh"><h3>Les meves paraules</h3><button type="button" class="ibtn" data-closedrawer aria-label="Tanca">${ICON.close}</button></div>
    <p class="muted">Les paraules que has desat d’aquest llibre.</p>
    ${R.saved.length ? R.saved.map(it => vitemHTML(it, true)).join("") : `<div class="empty">Encara no has desat cap paraula. Clica una paraula del text i després el botó de desar.</div>`}`;
}
function toggleDrawer(force) {
  const d = $("#drawer"), open = force != null ? force : d.hidden;
  d.hidden = !open;
  $("#wordsBtn").setAttribute("aria-pressed", open);
  if (open) drawWords();
}

/* ---------- reading aloud ---------- */
let reading = false;
function stopReading() {
  reading = false; speech.stop();
  $$(".row.speaking").forEach(r => r.classList.remove("speaking"));
  const b = $("#readBtn"); if (!b) return;
  b.setAttribute("aria-pressed", "false");
  $("span", b).textContent = "Escolta la pàgina";
}
function readPage() {
  if (reading) { stopReading(); return; }
  if (!speech.canSpeak()) { toast("Aquest navegador no pot llegir en veu alta."); return; }
  const rows = $$(".row[data-i]", $("#spread"));
  if (!rows.length) return;
  if (!speech.hasVoice(src())) toast("No hi ha cap veu catalana instal·lada en aquest dispositiu.");
  reading = true;
  const b = $("#readBtn"); b.setAttribute("aria-pressed", "true"); $("span", b).textContent = "Atura";
  let i = 0;
  const step = () => {
    rows.forEach(r => r.classList.remove("speaking"));
    if (!reading || i >= rows.length) { stopReading(); return; }
    const r = rows[i++]; r.classList.add("speaking");
    r.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const text = R.rowTexts[+r.dataset.i];
    const l = langsShown()[0];
    const t = l && P.voiceTr && mem(l).get(text);
    speech.speak(text, src(), { slow: P.slow, onend: t ? () => reading && speech.speak(t, l, { slow: P.slow, onend: step }) : step });
  };
  speech.stop();
  step();
}

/* ---------- navigation ---------- */
function go(d) {
  if (d > 0) {
    if (R.page < R.pages.length - 1) R.page++;
    else if (R.sec < R.book.sections.length - 1) { R.sec++; R.page = 0; } else return;
  } else {
    if (R.page > 0) R.page--;
    else if (R.sec > 0) { R.sec--; R.page = buildPages().length - 1; } else return;
  }
  render();
  scrollTo({ top: 0, behavior: "instant" });
}

/* ---------- menus and teacher tools ---------- */
function textPanel() {
  const seg = (name, val, opts) => `<div class="seg" data-pref="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join("")}</div>`;
  return `<div class="ctl"><span class="lbl">Mida de la lletra</span>
      <div class="seg" id="fsz"><button type="button" data-d="-1" aria-label="Lletra més petita">A−</button><button type="button" data-d="1" aria-label="Lletra més gran">A+</button></div></div>
    <div class="ctl"><span class="lbl">Espai entre línies</span>${seg("lh", P.lh, [[1.6, "Normal"], [1.9, "Ample"], [2.2, "Molt ample"]])}</div>
    <div class="ctl"><span class="lbl">Vista</span>${seg("view", P.view, [["pages", "Pàgines"], ["scroll", "Capítol sencer"]])}</div>
    <div class="ctl"><span class="lbl">Traducció</span>${seg("pos", P.pos, [["side", "Al costat"], ["below", "A sota"]])}</div>
    <div class="ctl"><span class="lbl">Escolta</span>${seg("voiceTr", P.voiceTr, [[false, "Català"], [true, "Català i traducció"]])}</div>
    <div class="ctl"><span class="lbl">Veu</span>${seg("slow", P.slow, [[false, "Normal"], [true, "Lenta"]])}</div>
    <div class="ctl"><span class="lbl">Mode concentració</span>${seg("focus", P.focus, [[false, "No"], [true, "Sí"]])}</div>
    <div class="ctl"><span class="lbl">Colors</span>${seg("theme", P.theme, [["auto", "Auto"], ["light", "Clar"], ["dark", "Fosc"]])}</div>`;
}

function toolsPanel() {
  const names = langsAll().map(l => langInfo(l).name.toLowerCase());
  const has = names.length > 0;
  return `<button type="button" class="mi" data-tool="teacher" aria-pressed="${R.teacher}">${ICON.edit}<span>Mode docent: corregeix la traducció</span></button>
    <button type="button" class="mi" data-tool="translateAll" ${has ? "" : "disabled"}>${ICON.globe}<span>Tradueix tot el llibre${has ? " a " + esc(names.join(" i ")) : ""}</span></button>
    <button type="button" class="mi" data-tool="share">${ICON.link}<span>Comparteix amb l’alumnat…</span></button>
    <hr>
    <button type="button" class="mi" data-tool="exportTr" ${has ? "" : "disabled"}>${ICON.download}<span>Desa la traducció (fitxer)</span></button>
    <button type="button" class="mi" data-tool="importTr">${ICON.upload}<span>Carrega una traducció (fitxer)</span></button>
    <button type="button" class="mi" data-tool="exportBook">${ICON.download}<span>Desa el llibre amb les traduccions</span></button>
    <hr>
    ${(R.book.glossary || []).length ? `<button type="button" class="mi" data-tool="glossary">${ICON.book}<span>Glossari del llibre</span></button>` : ""}
    <button type="button" class="mi" data-tool="print">${ICON.print}<span>Imprimeix el capítol (bilingüe)</span></button>
    <button type="button" class="mi" data-tool="settings">${ICON.gear}<span>Configura el traductor…</span></button>`;
}

function openMenu(btn, html) {
  const panel = $("#" + btn.getAttribute("aria-controls"));
  const open = panel.hidden;
  closeMenus();
  if (!open) return;
  panel.innerHTML = html;
  panel.hidden = false;
  btn.setAttribute("aria-expanded", "true");
}
export function closeMenus() {
  $$(".menu").forEach(m => { m.hidden = true; });
  $$("[aria-controls]").forEach(b => b.setAttribute("aria-expanded", "false"));
}

async function runTool(t) {
  closeMenus();
  if (t === "teacher") {
    R.teacher = !R.teacher;
    toast(R.teacher ? "Mode docent: clica una traducció per corregir-la. Es desa sola." : "Mode docent desactivat");
    render();
  } else if (t === "translateAll") translateAll();
  else if (t === "share") shareDialog();
  else if (t === "exportTr") {
    for (const l of langsAll()) downloadJSON(translationPack(R.book, mem(l)), `${slug(R.book.title)}.${l}.traduccio.json`);
    toast(langsAll().length > 1 ? "Traduccions desades (un fitxer per llengua)" : "Traducció desada");
  } else if (t === "importTr") pickFile(".json", async f => {
    try {
      const r = await importPack(JSON.parse(await f.text()));
      if (r.kind !== "translation" || r.book.id !== R.book.id) throw new Error("Aquest fitxer no és una traducció d’aquest llibre.");
      if (!langsAll().includes(r.lang)) { P.lang = r.lang; savePrefs(); }
      delete R.mems[r.lang];
      await loadMemory(); fillChrome(); render();
      toast(`Traducció carregada: ${langInfo(r.lang).name}`);
    } catch (e) { toast(e.message, 5000); }
  });
  else if (t === "exportBook") {
    downloadJSON(await bookPack(R.book), `${slug(R.book.title)}.lecturafacil.json`);
    toast("Llibre desat amb totes les traduccions");
  } else if (t === "glossary") glossaryDialog();
  else if (t === "print") printSection();
  else if (t === "settings") document.dispatchEvent(new CustomEvent("lf:settings"));
}

export function pickFile(accept, fn) {
  const i = document.createElement("input");
  i.type = "file"; i.accept = accept;
  i.onchange = () => i.files[0] && fn(i.files[0]);
  i.click();
}

async function translateAll() {
  const all = allTexts(R.book);
  const jobs = langsAll().map(l => ({ l, texts: mem(l).missing(all) })).filter(j => j.texts.length);
  const names = langsAll().map(l => langInfo(l).name.toLowerCase()).join(" i ");
  if (!jobs.length) { toast(`Tot el llibre ja està traduït a ${names}.`); return; }
  const total = jobs.reduce((a, j) => a + j.texts.length, 0);
  const provider = providerLabel(await resolveProvider(src(), jobs[0].l));
  const ctrl = new AbortController();
  let done = 0, failed = null;
  const p = dialog(`<h2>Tradueix tot el llibre</h2>
    <p>${total} frases a ${esc(names)} amb <b>${esc(provider)}</b>. Pots continuar llegint mentre es tradueix; el que ja estigui traduït es desa.</p>
    <div class="progress big"><div class="track"><div class="fill" id="taFill"></div></div><small id="taText">0 de ${total}</small></div>
    <div class="dlg-actions"><button type="button" class="btn" data-close="stop">Atura</button></div>`);
  p.then(() => ctrl.abort());
  outer: for (const { l, texts } of jobs) {
    for (let i = 0; i < texts.length; i += 40) {
      if (ctrl.signal.aborted) break outer;
      const part = texts.slice(i, i + 40);
      try {
        await mem(l).setAuto(part, await tr(part, l, { signal: ctrl.signal }));
        done += part.length;
      } catch (e) { if (!ctrl.signal.aborted) failed = e; break outer; }
      const f = $("#taFill"), tx = $("#taText");
      if (f) f.style.width = (done / total * 100) + "%";
      if (tx) tx.textContent = `${done} de ${total}`;
    }
  }
  const d = $(".dlg[open]");
  if (failed) {
    if (d) d.querySelector("p").innerHTML = `<b>S’ha aturat:</b> ${esc(failed.message)} · S’han traduït ${done} frases.`;
  } else if (d) d.close("done");
  if (!failed && done) toast(`Llibre traduït a ${names}. Revisa’l amb el mode docent i comparteix-lo.`, 4000);
  render();
}

function shareDialog() {
  const base = location.origin + location.pathname;
  const b = R.book;
  const [l1, l2] = langsAll();
  const langQ = (l1 ? `&llengua=${encodeURIComponent(l1)}` : "") + (l2 ? `&llengua2=${encodeURIComponent(l2)}` : "");
  const direct = b.origin === "bundled" ? `${base}?llibre=${encodeURIComponent(b.id)}${langQ}` : b.origin === "url" && b.source ? `${base}?llibre=${encodeURIComponent(b.source)}${langQ}` : null;
  dialog(`<h2>Comparteix amb l’alumnat</h2>
    ${direct ? `<h3>Enllaç directe</h3><p>Obre aquest llibre${l1 ? ` amb la traducció a ${esc(langsAll().map(l => langInfo(l).name.toLowerCase()).join(" i "))}` : ""} a qualsevol dispositiu.</p>
      <div class="copyrow"><input type="text" readonly value="${esc(direct)}" id="shLink"><button type="button" class="btn" data-copy="#shLink">Copia</button></div>
      ${b.origin === "bundled" && l1 ? `<p class="muted">Les traduccions automàtiques o corregides en aquest navegador no viatgen amb l’enllaç: cada dispositiu les torna a fer. Per compartir la teva traducció revisada, fes servir un fitxer.</p>` : ""}` : ""}
    <h3>Amb un fitxer</h3>
    <p>Desa el llibre amb totes les traduccions i envia’l (Classroom, Drive, correu…). L’alumne l’obre a <b>Afegeix un llibre → Tria un fitxer</b>.</p>
    <div class="dlg-actions left"><button type="button" class="btn primary" data-act="book">${ICON.download} Desa el llibre i les traduccions</button>
    ${l1 ? `<button type="button" class="btn" data-act="tr">${ICON.download} Només la traducció</button>` : ""}</div>
    <h3>Amb un enllaç a un fitxer publicat</h3>
    <p>Si penges el fitxer del llibre en un lloc públic (per exemple, a la carpeta <code>data/books</code> d’un repositori de GitHub o en un Gist), enganxa’n l’adreça i obtindràs un enllaç que l’obre directament.</p>
    <div class="copyrow"><input type="url" id="shUrl" placeholder="https://…/llibre.lecturafacil.json"><button type="button" class="btn" data-act="mk">Crea l’enllaç</button></div>
    <div class="copyrow" id="shOut" hidden><input type="text" readonly id="shOutLink"><button type="button" class="btn" data-copy="#shOutLink">Copia</button></div>
    <div class="dlg-actions"><button type="button" class="btn" data-close>Tanca</button></div>`, {
    wide: true,
    onOpen: d => d.addEventListener("click", async e => {
      const c = e.target.closest("[data-copy]");
      if (c) { const inp = $(c.dataset.copy, d); if (await copyText(inp.value)) toast("Enllaç copiat"); else { inp.select(); toast("Copia’l amb Ctrl+C"); } }
      const a = e.target.closest("[data-act]");
      if (!a) return;
      if (a.dataset.act === "book") runTool("exportBook");
      if (a.dataset.act === "tr") runTool("exportTr");
      if (a.dataset.act === "mk") {
        const u = $("#shUrl", d).value.trim();
        if (!/^https?:\/\//.test(u)) { toast("Enganxa una adreça que comenci per https://"); return; }
        $("#shOut", d).hidden = false;
        $("#shOutLink", d).value = `${base}?llibre=${encodeURIComponent(u)}${langQ}`;
      }
    })
  });
}

function glossaryDialog() {
  const items = (R.book.glossary || []).map(g => ({ g: g.id }));
  dialog(`<h2>Glossari del llibre</h2><div class="vlist">${items.map(it => vitemHTML(it)).join("")}</div>
    <div class="dlg-actions"><button type="button" class="btn" data-close>Tanca</button></div>`, {
    wide: true,
    onOpen: async d => {
      for (const l of langsAll()) {
        const defs = mem(l).missing(R.book.glossary.map(g => g.def));
        try { if (defs.length) await mem(l).setAuto(defs, await tr(defs, l)); } catch (e) { toast(e.message); }
      }
      $$(".vitem", d).forEach((el, i) => { el.outerHTML = vitemHTML(items[i]); });
    }
  });
}

function printSection() {
  R.printing = true;
  render();
  const done = () => { R.printing = false; render(); removeEventListener("afterprint", done); };
  addEventListener("afterprint", done);
  // give translations a moment to arrive before printing
  setTimeout(() => print(), 400);
}

/* ---------- events (bound once) ---------- */
export function bindReader() {
  $("#backBtn").addEventListener("click", () => { closeBook(); onExit(); });
  $("#chap").addEventListener("change", e => { R.sec = +e.target.value; R.page = 0; render(); });
  $("#lvl").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b || b.dataset.v === R.level) return;
    const ratio = R.page / Math.max(1, R.pages.length - 1);
    R.level = b.dataset.v; R.pages = buildPages(); R.page = Math.round(ratio * (R.pages.length - 1)); render();
  });
  const langChanged = async (key, value) => {
    P[key] = value;
    if (key === "lang2" && value !== "none") P.show = "both"; // a new second language: show both
    savePrefs(); trError = null;
    await loadMemory(); render();
  };
  $("#trLang").addEventListener("change", e => langChanged("lang", e.target.value));
  $("#trLang2").addEventListener("change", e => langChanged("lang2", e.target.value));
  $("#hideBtn").addEventListener("click", () => { P.hide = !P.hide; savePrefs(); render(); });
  $("#wordsBtn").addEventListener("click", () => toggleDrawer());
  $("#readBtn").addEventListener("click", readPage);
  $("#prev").addEventListener("click", () => go(-1));
  $("#next").addEventListener("click", () => go(1));
  $("#textBtn").addEventListener("click", e => openMenu(e.currentTarget, textPanel()));
  $("#toolsBtn").addEventListener("click", e => openMenu(e.currentTarget, toolsPanel()));
  $("#teacherBadge").addEventListener("click", () => runTool("teacher"));

  $("#textMenu").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.d) { P.fs = Math.max(15, Math.min(34, P.fs + 2 * b.dataset.d)); }
    else {
      const seg = b.closest("[data-pref]"); if (!seg) return;
      const k = seg.dataset.pref, raw = b.dataset.v;
      P[k] = raw === "true" ? true : raw === "false" ? false : isNaN(+raw) ? raw : +raw;
      seg.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b));
      if (k === "theme") applyTheme();
    }
    savePrefs();
    if (!["slow", "voiceTr", "theme"].includes(b.closest("[data-pref]")?.dataset.pref)) render();
  });
  $("#toolsMenu").addEventListener("click", e => { const b = e.target.closest("[data-tool]"); if (b) runTool(b.dataset.tool); });

  document.addEventListener("click", e => {
    if (!R.book || $("#view-reader").hidden) return;
    const t = e.target;
    if (!t.closest(".menu") && !t.closest("[aria-controls]")) closeMenus();
    const w = t.closest(".w");
    if (w && !t.closest(".pop")) { e.stopPropagation(); setActive(w.closest(".row")); openWord(w); return; }
    const say = t.closest(".say");
    if (say) { const row = say.closest(".row"); setActive(row); speech.stop(); if (!speech.speak(R.rowTexts[+row.dataset.i], src(), { slow: P.slow })) toast("Aquest navegador no pot llegir en veu alta."); return; }
    const ex = t.closest(".explain"); if (ex) { const row = ex.closest(".row"); setActive(row); openExplain(row); return; }
    const ds = t.closest("[data-say]"); if (ds) { speech.stop(); speech.speak(ds.dataset.say, src(), { slow: P.slow }); return; }
    const sv = t.closest("[data-save]"); if (sv) { toggleSave(JSON.parse(sv.dataset.save)); return; }
    if (t.closest(".pop [data-close]")) { const a = popAnchor; closePop(); if (a && a.focus) a.focus(); return; }
    if (t.closest("[data-closedrawer]")) { toggleDrawer(false); return; }
    const rm = t.closest("[data-rm]"); if (rm) { e.stopPropagation(); toggleSave(JSON.parse(rm.dataset.rm)); return; }
    const vi = t.closest(".vitem"); if (vi && !t.closest(".dlg")) { openItem(vi); return; }
    if (t.closest("[data-retry]")) { trError = null; render(); return; }
    const sw = t.closest("[data-show]");
    if (sw) { P.show = sw.dataset.show; savePrefs(); render(); return; }
    const g = t.closest("[data-go]");
    if (g) { if (g.dataset.go === "restart") R.page = 0; else { R.sec++; R.page = 0; } render(); scrollTo(0, 0); return; }
    if (t.closest(".pop") || t.closest(".trt[contenteditable]")) return;
    closePop();
    setActive(t.closest(".row[data-i]"));
  });
  // teacher corrections are saved when the cell loses focus
  document.addEventListener("focusout", async e => {
    const c = e.target;
    if (!c.matches || !c.matches(".trt[contenteditable]") || !mem(c.dataset.lang)) return;
    const m = mem(c.dataset.lang);
    const v = c.innerText.trim();
    if (v === (m.get(c.dataset.src) || "")) return;
    await m.setReviewed(c.dataset.src, v);
    c.classList.remove("auto");
    toast(v ? "Traducció corregida i desada" : "Correcció esborrada");
  });
  document.addEventListener("keydown", e => {
    if (!R.book || $("#view-reader").hidden || $(".dlg[open]")) return;
    if (e.key === "Escape") {
      if (!$("#pop").hidden) { const a = popAnchor; closePop(); if (a && a.focus) a.focus(); }
      else if (!$("#drawer").hidden) toggleDrawer(false);
      else closeMenus();
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".w, .vitem")) { e.preventDefault(); e.target.click(); return; }
    if (e.target.matches("input, select, textarea, [contenteditable]")) return;
    if (e.key === "ArrowRight") go(1);
    if (e.key === "ArrowLeft") go(-1);
    // T: main language → second language → both
    if ((e.key === "t" || e.key === "T") && langsAll().length > 1) { P.show = { 1: "2", 2: "both", both: "1" }[P.show] || "1"; savePrefs(); render(); }
  });
  let tx = null, ty = null;
  $("#spread").addEventListener("touchstart", e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  $("#spread").addEventListener("touchend", e => {
    if (tx == null) return;
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; tx = null;
    if (P.view === "pages" && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) go(dx < 0 ? 1 : -1);
  }, { passive: true });
  addEventListener("resize", placePop);
}

function setActive(row) {
  $$(".row.active").forEach(r => { if (r !== row) r.classList.remove("active"); });
  if (row) row.classList.add("active");
}

const THEMES = {
  auto: { icon: "contrast", label: "Colors automàtics (com el dispositiu)" },
  light: { icon: "sun", label: "Colors clars" },
  dark: { icon: "moon", label: "Colors foscos" }
};

/** Applies P.theme and shows it on the header buttons. */
export function applyTheme() {
  if (!THEMES[P.theme]) P.theme = "auto";
  if (P.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", P.theme);
  const t = THEMES[P.theme];
  const next = THEMES[nextTheme()].label.toLowerCase();
  $$(".themeBtn").forEach(b => {
    b.innerHTML = ICON[t.icon];
    b.setAttribute("aria-label", `${t.label}. Canvia a: ${next}`);
    b.title = `${t.label} · clica per canviar`;
  });
}
const nextTheme = () => ({ auto: "light", light: "dark", dark: "auto" })[P.theme] || "auto";

/** Header button: automatic → light → dark. */
export function cycleTheme() {
  P.theme = nextTheme();
  savePrefs();
  applyTheme();
  closeMenus(); // the Aa menu shows the theme too: reopen it to see the change
}
