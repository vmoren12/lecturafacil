/* Reads book files in the browser: EPUB, DOCX, PDF, HTML, TXT/Markdown.
   Result: { title, author, cover, sections, glossary } (sections from text.js).
   EPUB glossaries made of links (word -> note) become the book glossary. */

import { sectionize, textToBlocks, normalize } from "./text.js";

const LIB = {
  jszip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
};
const loading = {};
function loadScript(src) {
  return loading[src] = loading[src] || new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve;
    s.onerror = () => { delete loading[src]; reject(new Error("No s'ha pogut carregar el lector de fitxers. Comprova la connexió.")); };
    document.head.appendChild(s);
  });
}

export const ACCEPT = ".epub,.docx,.pdf,.txt,.md,.htm,.html,.xhtml,.json";

/** @param {File|Blob} file  @param {(msg:string)=>void} [onStatus] */
export async function importFile(file, onStatus = () => {}) {
  const name = file.name || "llibre";
  const ext = (name.split(".").pop() || "").toLowerCase();
  const base = { title: name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " "), author: "" };
  let res;
  if (ext === "epub") res = await readEpub(await file.arrayBuffer(), onStatus);
  else if (ext === "docx") res = await readDocx(await file.arrayBuffer());
  else if (ext === "pdf") res = await readPdf(await file.arrayBuffer(), onStatus);
  else if (/^x?html?$/.test(ext)) res = readHtml(await file.text());
  else if (ext === "txt" || ext === "md") res = { blocks: textToBlocks(await file.text()) };
  else if (ext === "doc") throw new Error("Els fitxers .doc antics no es poden llegir. Obre'l amb Word i desa'l com a .docx.");
  else throw new Error("Aquest tipus de fitxer no es pot llegir. Fes servir EPUB, DOCX, PDF, HTML o TXT.");
  if (!res.blocks.some(b => b.t)) throw new Error(ext === "pdf" ? "Aquest PDF no té text (potser és escanejat com a imatge)." : "No s'ha trobat text al fitxer.");
  const sections = sectionize(res.blocks);
  return { ...base, ...pick(res, ["title", "author", "cover", "lang"]), sections, glossary: res.glossary || [] };
}

/** Text pasted by the teacher. */
export function importText(text) {
  return { sections: sectionize(textToBlocks(text)), glossary: [] };
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k]).map(k => [k, o[k]]));

/* ---------- HTML -> blocks ---------- */
const BLOCK = new Set(["p", "div", "section", "article", "blockquote", "li", "ul", "ol", "dl", "dd", "dt", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "header", "footer", "main", "figure", "figcaption", "table", "tbody", "thead", "tr", "td", "th", "body", "center"]);
const SKIP = new Set(["script", "style", "nav", "aside", "sup", "head", "title", "noscript", "template"]);
const BR = ""; // placeholder for <br> so source-code newlines are not mistaken for line breaks

const clean = s => s.replace(/­/g, "").replace(/\s+/g, " ").replace(/ ? ?/g, "\n").replace(/\n{2,}/g, "\n").trim();

/**
 * Walks an HTML document in reading order.
 * @param {Document} doc
 * @param {{ img?: (el:Element)=>string|null, skip?: (el:Element)=>boolean, g?: {n:number} }} opt
 */
export function htmlToBlocks(doc, opt = {}) {
  const out = [];
  const g = opt.g || { n: 0 };
  let buf = "", level = 0;
  const flush = () => { const t = clean(buf); if (t) out.push({ t, h: level, g: g.n }); buf = ""; };
  const hasBlockChild = el => [...el.children].some(c => BLOCK.has(c.localName.toLowerCase()));
  const visit = el => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { buf += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.localName.toLowerCase();
      if (SKIP.has(tag) || (opt.skip && opt.skip(n)) || n.getAttribute("epub:type") === "footnote" || n.getAttribute("role") === "doc-footnote") continue;
      if (tag === "br") { buf += BR; continue; }
      if (tag === "img" || tag === "image") {
        const src = opt.img && opt.img(n);
        if (src) { flush(); out.push({ img: src, alt: n.getAttribute("alt") || "", g: g.n }); }
        continue;
      }
      if (BLOCK.has(tag)) {
        flush();
        const hm = /^h([1-6])$/.exec(tag);
        if (hasBlockChild(n)) { g.n++; visit(n); flush(); g.n++; }
        else { const prev = level; level = hm ? +hm[1] : 0; visit(n); flush(); level = prev; }
        continue;
      }
      visit(n);
    }
  };
  visit(doc.body || doc.documentElement);
  flush();
  return out;
}

function parseHtml(markup, xml) {
  let doc = new DOMParser().parseFromString(markup, xml ? "application/xhtml+xml" : "text/html");
  if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(markup, "text/html");
  return doc;
}

function readHtml(markup) {
  const doc = parseHtml(markup, false);
  const notes = collectNotes([{ path: "", doc }]);
  return {
    title: (doc.querySelector("title") || {}).textContent || "",
    blocks: htmlToBlocks(doc, { skip: el => notes.targets.has(el), img: el => /^(https?:|data:)/.test(el.getAttribute("src") || "") ? el.getAttribute("src") : null }),
    glossary: notes.glossary
  };
}

