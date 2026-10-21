/* Persistence.
   - IndexedDB: books added by the teacher, translations, reading progress, saved words.
   - localStorage: small per-device preferences.
   Everything stays in this browser; nothing is sent anywhere. */

const DB_NAME = "lecturafacil";
const DB_VERSION = 1;
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      if (!("indexedDB" in globalThis)) { reject(new Error("IndexedDB no disponible")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "id" });
        if (!d.objectStoreNames.contains("tr")) d.createObjectStore("tr", { keyPath: "key" });
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function run(store, mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("store:", e);
    if (mode === "readwrite") throw e;
    return undefined;
  }
}

export const books = {
  all: () => run("books", "readonly", s => s.getAll()).then(r => r || []),
  get: id => run("books", "readonly", s => s.get(id)),
  put: book => run("books", "readwrite", s => s.put(book)),
  remove: id => run("books", "readwrite", s => s.delete(id))
};

/** Translation record of one book into one language.
    s: automatic translations · m: reviewed (edited by hand or imported)
    w: word translations · keys are sentence hashes (see text.js). */
export const translations = {
  key: (bookId, lang) => `${bookId}|${lang}`,
  async get(bookId, lang) {
    const r = await run("tr", "readonly", s => s.get(this.key(bookId, lang)));
    return Object.assign({ key: this.key(bookId, lang), bookId, lang, s: {}, m: {}, w: {} }, r || {});
  },
  put: rec => run("tr", "readwrite", s => s.put(Object.assign(rec, { updated: Date.now() }))),
  async languages(bookId) {
    const keys = await run("tr", "readonly", s => s.getAllKeys());
    return (keys || []).filter(k => k.startsWith(bookId + "|")).map(k => k.slice(bookId.length + 1));
  },
  async removeBook(bookId) {
    for (const l of await this.languages(bookId)) await run("tr", "readwrite", s => s.delete(this.key(bookId, l)));
  }
};

export const kv = {
  get: (k, d) => run("kv", "readonly", s => s.get(k)).then(v => (v === undefined ? d : v)),
  set: (k, v) => run("kv", "readwrite", s => s.put(v, k)),
  remove: k => run("kv", "readwrite", s => s.delete(k))
};

/** Per-device preferences (font size, language, translator settings...). */
export const prefs = {
  get(k, d) {
    try { const v = localStorage.getItem("lf:" + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem("lf:" + k, JSON.stringify(v)); } catch { /* private mode: keep going */ }
  }
};
