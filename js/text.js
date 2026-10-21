/* Pure text helpers (no DOM): normalising, hashing, sentence splitting and
   turning a flat list of text blocks into book sections.
   Shared by the browser app and the Node tests. */

/** Letters that can form a Catalan word (includes the "l·l" middle dot). */
export const WORD_RE = /([A-Za-zÀ-ÖØ-öø-ÿ·]+)/;

/** Collapses whitespace and unifies apostrophes so equal sentences hash equally. */
export function normalize(s) {
  return String(s).replace(/[’‘`´]/g, "'").replace(/\s+/g, " ").trim();
}

/** Stable 53-bit hash (cyrb53) of a normalised sentence, in base 36.
    Translations are keyed by this hash, so a translation pack works for
    any copy of a book that contains the same sentence. */
export function hashText(str) {
  const s = normalize(str);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* A sentence ends with . ! ? … (optionally followed by closing quotes) and the
   next one starts with a capital, a digit, a dialogue dash or a list marker "b)". */
const SENT_SPLIT = /(?<=[.!?…][»”"'’)\]]*)\s+(?=[—–\-«"“'(¿¡]*\s*[A-ZÀ-ÖØ-Þ0-9]|[a-z]\)\s)/;
const ABBR_END = /\b(?:Sr|Sra|Srta|Dr|Dra|St|Sta|Mr|Mrs|núm|pàg|p|etc)\.$/i;

/** Splits a paragraph into sentences. Line breaks inside a sentence are kept
    (easy-to-read books put one idea on each line). */
export function splitSentences(paragraph) {
  const text = String(paragraph).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
  if (!text) return [];
  const parts = text.split(SENT_SPLIT).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length && ABBR_END.test(out[out.length - 1])) out[out.length - 1] += " " + p;
    else out.push(p);
  }
  return out;
}

/** Number of visual lines of a sentence (used to fill pages evenly). */
export const lineCount = s => String(s).split("\n").length;

/* ---------- chapter detection ---------- */

export const CH_RE = /^(?:(?:cap[ií]tol|cap[ií]tulo|chapter|chapitre|part)\s+([0-9]{1,3}|[ivxlc]{1,7}|[a-zà-ú]+)\.?\s*[.:\-–—]?\s*(.*)|([0-9]{1,3})\s*[.:\-–—)]?\s+(\S.{0,90}))$/i;

const KINDS = [
  [/^(índex|index|índice|sumari|sumario|contents|table of contents|taula de continguts)$/i, "toc"],
  [/^(presentació|presentación|presentation|introducció|introducción|introduction|pròleg|prólogo|prologue|prefaci|prefacio|preface)$/i, "front"],
  [/^(i tu,? com ho veus\??|activitats|actividades|activities|exercicis|ejercicios|exercises|propostes|guia de lectura)$/i, "activities"],
  [/^(glossari|glosario|glossary|vocabulari|vocabulario|vocabulary|notes|notas)$/i, "glossary"],
  [/^(epíleg|epílogo|epilogue|bibliografia|bibliografía|bibliography|apèndix|apéndice|appendix|crèdits|créditos|credits)$/i, "back"]
];
export function kindOf(title) {
  const t = normalize(title).replace(/[.:]$/, "");
  for (const [re, k] of KINDS) if (re.test(t)) return k;
  return null;
}

const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };
const WORD_NUM = { un: 1, u: 1, one: 1, uno: 1, dos: 2, two: 2, tres: 3, three: 3, quatre: 4, cuatro: 4, four: 4, cinc: 5, cinco: 5, five: 5, sis: 6, seis: 6, six: 6, set: 7, siete: 7, seven: 7, vuit: 8, ocho: 8, eight: 8, nou: 9, nueve: 9, nine: 9, deu: 10, diez: 10, ten: 10 };
export function toNum(s) {
  if (s == null) return null;
  if (/^\d+$/.test(s)) return +s;
  if (/^[ivxlc]+$/i.test(s)) {
    let n = 0, max = 0;
    for (const ch of s.toLowerCase().split("").reverse()) { const v = ROMAN[ch]; n += v < max ? -v : v; max = Math.max(max, v); }
    return n;
  }
  return WORD_NUM[s.toLowerCase()] ?? null;
}

const SENTENCE_END = /[.!?…:»”"')]$/;
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };

/** Easy-to-read texts put each phrase on its own short line. When most lines
    are short and do not end a sentence, consecutive lines of one group are
    joined with "\n" (kept) instead of being treated as separate paragraphs. */
export function isLineMode(blocks) {
  const body = blocks.filter(b => b.t && !b.h);
  if (body.length < 8) return false;
  const open = body.filter(b => !SENTENCE_END.test(b.t)).length / body.length;
  return median(body.map(b => b.t.length)) < 75 && open > 0.35;
}

/**
 * Turns flat blocks into sections.
 * @param {Array<{t?:string,h?:number,g?:number,img?:string,alt?:string,kind?:string}>} blocks
 *   t: text · h: heading level (0 = body) · g: group (paragraph container) ·
 *   img: image URL · kind: forced section kind for a synthetic heading
 * @returns {Array<{kind:string,n:number|null,title:string,blocks:Array,words:number,sel:boolean}>}
 */
export function sectionize(blocks) {
  blocks = blocks.filter(b => b.img || (b.t && b.t.trim()));
  const heads = blocks.filter(b => b.h);
  let chLevel = Math.min(...heads.filter(b => CH_RE.test(b.t) || kindOf(b.t)).map(b => b.h));
  if (!isFinite(chLevel)) chLevel = heads.length >= 2 ? Math.min(...heads.map(b => b.h)) : Infinity;
  if (!isFinite(chLevel)) {
    // no usable headings: short lines that look like chapter titles become headings
    blocks.forEach(b => {
      if (b.t && !b.h && b.t.length < 70 && !/[.,;]$/.test(b.t) && (CH_RE.test(b.t) || kindOf(b.t))) b.h = 1;
    });
    chLevel = 1;
  }
  const lineMode = isLineMode(blocks);

  const raw = [];
  let cur = { title: "", head: false, kind: null, items: [] };
  for (const b of blocks) {
    if (b.t && ((b.h && b.h <= chLevel) || b.kind || (b.h && kindOf(b.t)))) {
      raw.push(cur);
      cur = { title: b.t.replace(/\n/g, " "), head: true, kind: b.kind || kindOf(b.t), items: [] };
    } else cur.items.push(b);
  }
  raw.push(cur);

  let seq = 0;
  const out = [];
  for (const s of raw) {
    if (s.kind === "toc") continue;
    let kind = s.kind, n = null, title = s.title;
    const m = s.head && !kind ? CH_RE.exec(s.title) : null;
    if (m) {
      n = toNum(m[1] || m[3]) ?? seq + 1;
      title = (m[2] || m[4] || "").trim();
      seq = n;
      kind = "chapter";
    }
    const items = s.items.slice();
    // a chapter heading made only of a number: the next short line is its title
    if (kind === "chapter" && !title) {
      const i = items.findIndex(b => b.t);
      if (i >= 0 && items[i].t.length < 80 && !/[.!?]$/.test(items[i].t)) title = items.splice(i, 1)[0].t;
    }
    if (!kind) kind = s.head ? "chapter" : "front";
    if (kind === "chapter" && n == null) n = ++seq;
    const sb = buildBlocks(items, lineMode, kind);
    const words = sb.reduce((a, b) => a + (b.s ? b.s.join(" ").split(/\s+/).length : b.t ? b.t.split(/\s+/).length : 0), 0);
    if (!words && !(s.head && sb.length)) continue; // empty, or images only before the first heading
    out.push({ kind, n, title: title || (n ? `Capítol ${n}` : s.title || "Inici"), blocks: sb, words, sel: true });
  }
  // a number that appears twice (e.g. a printed table of contents): keep the longest
  const best = {};
  out.forEach((s, i) => { if (s.kind === "chapter" && (best[s.n] == null || s.words > out[best[s.n]].words)) best[s.n] = i; });
  out.forEach((s, i) => { if (s.kind === "chapter" && best[s.n] !== i) s.sel = false; });
  return out;
}

/** Groups body blocks into paragraphs of sentences, images and sub-headings. */
function buildBlocks(items, lineMode, kind) {
  const out = [];
  let lines = [], g = null;
  const flush = () => {
    if (!lines.length) return;
    const text = lineMode ? lines.join("\n") : lines.join(" ");
    const s = splitSentences(text);
    if (s.length) out.push({ type: "p", s });
    lines = [];
  };
  for (const b of items) {
    if (b.img) { flush(); out.push({ type: "img", src: b.img, alt: b.alt || "" }); continue; }
    const t = b.t.trim();
    if (b.h || (kind === "activities" && /^\d{1,2}[.)]?\s+\S/.test(t) && t.length < 60 && !/[.?!:]$/.test(t))) {
      flush(); out.push({ type: "h", t: t.replace(/\n/g, " ") }); continue;
    }
    if (lineMode) {
      if (g !== b.g) flush();
      g = b.g;
      lines.push(t);
    } else {
      lines.push(t); flush();
    }
  }
  flush();
  return out;
}

/** Plain text / Markdown -> blocks. Blank lines separate paragraphs; "#" marks headings. */
export function textToBlocks(txt) {
  const out = [];
  let g = 0;
  for (const line of String(txt).replace(/\r/g, "").split("\n")) {
    if (!line.trim()) { g++; continue; }
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) { out.push({ t: normalize(m[2]), h: m[1].length, g: ++g }); g++; }
    else out.push({ t: normalize(line), h: 0, g });
  }
  // hard-wrapped prose (e.g. Project Gutenberg): long lines that are not phrases
  if (!isLineMode(out)) {
    const merged = [];
    for (const b of out) {
      const last = merged[merged.length - 1];
      if (last && !b.h && !last.h && last.g === b.g) last.t += " " + b.t;
      else merged.push({ ...b });
    }
    return merged;
  }
  return out;
}

/** Words of a sentence as [text, isWord] pairs. */
export function tokens(text) {
  return String(text).split(WORD_RE).map((part, i) => [part, i % 2 === 1]);
}
