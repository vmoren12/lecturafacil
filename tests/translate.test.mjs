import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Minimal browser environment: localStorage and a fake Chrome Translator API.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};
globalThis.isSecureContext = true;
const created = [];
globalThis.Translator = {
  availability: async () => "downloadable", // what Chrome answers for every pair before use
  create: async ({ sourceLanguage, targetLanguage }) => {
    created.push(`${sourceLanguage}>${targetLanguage}`);
    return { translate: async t => `[${targetLanguage}] ${t}` };
  }
};

const { translateTexts, BROWSER_LANGS, resolveProvider } = await import("../js/translate.js");
const setProvider = p => localStorage.setItem("lf:translator", JSON.stringify({ provider: p }));

beforeEach(() => { created.length = 0; store.clear(); });

test("Catalan is not a Chrome translator language", () => {
  assert.equal(BROWSER_LANGS.has("ca"), false);
  assert.equal(BROWSER_LANGS.has("ar"), true);
});

test("auto mode never picks Chrome directly for a Catalan source", async () => {
  assert.notEqual(await resolveProvider("ca", "ar"), "browser");
});

test("Chrome translates from an existing English version (pivot)", async () => {
  const pivot = async texts => texts.map(t => ({ lang: "en", text: `EN(${t})` }));
  const out = await translateTexts(["Hola.", "Adéu."], "ca", "ar", { pivot });
  assert.deepEqual(out, ["[ar] EN(Hola.)", "[ar] EN(Adéu.)"]);
  assert.deepEqual(created, ["en>ar"]);
});

test("explicit Chrome mode explains why Catalan cannot be translated without a pivot", async () => {
  setProvider("browser");
  await assert.rejects(translateTexts(["Hola."], "ca", "ar", { pivot: async t => t.map(() => null) }), /no admet el català/);
});

test("a pivot already in the target language is used as it is", async () => {
  setProvider("browser");
  const out = await translateTexts(["Hola."], "ca", "en", { pivot: async () => [{ lang: "en", text: "Hello." }] });
  assert.deepEqual(out, ["Hello."]);
  assert.deepEqual(created, []);
});
