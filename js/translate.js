/* Automatic translation providers.
   - browser:  on-device Translator API (Chrome 138+). Free, private, offline after download.
   - mymemory: free public service (api.mymemory.translated.net). Daily quota.
   - libre:    a LibreTranslate server (own or hosted) with optional API key.
   - claude:   Claude API with the teacher's own key. Best quality; also explains words.
   Settings live in localStorage of this device only. */

import { prefs } from "./store.js";
import { lang as langInfo } from "./languages.js";

export const PROVIDERS = {
  auto: "Automàtic (el millor disponible)",
  browser: "Traductor del navegador (Chrome, sense enviar res)",
  mymemory: "MyMemory (gratuït, en línia, amb límit diari)",
  libre: "LibreTranslate (servidor propi o de pagament)",
  claude: "Claude (Anthropic, amb clau API pròpia)"
};

export const CLAUDE_MODELS = {
  "claude-opus-5-5": "Claude Opus 5.5 (màxima qualitat)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (equilibrat)",
  "claude-haiku-5-5": "Claude Haiku 5.5 (ràpid i econòmic)"
};

const DEFAULTS = { provider: "auto", email: "", libreUrl: "", libreKey: "", claudeKey: "", claudeModel: "claude-opus-5-5" };
export const settings = () => Object.assign({}, DEFAULTS, prefs.get("translator", {}));
export const saveSettings = s => prefs.set("translator", s);

export class TranslateError extends Error {
  constructor(msg, { quota = false } = {}) { super(msg); this.quota = quota; }
}

/* ---------- browser (Translator API) ---------- */
const translators = new Map();
async function browserAvailability(src, tgt) {
  const T = globalThis.Translator;
  if (!T) return "unavailable";
  try { return await T.availability({ sourceLanguage: src, targetLanguage: tgt }); } catch { return "unavailable"; }
}
/** Creating a translator may download a language model; it gives up after
    20 s without any download progress (e.g. no user gesture, no network). */
async function browserTranslator(src, tgt, onStatus) {
  const key = src + ">" + tgt;
  if (!translators.has(key)) {
    let timer, arm;
    const stall = new Promise((_, reject) => {
      arm = () => { clearTimeout(timer); timer = setTimeout(() => reject(new TranslateError("El traductor del navegador no respon.")), 20000); };
      arm();
    });
    const created = globalThis.Translator.create({
      sourceLanguage: src, targetLanguage: tgt,
      monitor(m) {
        m.addEventListener("downloadprogress", e => {
          arm();
          if (onStatus) onStatus(`Baixant el traductor ${src}→${tgt}: ${Math.round(e.loaded * 100)} %`);
        });
      }
    });
    translators.set(key, Promise.race([created, stall])
      .finally(() => clearTimeout(timer))
      .catch(e => { translators.delete(key); throw e; }));
  }
  return translators.get(key);
}
/** Direct pair, or through English when the direct pair does not exist. */
async function browserRoute(src, tgt) {
  if ((await browserAvailability(src, tgt)) !== "unavailable") return [[src, tgt]];
  if (src !== "en" && tgt !== "en" &&
      (await browserAvailability(src, "en")) !== "unavailable" &&
      (await browserAvailability("en", tgt)) !== "unavailable") return [[src, "en"], ["en", tgt]];
  return null;
}
const browserProvider = {
  async available(src, tgt) { return !!(await browserRoute(src, tgt)); },
  async translate(texts, src, tgt, { onStatus } = {}) {
    const route = await browserRoute(src, tgt);
    if (!route) throw new TranslateError(`El traductor del navegador no té ${langInfo(tgt).name.toLowerCase()}.`);
    const out = [];
    for (const t of texts) {
      let r = t.replace(/\n/g, " ");
      for (const [a, b] of route) r = await (await browserTranslator(a, b, onStatus)).translate(r);
      out.push(r);
    }
    return out;
  }
};

