/* Library data: bundled books (data/library.json), books added by the
   teacher (IndexedDB), shareable packs, and translation memories. */

import { books as bookStore, translations as trStore } from "./store.js";
import { hashText } from "./text.js";
import { importFile } from "./importers.js";
import { slug } from "./ui.js";

export const FORMAT = "lecturafacil";
export const FORMAT_VERSION = 1;

const memory = new Map(); // id -> full book (bundled ones are kept here, not in IndexedDB)
let manifest = null;      // Promise<Map> id -> library.json entry

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/** Entries of data/library.json plus data/library.local.json (ignored by git, for local copies). */
function loadManifest() {
  if (!manifest) {
    manifest = (async () => {
      const m = new Map();
      // local copies (not published) are only looked for on this computer
      const local = ["localhost", "127.0.0.1", ""].includes(location.hostname);
      for (const file of ["data/library.json", ...(local ? ["data/library.local.json"] : [])]) {
        try {
          const j = await fetchJSON(file);
          for (const e of j.books || []) m.set(e.id, Object.assign({ origin: "bundled" }, e));
        } catch { /* the local file is optional */ }
      }
      return m;
    })();
  }
  return manifest;
}

/** Summary of every book for the library view. */
export async function listBooks() {
  const m = await loadManifest();
  const out = [];
  for (const e of m.values()) {
    try { out.push(summary(await getBook(e.id))); }
    catch (err) { console.warn("No s'ha pogut carregar", e.id, err); }
  }
  for (const b of await bookStore.all()) if (!m.has(b.id)) out.push(summary(b));
  return out;
}

function summary(b) {
  return {
    id: b.id, title: b.title, subtitle: b.subtitle || "", author: b.author || "", cover: b.cover || null,
    origin: b.origin || "local", source: b.source || null,
    chapters: b.sections.filter(s => s.kind === "chapter").length,
    builtIn: Object.keys(b.translations || {}), added: b.added || 0
  };
}

const loadingBooks = new Map(); // id -> Promise, so parallel requests share one load

/** Full book by id (bundled books are fetched and, if they are EPUB files, imported once). */
export function getBook(id) {
  if (memory.has(id)) return Promise.resolve(memory.get(id));
  if (!loadingBooks.has(id)) loadingBooks.set(id, loadBook(id).finally(() => loadingBooks.delete(id)));
  return loadingBooks.get(id);
}

async function loadBook(id) {
  const m = await loadManifest();
  const e = m.get(id);
  let book;
  if (e) {
    const src = "data/" + e.src;
    if (/\.json$/i.test(e.src)) {
      book = normalizeBook(await fetchJSON(src), { id: e.id });
    } else {
      const cached = await bookStore.get(id);
      if (cached && cached.srcVersion === (e.version || 1)) book = cached;
      else {
        const r = await fetch(src);
        if (!r.ok) throw new Error(`${src}: ${r.status}`);
        const blob = await r.blob();
        const imp = await importFile(new File([blob], e.src.split("/").pop()));
        book = buildBook(Object.assign(imp, { title: e.title || imp.title, author: e.author || imp.author, subtitle: e.subtitle, description: e.description }), { id, origin: "bundled", srcVersion: e.version || 1 });
        await bookStore.put(book).catch(() => {});
      }
    }
    book.origin = "bundled";
    book.shipped = e.translations || {};
  } else {
    book = await bookStore.get(id);
    if (!book) throw new Error("Aquest llibre no és a la biblioteca.");
  }
  memory.set(id, book);
  return book;
}

/** Builds a book object from an import result. */
export function buildBook(imp, extra = {}) {
  const sections = imp.sections.filter(s => s.sel !== false).map(({ kind, n, title, blocks }) => ({ kind, n, title, blocks }));
  return normalizeBook({
    format: FORMAT, version: FORMAT_VERSION,
    id: extra.id || uniqueId(imp.title),
    title: imp.title || "Sense títol", subtitle: imp.subtitle || "", author: imp.author || "",
    description: imp.description || "",
    lang: imp.lang && imp.lang.length === 2 && imp.lang !== "en" ? imp.lang : "ca",
    cover: imp.cover || null,
    sections, glossary: imp.glossary || [],
    added: Date.now(), ...extra
  });
}

const uniqueId = title => slug(title) + "-" + Date.now().toString(36);

const KINDS = ["front", "chapter", "activities", "glossary", "back"];

