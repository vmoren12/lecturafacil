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

function normalizeBook(b, extra = {}) {
  const book = Object.assign({ lang: "ca", sections: [], glossary: [], translations: {} }, b, extra);
  book.sections.forEach((s, i) => { s.id = s.id || "s" + i; });
  return book;
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

/** Imports a pack (book or translation). Returns { kind, book, lang? }. */
export async function importPack(obj, { sourceUrl } = {}) {
  if (!obj || obj.format !== FORMAT) throw new Error("Aquest fitxer no és un llibre ni una traducció de Lectura fàcil.");
  if (obj.version > FORMAT_VERSION) throw new Error("Aquest fitxer és d'una versió més nova de l'aplicació. Actualitza la pàgina.");
  if (obj.type === "translation") {
    const book = await getBook(obj.bookId).catch(() => null);
    if (!book) throw new Error(`Primer cal tenir el llibre «${obj.bookTitle || obj.bookId}» a la biblioteca.`);
    const mem = await new TrMemory(book, obj.lang).load();
    await mem.importPack(obj);
    return { kind: "translation", book, lang: obj.lang };
  }
  if (!Array.isArray(obj.sections)) throw new Error("Al fitxer hi falten els capítols.");
  const existing = memory.get(obj.id) || await bookStore.get(obj.id);
  if (existing && existing.origin === "bundled") throw new Error("Aquest llibre ja és a la biblioteca.");
  const book = normalizeBook(Object.assign({}, obj, { origin: sourceUrl ? "url" : "local", source: sourceUrl || null, added: Date.now() }));
  delete book.type;
  await saveBook(book);
  return { kind: "book", book };
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