/* ---------- glossary / notes made of links ---------- */
const resolvePath = (from, href) => {
  const parts = (from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) + href : href).split("/");
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); }
  return out.join("/");
};

/** Finds short in-text links (word -> definition elsewhere). The target
    paragraphs are removed from the reading flow and become glossary entries. */
function collectNotes(docs) {
  const byPath = new Map(docs.map(d => [d.path, d.doc]));
  const order = new Map(docs.map((d, i) => [d.doc, i]));
  const entries = new Map(); // definition -> entry
  const targets = new Set();
  for (const { path, doc } of docs) {
    for (const a of doc.querySelectorAll("a[href*='#']")) {
      const href = a.getAttribute("href");
      const [file, id] = href.split("#");
      const tdoc = file ? byPath.get(resolvePath(path, decodeURIComponent(file))) : doc;
      if (!tdoc || !id) continue;
      const word = normalize(a.textContent);
      if (!word || word.length > 40) continue;
      const srcBlock = a.closest("p, li, h1, h2, h3, h4, h5, h6, td, dd, div");
      if (srcBlock && normalize(srcBlock.textContent) === word) continue; // a table of contents line
      const target = tdoc.getElementById(id) || tdoc.querySelector(`[name="${CSS.escape(id)}"]`);
      if (!target) continue;
      // notes come after the text that cites them; a link backwards is the note's return link
      if (order.get(tdoc) < order.get(doc) || (tdoc === doc && target.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const block = target.closest("p, li, dd, aside, td, div");
      if (!block || /^h[1-6]$/i.test(target.localName) || block.closest("h1, h2, h3, h4, h5, h6")) continue;
      const def = normalize(block.textContent).replace(/^\[?\d+\]?[.)]?\s*/, "");
      if (!def || def.length > 700) continue;
      targets.add(block);
      const back = [...block.querySelectorAll("a")].map(x => normalize(x.textContent)).find(t => t && t.length <= 40 && !/^\d+$/.test(t));
      const isNum = /^\[?\d+\]?$/.test(word);
      let e = entries.get(def);
      if (!e) entries.set(def, e = { term: (back || (isNum ? "" : word)).toLowerCase(), def, forms: [] });
      if (!isNum && !e.forms.includes(word.toLowerCase())) e.forms.push(word.toLowerCase());
    }
  }
  const glossary = [...entries.values()].filter(e => e.term).map((e, i) => ({ id: "g" + i, ...e }));
  glossary.sort((a, b) => a.term.localeCompare(b.term, "ca"));
  return { targets, glossary };
}

/* ---------- EPUB ---------- */
async function readEpub(buf, onStatus) {
  if (!window.JSZip) await loadScript(LIB.jszip);
  const zip = await window.JSZip.loadAsync(buf);
  const container = await zip.file("META-INF/container.xml").async("string");
  const opfPath = /full-path="([^"]+)"/.exec(container)[1];
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async("string"), "application/xml");
  const meta = tag => { const el = opf.getElementsByTagName("dc:" + tag)[0]; return el ? normalize(el.textContent) : ""; };
  const items = {};
  for (const i of opf.getElementsByTagName("item")) items[i.getAttribute("id")] = { href: resolvePath(opfPath, i.getAttribute("href")), type: i.getAttribute("media-type"), props: i.getAttribute("properties") || "" };
  const file = p => zip.file(p) || zip.file(decodeURIComponent(p));

  // images are embedded as data URLs so the book is self-contained
  const images = new Map();
  const dataUrl = async path => {
    if (!images.has(path)) {
      const f = file(path);
      images.set(path, f ? f.async("base64").then(b => `data:${mime(path)};base64,${b}`) : Promise.resolve(null));
    }
    return images.get(path);
  };

  const docs = [];
  const spine = [...opf.getElementsByTagName("itemref")];
  for (const [i, ref] of spine.entries()) {
    const it = items[ref.getAttribute("idref")];
    if (!it || !/x?html/.test(it.type || "html")) continue;
    const f = file(it.href); if (!f) continue;
    onStatus(`Llegint l'EPUB: ${i + 1} de ${spine.length}…`);
    docs.push({ path: it.href, doc: parseHtml(await f.async("string"), true) });
  }
  const notes = collectNotes(docs);
  const blocks = [];
  const g = { n: 0 };
  for (const { path, doc } of docs) {
    const pending = [];
    const docBlocks = htmlToBlocks(doc, {
      g,
      skip: el => notes.targets.has(el),
      img: el => {
        const src = el.getAttribute("src") || el.getAttribute("xlink:href") || el.getAttribute("href");
        if (!src) return null;
        const p = resolvePath(path, src);
        const key = "epub:" + p;
        pending.push([key, p]);
        return key;
      }
    });
    for (const [key, p] of pending) {
      const url = await dataUrl(p);
      docBlocks.forEach(b => { if (b.img === key) b.img = url; });
    }
    // colophon pages (©, ISBN) without a heading become a "Crèdits" section
    const text = docBlocks.map(b => b.t || "").join(" ");
    if (!docBlocks.some(b => b.h) && /©|\bISBN\b|Dipòsit legal|Depósito legal/i.test(text)) blocks.push({ t: "Crèdits", h: 1, kind: "back", g: ++g.n });
    blocks.push(...docBlocks.filter(b => b.t || b.img));
    g.n++;
  }
  // cover
  let cover = null;
  const coverId = (opf.querySelector("meta[name='cover']") || { getAttribute: () => null }).getAttribute("content");
  const coverItem = Object.values(items).find(i => /cover-image/.test(i.props)) || (coverId && items[coverId]);
  if (coverItem && /^image\//.test(coverItem.type || "")) cover = await dataUrl(coverItem.href);
  return { title: meta("title"), author: meta("creator"), lang: (meta("language") || "").slice(0, 2), cover, blocks, glossary: notes.glossary };
}