export function normalizeBook(b, extra = {}) {
  const book = Object.assign({ lang: "ca", sections: [], glossary: [], translations: {} }, b, extra);
  liftTranslations(book);
  book.sections.forEach((s, i) => {
    s.id = s.id || "s" + i;
    if (!KINDS.includes(s.kind)) s.kind = "chapter";
    if (s.kind === "chapter" && s.n != null) s.n = Number(s.n) || null;
  });
  // levels used by the sections but not declared (e.g. written by an AI)
  const used = [...new Set(book.sections.flatMap(s => s.levels ? Object.keys(s.levels) : []))];
  if (used.length && !(book.levels || []).length) book.levels = used.map(id => ({ id, label: LEVEL_LABEL[id] || id }));
  (book.glossary || []).forEach((g, i) => {
    g.id = g.id || "g" + i;
    g.term = String(g.term || "").toLowerCase();
    g.forms = (g.forms && g.forms.length ? g.forms : [g.term]).map(f => String(f).toLowerCase());
  });
  return book;
}
const LEVEL_LABEL = { original: "Original", facil: "Fàcil", molt: "Molt fàcil" };

/** Translations written next to the text ({ t, tr: { en: "…" } }, titleTr, …),
    as an AI can produce them, become the book's built-in translations (by hash). */
function liftTranslations(book) {
  const add = (text, tr) => {
    if (!text || !tr || typeof tr !== "object") return;
    for (const [l, v] of Object.entries(tr)) if (typeof v === "string" && v.trim()) (book.translations[l] = book.translations[l] || {})[hashText(text)] = v.trim();
  };
  if (book.titleTr) { add(book.title, book.titleTr); delete book.titleTr; }
  for (const s of book.sections) {
    if (s.titleTr) { add(s.title, s.titleTr); delete s.titleTr; }
    for (const blocks of s.levels ? Object.values(s.levels) : [s.blocks || []]) {
      for (const b of blocks) {
        if (b.type === "p") {
          b.s = (b.s || []).map(x => {
            if (x && typeof x === "object") { add(x.t, x.tr); return x.t; }
            return x;
          }).filter(x => typeof x === "string" && x.trim());
        } else if (b.type === "h" && b.tr) { add(b.t, b.tr); delete b.tr; }
      }
    }
  }
  for (const g of book.glossary || []) if (g.defTr) { add(g.def, g.defTr); delete g.defTr; }
}

/** Adds the sections, translations and words of a part to a book already saved. */
export function mergePart(base, part) {
  const key = s => s.kind === "chapter" && s.n != null ? "c" + s.n : s.kind + ":" + s.title;
  const sections = base.sections.slice();
  for (const s of part.sections) {
    const i = sections.findIndex(x => key(x) === key(s));
    if (i >= 0) sections[i] = s; else sections.push(s);
  }
  const rank = s => KINDS.indexOf(s.kind) * 10000 + (s.kind === "chapter" ? s.n || 0 : 0);
  sections.sort((a, b) => rank(a) - rank(b));
  sections.forEach((s, i) => { s.id = "s" + i; });
  const translations = Object.assign({}, base.translations);
  for (const [l, map] of Object.entries(part.translations || {})) translations[l] = Object.assign({}, translations[l], map);
  const terms = new Set((base.glossary || []).map(g => g.term));
  const glossary = (base.glossary || []).concat((part.glossary || []).filter(g => !terms.has(g.term)));
  glossary.forEach((g, i) => { g.id = "g" + i; });
  return Object.assign({}, base, {
    sections, translations, glossary,
    dict: Object.assign({}, base.dict, part.dict),
    credits: base.credits && base.credits.length ? base.credits : part.credits,
    levels: base.levels || part.levels
  });
}

export async function saveBook(book) {
  book.origin = book.origin === "bundled" ? "bundled" : book.origin || "local";
  await bookStore.put(book);
  memory.set(book.id, book);
  return book;
}

export async function deleteBook(id) {
  await bookStore.remove(id);
  await trStore.removeBook(id);
  memory.delete(id);
}

/* ---------- reading helpers ---------- */

/** Blocks of a section at a level (books with levels keep one block list per level). */
export function sectionBlocks(sec, level) {
  if (sec.levels) return sec.levels[level] || Object.values(sec.levels)[0] || [];
  return sec.blocks || [];
}

/** Every text of the book that can be translated (sentences, titles, glossary). */
export function allTexts(book) {
  const out = new Set([book.title]);
  for (const s of book.sections) {
    out.add(s.title);
    const lists = s.levels ? Object.values(s.levels) : [s.blocks || []];
    for (const blocks of lists) for (const b of blocks) {
      if (b.type === "p") b.s.forEach(x => out.add(x));
      else if (b.type === "h") out.add(b.t);
    }
  }
  for (const g of book.glossary || []) out.add(g.def);
  return [...out].filter(Boolean);
}

/* ---------- translation memory ---------- */

/** Translations of one book into one language, in layers:
    reviewed (m) > shipped with the app > built into the book > automatic (s). */
export class TrMemory {
  constructor(book, lang) { this.book = book; this.lang = lang; this.rec = null; this.shipped = {}; }