/* ---------- MyMemory ---------- */
const MM_CODE = { zh: "zh-CN", rif: "ber", zgh: "ber" };
const decode = s => { const t = document.createElement("textarea"); t.innerHTML = s; return t.value; };
/** MyMemory accepts up to 500 bytes per request: long sentences go in pieces. */
function chunks(text, max = 450) {
  if (new Blob([text]).size <= max) return [text];
  const out = []; let cur = "";
  for (const part of text.split(/(?<=[,;:])\s+/)) {
    if (cur && new Blob([cur + " " + part]).size > max) { out.push(cur); cur = part; } else cur = cur ? cur + " " + part : part;
  }
  if (cur) out.push(cur);
  return out.flatMap(c => new Blob([c]).size > max ? c.match(/.{1,200}(\s|$)/g) : [c]);
}
async function mmOne(text, src, tgt, signal) {
  const s = settings();
  const parts = [];
  for (const piece of chunks(text)) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(piece)}&langpair=${src}|${MM_CODE[tgt] || tgt}` +
      (s.email ? `&de=${encodeURIComponent(s.email)}` : "");
    const r = await fetch(url, { signal });
    if (r.status === 429) throw new TranslateError("MyMemory: s'ha acabat la quota d'avui.", { quota: true });
    const j = await r.json();
    const t = j.responseData && j.responseData.translatedText || "";
    if (j.quotaFinished || /MYMEMORY WARNING/i.test(t)) throw new TranslateError("MyMemory: s'ha acabat la quota gratuïta d'avui. Afegeix un correu a la configuració per ampliar-la o tria un altre traductor.", { quota: true });
    if (+j.responseStatus !== 200) throw new TranslateError("MyMemory: " + (j.responseDetails || "error"));
    parts.push(decode(t));
  }
  return parts.join(" ");
}
const mymemoryProvider = {
  async available() { return navigator.onLine !== false; },
  async translate(texts, src, tgt, { signal } = {}) {
    const out = new Array(texts.length);
    let next = 0;
    const worker = async () => {
      while (next < texts.length) { const i = next++; out[i] = await mmOne(texts[i].replace(/\n/g, " "), src, tgt, signal); }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }
};

/* ---------- LibreTranslate ---------- */
const libreProvider = {
  async available() { return !!settings().libreUrl; },
  async translate(texts, src, tgt, { signal } = {}) {
    const s = settings();
    if (!s.libreUrl) throw new TranslateError("Configura l'adreça del servidor LibreTranslate.");
    const out = [];
    for (let i = 0; i < texts.length; i += 25) {
      const r = await fetch(s.libreUrl.replace(/\/$/, "") + "/translate", {
        method: "POST", signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: texts.slice(i, i + 25).map(t => t.replace(/\n/g, " ")), source: src, target: tgt, format: "text", api_key: s.libreKey || undefined })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new TranslateError("LibreTranslate: " + (j.error || r.status), { quota: r.status === 429 });
      out.push(...[].concat(j.translatedText));
    }
    return out;
  }
};

/* ---------- Claude ---------- */
// Official SDK, loaded only when this provider is used.
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";
let sdk = null;
async function claudeClient() {
  const s = settings();
  if (!s.claudeKey) throw new TranslateError("Afegeix la clau API de Claude a la configuració del traductor.");
  if (!sdk) sdk = import(SDK_URL).catch(() => { sdk = null; throw new TranslateError("No s'ha pogut carregar la biblioteca de Claude. Comprova la connexió."); });
  const { default: Anthropic } = await sdk;
  return new Anthropic({ apiKey: s.claudeKey, dangerouslyAllowBrowser: true });
}

/** One structured request; returns the parsed JSON object. */
async function claudeJSON(system, payload, schema, { signal, maxTokens = 16000 } = {}) {
  const client = await claudeClient();
  const model = settings().claudeModel;
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
    output_config: { effort: "low", format: { type: "json_schema", schema } }
  };
  // Server-side fallback if the model declines (supported on Opus 5.5 and Sonnet 5.5).
  if (model !== "claude-haiku-5-5") Object.assign(params, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  let msg;
  try {
    msg = await client.beta.messages.create(params, { signal });
  } catch (e) {
    const status = e && e.status;
    if (status === 401) throw new TranslateError("Claude: la clau API no és vàlida.");
    if (status === 429) throw new TranslateError("Claude: massa peticions o límit superat. Torna-ho a provar d'aquí a una estona.", { quota: true });
    if (status === 400) throw new TranslateError("Claude: petició no vàlida (" + (e.message || "400") + ").");
    throw new TranslateError("Claude: " + (e.message || "error de connexió"));
  }
  if (msg.stop_reason === "refusal") throw new TranslateError("Claude no ha volgut traduir aquest fragment.");
  if (msg.stop_reason === "max_tokens") throw new TranslateError("Claude: la resposta era massa llarga.");
  const block = msg.content.find(b => b.type === "text");
  try { return JSON.parse(block ? block.text : ""); } catch { throw new TranslateError("Claude: resposta no vàlida."); }
}

const target = code => { const l = langInfo(code); return `${l.name} / ${l.native} (${code})`; };
const CLAUDE_SYSTEM =
  "You translate sentences from easy-to-read Catalan books for newly arrived students who are learning Catalan. " +
  "Translate each sentence faithfully and simply into the target language, at the same easy reading level, using natural everyday words. " +
  "Keep names of people and places. Keep the line breaks (\\n) of each sentence where natural. " +
  "Return exactly one translation per input sentence, in the same order.";

const claudeProvider = {
  async available() { return !!settings().claudeKey; },
  async translate(texts, src, tgt, { signal } = {}) {
    const out = [];
    for (let i = 0; i < texts.length; i += 50) {
      const part = texts.slice(i, i + 50);
      const r = await claudeJSON(CLAUDE_SYSTEM,
        { source_language: target(src), target_language: target(tgt), sentences: part },
        { type: "object", properties: { translations: { type: "array", items: { type: "string" } } }, required: ["translations"], additionalProperties: false },
        { signal });
      if (!Array.isArray(r.translations) || r.translations.length !== part.length) throw new TranslateError("Claude: el nombre de frases no coincideix.");
      out.push(...r.translations);
    }
    return out;
  }
};

const IMPL = { browser: browserProvider, mymemory: mymemoryProvider, libre: libreProvider, claude: claudeProvider };

const browserFailed = new Set(); // pairs the built-in translator could not handle this session

/** Provider id that will be used for a language pair. */
export async function resolveProvider(src, tgt) {
  const p = settings().provider;
  if (p !== "auto") return p;
  if (await claudeProvider.available()) return "claude";
  if (!browserFailed.has(src + ">" + tgt) && await browserProvider.available(src, tgt)) return "browser";
  if (await libreProvider.available()) return "libre";
  return "mymemory";
}

/** Translates a list of texts. Throws TranslateError. */
export async function translateTexts(texts, src, tgt, opts = {}) {
  if (!texts.length) return [];
  const id = await resolveProvider(src, tgt);
  if (id === "browser" && settings().provider === "auto") {
    try { return await IMPL.browser.translate(texts, src, tgt, opts); }
    catch (e) {
      console.warn("Traductor del navegador:", e);
      browserFailed.add(src + ">" + tgt);
      return translateTexts(texts, src, tgt, opts);
    }
  }
  return IMPL[id].translate(texts, src, tgt, opts);
}

/** Word lookup: translation (and, with Claude, a simple explanation in Catalan). */
export async function translateWord(word, context, src, tgt) {
  const id = await resolveProvider(src, tgt);
  if (id === "claude") {
    const r = await claudeJSON(
      "You help newly arrived students read easy Catalan books. For the given word as used in the sentence, give its dictionary form (lemma), " +
      "its meaning translated into the target language (one to four words), and a very short, simple explanation in Catalan (max 15 words).",
      { word, sentence: context, target_language: target(tgt) },
      { type: "object", properties: { lemma: { type: "string" }, translation: { type: "string" }, explanation_ca: { type: "string" } }, required: ["lemma", "translation", "explanation_ca"], additionalProperties: false },
      { maxTokens: 2000 });
    return { t: r.translation, lemma: r.lemma, d: r.explanation_ca, by: "claude" };
  }
  const [t] = await IMPL[id].translate([word], src, tgt);
  return { t, by: id };
}

/** Claude only: rewrites a sentence more simply and explains it. */
export async function explainSentence(sentence, src, tgt) {
  if (!settings().claudeKey) throw new TranslateError("Aquesta opció necessita una clau de Claude (Configura el traductor).");
  return claudeJSON(
    "You help newly arrived students understand sentences from easy-to-read Catalan books. Rewrite the sentence in very simple Catalan (short words, present tense when possible), " +
    "translate the simple version into the target language, and add one short note in the target language explaining any expression that could be hard.",
    { sentence, target_language: target(tgt) },
    { type: "object", properties: { simple_ca: { type: "string" }, translation: { type: "string" }, note: { type: "string" } }, required: ["simple_ca", "translation", "note"], additionalProperties: false },
    { maxTokens: 4000 });
}

export const providerLabel = id => (PROVIDERS[id] || id).split(" (")[0];