const mime = p => ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp" }[(p.split(".").pop() || "").toLowerCase()] || "application/octet-stream");

/* ---------- DOCX ---------- */
async function readDocx(buf) {
  if (!window.JSZip) await loadScript(LIB.jszip);
  const zip = await window.JSZip.loadAsync(buf);
  const xml = new DOMParser().parseFromString(await zip.file("word/document.xml").async("string"), "application/xml");
  const out = [];
  let g = 0;
  for (const p of xml.getElementsByTagName("w:p")) {
    let t = "";
    for (const n of p.getElementsByTagName("*")) {
      if (n.tagName === "w:t") t += n.textContent;
      else if (n.tagName === "w:tab") t += " ";
      else if (n.tagName === "w:br") t += BR;
    }
    t = clean(t);
    if (!t) { g++; continue; } // an empty paragraph separates groups of lines
    const st = p.getElementsByTagName("w:pStyle")[0];
    const sv = st ? st.getAttribute("w:val") || "" : "";
    let h = 0;
    if (/heading|ttol|titol|t[ií]tulo|title|encabezado/i.test(sv)) h = +((/\d/.exec(sv) || [1])[0]) || 1;
    out.push({ t, h, g: h ? ++g : g });
    if (h) g++;
  }
  let title = "", author = "";
  const core = zip.file("docProps/core.xml");
  if (core) {
    const c = new DOMParser().parseFromString(await core.async("string"), "application/xml");
    title = (c.getElementsByTagName("dc:title")[0] || {}).textContent || "";
    author = (c.getElementsByTagName("dc:creator")[0] || {}).textContent || "";
  }
  return { title, author, blocks: out };
}

/* ---------- PDF ---------- */
async function readPdf(buf, onStatus) {
  if (!window.pdfjsLib) { await loadScript(LIB.pdfWorker); await loadScript(LIB.pdf); }
  const lib = window.pdfjsLib || window["pdfjs-dist/build/pdf"];
  lib.GlobalWorkerOptions.workerSrc = LIB.pdfWorker;
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    const lines = [];
    let cur = "", size = 0, y = null, lastY = null;
    const push = () => { const t = clean(cur); if (t) lines.push({ t, size, y }); cur = ""; size = 0; };
    for (const it of tc.items) {
      const iy = it.transform ? it.transform[5] : null;
      if (lastY != null && iy != null && Math.abs(iy - lastY) > 2 && cur) push();
      if (!cur) y = iy;
      cur += it.str;
      size = Math.max(size, Math.abs(it.transform ? it.transform[3] : 0));
      lastY = iy;
      if (it.hasEOL) push();
    }
    push();
    pages.push(lines);
    onStatus(`Llegint el PDF: pàgina ${i} de ${pdf.numPages}…`);
  }
  // remove running headers/footers and page numbers
  const freq = {};
  pages.forEach(ls => new Set(ls.map(l => l.t.replace(/\d+/g, "#"))).forEach(k => { freq[k] = (freq[k] || 0) + 1; }));
  const sizes = pages.flat().map(l => l.size).filter(Boolean).sort((a, b) => a - b);
  const med = sizes[Math.floor(sizes.length / 2)] || 0;
  const out = [];
  let g = 0;
  for (const ls of pages) {
    const kept = ls.filter(l => !/^\d{1,4}$/.test(l.t) && !(pages.length >= 3 && freq[l.t.replace(/\d+/g, "#")] > Math.max(1, pages.length / 3)));
    const gaps = kept.slice(1).map((l, i) => Math.abs(kept[i].y - l.y)).filter(Boolean).sort((a, b) => a - b);
    const lineGap = gaps[Math.floor(gaps.length / 2)] || 0;
    kept.forEach((l, i) => {
      if (i && lineGap && Math.abs(kept[i - 1].y - l.y) > lineGap * 1.5) g++; // a blank line: new paragraph
      const h = med && l.size > med * 1.25 && l.t.length < 90 ? 1 : 0;
      out.push({ t: l.t, h, g: h ? ++g : g });
      if (h) g++;
    });
    g++;
  }
  return { blocks: out };
}