  async load() {
    this.rec = await trStore.get(this.book.id, this.lang);
    const url = this.book.shipped && this.book.shipped[this.lang];
    if (url) {
      try { const p = await fetchJSON("data/" + url); this.shipped = p.m || p.s || {}; this.rec.w = Object.assign({}, p.w || {}, this.rec.w); }
      catch (e) { console.warn("Traducció inclosa no disponible:", e); }
    }
    return this;
  }

  get(text) {
    const h = hashText(text);
    const built = (this.book.translations || {})[this.lang] || {};
    return this.rec.m[h] ?? this.shipped[h] ?? built[h] ?? this.rec.s[h] ?? null;
  }
  isReviewed(text) {
    const h = hashText(text);
    return h in this.rec.m || h in this.shipped || h in ((this.book.translations || {})[this.lang] || {});
  }
  missing(texts) { return [...new Set(texts)].filter(t => t && this.get(t) == null); }

  async setAuto(texts, results) {
    texts.forEach((t, i) => { if (results[i]) this.rec.s[hashText(t)] = results[i]; });
    await trStore.put(this.rec);
  }
  async setReviewed(text, value) {
    const h = hashText(text);
    if (value && value.trim()) this.rec.m[h] = value.trim(); else delete this.rec.m[h];
    await trStore.put(this.rec);
  }
  word(key) { return this.rec.w[key] || null; }
  async setWord(key, value) { this.rec.w[key] = value; await trStore.put(this.rec); }

  /** Everything known for this language, as one map (for sharing). */
  merged() {
    return Object.assign({}, this.rec.s, (this.book.translations || {})[this.lang] || {}, this.shipped, this.rec.m);
  }
  async importPack(pack) {
    Object.assign(this.rec.m, pack.m || {}, pack.s && !pack.m ? pack.s : {});
    Object.assign(this.rec.w, pack.w || {});
    await trStore.put(this.rec);
  }
}

/* ---------- packs (files to share) ---------- */

export function translationPack(book, mem) {
  return { format: FORMAT, version: FORMAT_VERSION, type: "translation", bookId: book.id, bookTitle: book.title, lang: mem.lang, m: mem.merged(), w: mem.rec.w, created: new Date().toISOString() };
}

/** A whole book with all its translations, ready to send to students. */
export async function bookPack(book) {
  const translations = {};
  for (const l of await trStore.languages(book.id)) {
    const mem = await new TrMemory(book, l).load();
    translations[l] = mem.merged();
  }
  const { shipped, origin, srcVersion, ...rest } = book;
  for (const [l, map] of Object.entries(rest.translations || {})) translations[l] = Object.assign({}, map, translations[l]);
  return Object.assign({}, rest, { format: FORMAT, version: FORMAT_VERSION, type: "book", translations });
}

/** Imports a pack (book or translation). Returns { kind, book, lang?, part? }.
    renameOnConflict: a book with the id of a bundled book gets a new id (books made by an AI). */
export async function importPack(obj, { sourceUrl, renameOnConflict = false } = {}) {
  if (!obj || obj.format !== FORMAT) throw new Error("Aquest fitxer no és un llibre ni una traducció de Lectura fàcil.");
  if (obj.version > FORMAT_VERSION) throw new Error("Aquest fitxer és d'una versió més nova de l'aplicació. Actualitza la pàgina.");
  if (obj.type === "translation") {
    const book = await getBook(obj.bookId).catch(() => null);
    if (!book) throw new Error(`Primer cal tenir el llibre «${obj.bookTitle || obj.bookId}» a la biblioteca.`);
    const mem = await new TrMemory(book, obj.lang).load();
    await mem.importPack(obj);
    return { kind: "translation", book, lang: obj.lang };
  }
  if (!Array.isArray(obj.sections) || !obj.sections.length) throw new Error("Al fitxer hi falten els capítols.");
  if (!obj.id) obj = Object.assign({}, obj, { id: uniqueId(obj.title || "llibre") });
  const bundled = (await loadManifest()).has(obj.id);
  if (bundled) {
    if (!renameOnConflict) throw new Error("Aquest llibre ja és a la biblioteca.");
    obj = Object.assign({}, obj, { id: obj.id + "-propi" });
  }
  const { part, type, ...data } = obj;
  let book = normalizeBook(Object.assign({}, data, { origin: sourceUrl ? "url" : "local", source: sourceUrl || null, added: Date.now() }));
  const existing = memory.get(book.id) || await bookStore.get(book.id);
  if (part && existing && existing.origin !== "bundled") book = mergePart(existing, book);
  await saveBook(book);
  return { kind: "book", book, part: part || null };
}

/** Opens a pack published on the web (shared link ?llibre=https://...). */
export async function importFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No s'ha pogut obrir l'enllaç (${r.status}).`);
  return importPack(await r.json(), { sourceUrl: url });
}

export async function translatedLanguages(book) {
  const own = await trStore.languages(book.id);
  return [...new Set([...Object.keys(book.translations || {}), ...Object.keys(book.shipped || {}), ...own])];
}
