/* Entry point: routing between the library and the reader, adding books,
   translator settings and shared links (?llibre=...&llengua=...). */

import { $, $$, esc, toast, ICON, dialog } from "./ui.js";
import { kv } from "./store.js";
import { listBooks, getBook, buildBook, saveBook, deleteBook, importPack, importFromUrl, translatedLanguages } from "./books.js";
import { importFile, importText, ACCEPT } from "./importers.js";
import { aiDialog } from "./aidialog.js";
import { PROVIDERS, CLAUDE_MODELS, settings, saveSettings, resolveProvider, providerLabel, prepareBrowser } from "./translate.js";
import { lang as langInfo } from "./languages.js";
import { P, savePrefs, openBook, bindReader, setExitHandler, fillLangSelect, pickFile, applyTheme, cycleTheme, closeMenus, langsAll } from "./reader.js";

/* ---------- views ---------- */
function show(view) {
  $("#view-library").hidden = view !== "library";
  $("#view-reader").hidden = view !== "reader";
  closeMenus();
}

let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const m = /^#\/llibre\/([^/]+)(?:\/(\d+))?/.exec(location.hash);
  if (m) {
    try {
      const book = await getBook(decodeURIComponent(m[1]));
      if (seq !== routeSeq) return; // a newer navigation took over
      show("reader");
      document.title = `${book.title} · Lectura fàcil`;
      await openBook(book, { sec: m[2] != null ? +m[2] : null });
      // the chapter in the link only applies when opening; then the saved position rules
      if (m[2] != null) history.replaceState(null, "", "#/llibre/" + m[1]);
      return;
    } catch (e) {
      toast(e.message, 5000);
      history.replaceState(null, "", "#/");
    }
  }
  show("library");
  document.title = "Lectura fàcil · Biblioteca";
  await renderLibrary();
}

const openRoute = id => { location.hash = "#/llibre/" + encodeURIComponent(id); };

/* ---------- library ---------- */
async function renderLibrary() {
  fillLangSelect($("#libLang"), "lang");
  fillLangSelect($("#libLang2"), "lang2");
  const list = $("#bookList");
  list.innerHTML = `<p class="muted">Carregant…</p>`;
  const items = await listBooks();
  items.sort((a, b) => (a.origin === "bundled" ? 0 : 1) - (b.origin === "bundled" ? 0 : 1) || (b.added || 0) - (a.added || 0));
  const cards = [];
  for (const b of items) {
    const pos = await kv.get("pos:" + b.id, null);
    const langs = await translatedLanguages(await getBook(b.id));
    cards.push(`<article class="card">
      <button type="button" class="cover" data-open="${esc(b.id)}" aria-label="Obre ${esc(b.title)}">
        ${b.cover ? `<img src="${esc(b.cover)}" alt="">` : `<span class="ph">${ICON.book}<b>${esc(b.title)}</b></span>`}
      </button>
      <div class="meta">
        <h3><button type="button" class="linkish" data-open="${esc(b.id)}">${esc(b.title)}</button></h3>
        ${b.subtitle ? `<p class="subt">${esc(b.subtitle)}</p>` : ""}
        <p class="muted">${esc(b.author)}${b.chapters ? ` · ${b.chapters} capítols` : ""}</p>
        ${langs.length ? `<p class="langs" title="Traduccions disponibles">${ICON.globe}${langs.map(l => `<span lang="${esc(l)}">${esc(langInfo(l).native)}</span>`).join("")}</p>` : ""}
        <div class="card-actions">
          <button type="button" class="btn primary" data-open="${esc(b.id)}">${pos && (pos.sec || pos.page) ? "Continua llegint" : "Llegeix"}</button>
          ${b.origin !== "bundled" ? `<button type="button" class="ibtn" data-del="${esc(b.id)}" aria-label="Treu de la biblioteca" title="Treu de la biblioteca">${ICON.trash}</button>` : ""}
        </div>
      </div></article>`);
  }
  list.innerHTML = cards.join("") || `<p class="muted">Encara no hi ha cap llibre.</p>`;
}

/* ---------- adding books ---------- */
async function handleFile(file) {
  const status = $("#addStatus");
  status.innerHTML = `Llegint <b>${esc(file.name)}</b>…`;
  try {
    if (/\.json$/i.test(file.name)) {
      const r = await importPack(JSON.parse(await file.text()));
      status.textContent = "";
      if (r.kind === "translation") { P.lang = r.lang; savePrefs(); toast(`Traducció a ${langInfo(r.lang).name.toLowerCase()} carregada`); }
      else toast("Llibre afegit a la biblioteca");
      openRoute(r.book.id);
      return;
    }
    const imp = await importFile(file, msg => { status.textContent = msg; });
    status.textContent = "";
    await review(imp);
  } catch (e) {
    console.error(e);
    status.innerHTML = `<b>No s’ha pogut llegir el fitxer.</b> ${esc(e.message || "")}`;
  }
}

const KIND_LABEL = { chapter: "Capítol", front: "Inici", activities: "Activitats", glossary: "Glossari", back: "Final" };

/** Lets the teacher check what was found before saving the book. */
async function review(imp) {
  const secs = imp.sections;
  const nCh = secs.filter(s => s.kind === "chapter").length;
  const res = await dialog(`<form method="dialog" class="review-form">
    <h2>Revisa el llibre</h2>
    <p>S’han trobat <b>${nCh} capítols</b>${secs.length > nCh ? ` i ${secs.length - nCh} parts més` : ""}${imp.glossary.length ? ` i un glossari de <b>${imp.glossary.length} paraules</b>` : ""}. Desmarca el que no vulguis i corregeix els títols si cal.</p>
    <div class="two">
      <label>Títol<input name="title" required value="${esc(imp.title)}"></label>
      <label>Autor/a<input name="author" value="${esc(imp.author)}"></label>
    </div>
    <div class="review">${secs.map((s, i) => `
      <div class="rv"><input type="checkbox" name="sel" value="${i}" ${s.sel ? "checked" : ""} aria-label="Inclou">
        <span class="rvk">${esc(s.kind === "chapter" ? s.n : KIND_LABEL[s.kind] || "")}</span>
        <span class="rvt"><input name="t${i}" value="${esc(s.title)}" aria-label="Títol"><small>${s.words} paraules · ${esc(firstText(s).slice(0, 90))}…</small></span></div>`).join("")}</div>
    <p class="muted">El llibre es desa només en aquest navegador. Per fer-lo arribar a l’alumnat, després podràs desar-lo com a fitxer o compartir-ne un enllaç.</p>
    <div class="dlg-actions"><button type="button" class="btn" data-close="cancel">Cancel·la</button><button class="btn primary" value="ok">Desa a la biblioteca</button></div>
  </form>`, {
    wide: true,
    onOpen: d => d.querySelector("form").addEventListener("submit", () => {
      const f = new FormData(d.querySelector("form"));
      const sel = new Set(f.getAll("sel").map(Number));
      secs.forEach((s, i) => { s.sel = sel.has(i); s.title = (f.get("t" + i) || s.title).trim(); });
      imp.title = f.get("title").trim(); imp.author = f.get("author").trim();
    })
  });
  if (res !== "ok") return;
  if (!secs.some(s => s.sel)) { toast("No has triat cap capítol."); return; }
  const book = await saveBook(buildBook(imp));
  toast("Llibre afegit a la biblioteca");
  openRoute(book.id);
}
const firstText = s => { const b = s.blocks.find(x => x.type === "p"); return b ? b.s.join(" ").replace(/\n/g, " ") : ""; };

async function pasteDialog() {
  const res = await dialog(`<form method="dialog">
    <h2>Enganxa un text</h2>
    <p>Enganxa un text ja adaptat. Deixa una línia en blanc entre paràgrafs. Per separar capítols, escriu-ne el títol en una línia que comenci per <code>#</code> (per exemple <code># 1 El vell mariner</code>) o per «Capítol 1».</p>
    <div class="two"><label>Títol<input name="title" required></label><label>Autor/a<input name="author"></label></div>
    <label>Text<textarea name="text" rows="14" required lang="ca"></textarea></label>
    <div class="dlg-actions"><button type="button" class="btn" data-close="cancel">Cancel·la</button><button class="btn primary" value="ok">Continua</button></div>
  </form>`, { wide: true, onOpen: d => d.querySelector("form").addEventListener("submit", () => { pasted = Object.fromEntries(new FormData(d.querySelector("form"))); }) });
  if (res !== "ok" || !pasted) return;
  const imp = importText(pasted.text);
  if (!imp.sections.length) { toast("No hi ha text."); return; }
  await review(Object.assign(imp, { title: pasted.title, author: pasted.author }));
  pasted = null;
}
let pasted = null;

async function urlDialog() {
  const res = await dialog(`<form method="dialog">
    <h2>Obre un enllaç</h2>
    <p>Enganxa l’adreça d’un fitxer de llibre o de traducció de Lectura fàcil (<code>.json</code>) publicat a internet.</p>
    <label>Adreça<input name="url" type="url" required placeholder="https://…"></label>
    <div class="dlg-actions"><button type="button" class="btn" data-close="cancel">Cancel·la</button><button class="btn primary" value="ok">Obre</button></div>
  </form>`, { onOpen: d => d.querySelector("form").addEventListener("submit", () => { urlValue = d.querySelector("input").value.trim(); }) });
  if (res === "ok" && urlValue) await openUrl(urlValue);
}
let urlValue = "";

async function openUrl(url, lang) {
  try {
    toast("Obrint l’enllaç…");
    const r = await importFromUrl(url);
    if (lang || r.lang) { P.lang = lang || r.lang; savePrefs(); }
    openRoute(r.book.id);
  } catch (e) { toast(e.message, 5000); }
}

/* ---------- translator settings ---------- */
async function settingsDialog() {
  const s = settings();
  const current = providerLabel(await resolveProvider("ca", P.lang === "none" ? "en" : P.lang));
  const res = await dialog(`<form method="dialog" class="settings">
    <h2>Configura el traductor</h2>
    <p>Les frases es tradueixen automàticament quan l’alumne tria una llengua i es desen en aquest navegador. Ara s’està fent servir: <b>${esc(current)}</b>.</p>
    <label>Servei de traducció<select name="provider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${s.provider === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
    <fieldset><legend>Traductor de Chrome</legend>
      <p class="muted">Tradueix dins l’ordinador, sense enviar el text. Cal Chrome 138 o més nou d’ordinador (no funciona al mòbil). <b>No té català</b>: tradueix a partir de la versió anglesa, castellana o francesa de cada frase quan ja existeix. Cada llengua es baixa el primer cop, i Chrome només ho permet després d’un clic.</p>
      <div class="dlg-actions left"><button type="button" class="btn" id="prepBrowser">Comprova i prepara les meves llengües</button></div>
      <ul class="checklist" id="prepOut" aria-live="polite"></ul></fieldset>
    <fieldset><legend>MyMemory</legend>
      <label>Correu electrònic (opcional, amplia la quota diària gratuïta)<input name="email" type="email" value="${esc(s.email)}" autocomplete="email"></label></fieldset>
    <fieldset><legend>LibreTranslate</legend>
      <div class="two"><label>Adreça del servidor<input name="libreUrl" type="url" placeholder="https://libretranslate.com" value="${esc(s.libreUrl)}"></label>
      <label>Clau API<input name="libreKey" type="password" value="${esc(s.libreKey)}" autocomplete="off"></label></div></fieldset>
    <fieldset><legend>Claude (Anthropic)</legend>
      <p class="muted">La millor qualitat, també per a llengües amb pocs recursos (amazic, wòlof…). Activa les opcions «Explica-m’ho fàcil» i el significat de qualsevol paraula. Cal una clau API de <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a> (servei de pagament).</p>
      <div class="two"><label>Clau API<input name="claudeKey" type="password" value="${esc(s.claudeKey)}" autocomplete="off" placeholder="sk-ant-…"></label>
      <label>Model<select name="claudeModel">${Object.entries(CLAUDE_MODELS).map(([k, v]) => `<option value="${k}" ${s.claudeModel === k ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label></div></fieldset>
    <p class="warn">Les claus es desen només en aquest navegador. No les introdueixis en ordinadors compartits ni en els dispositius de l’alumnat: tradueix el llibre des del teu ordinador i comparteix la traducció.</p>
    <div class="dlg-actions"><button type="button" class="btn" data-close="cancel">Cancel·la</button><button class="btn primary" value="ok">Desa</button></div>
  </form>`, {
    wide: true,
    onOpen: d => {
      d.querySelector("form").addEventListener("submit", () => { formValue = Object.fromEntries(new FormData(d.querySelector("form"))); });
      $("#prepBrowser", d).addEventListener("click", () => {
        const out = $("#prepOut", d);
        out.innerHTML = "";
        const targets = langsAll().length ? langsAll() : ["ar"];
        // called straight from the click: Chrome only downloads languages after a user gesture
        prepareBrowser(targets, (text, ok) => {
          out.insertAdjacentHTML("beforeend", `<li class="${ok === true ? "ok" : ok === false ? "bad" : ""}">${esc(text)}</li>`);
        });
      });
    }
  });
  if (res === "ok" && formValue) {
    saveSettings(Object.assign(s, formValue));
    toast("Configuració desada");
    formValue = null;
    if (!$("#view-reader").hidden) route();
  }
}
let formValue = null;

function helpDialog() {
  dialog(`<h2>Com funciona</h2>
    <h3>Per a l’alumnat</h3>
    <ul>
      <li>Tria la teva llengua i un llibre. Cada frase en català té la traducció al costat.</li>
      <li>Pots triar una <b>2a llengua</b>. A la pàgina de la traducció tries quina vols veure, o les dues (tecla T).</li>
      <li>Clica una paraula per veure què vol dir. Desa-la amb el botó ${ICON.save} per repassar-la a <b>Paraules</b>.</li>
      <li>Escolta una frase amb ${ICON.speak} o tota la pàgina. A <b>Aa</b> pots fer la lletra més gran, la veu més lenta o amagar la traducció per practicar.</li>
    </ul>
    <h3>Per al professorat</h3>
    <ul>
      <li><b>Afegeix un llibre</b> ja adaptat (EPUB, Word, PDF, HTML o text). L’app detecta els capítols, les il·lustracions i el glossari.</li>
      <li>Amb <b>Prepara’l amb una IA</b> obtens un prompt perquè una IA converteixi qualsevol document: còpia exacta, lectura fàcil o diversos nivells.</li>
      <li>La traducció és automàtica. Al menú ${ICON.tools} pots traduir tot el llibre, activar el <b>mode docent</b> per corregir-la i <b>compartir-la</b> amb un fitxer o un enllaç.</li>
      <li>Tot es desa en aquest navegador. Res no surt de l’ordinador si no fas servir un traductor en línia.</li>
    </ul>
    <div class="dlg-actions"><button type="button" class="btn primary" data-close>D’acord</button></div>`, { wide: true });
}

/* ---------- boot ---------- */
async function boot() {
  applyTheme();
  bindReader();
  setExitHandler(() => { location.hash = "#/"; });

  $("#libLang").addEventListener("change", e => { P.lang = e.target.value; savePrefs(); renderLibrary(); });
  $("#libLang2").addEventListener("change", e => { P.lang2 = e.target.value; if (P.lang2 !== "none") P.show = "both"; savePrefs(); });
  $("#bookList").addEventListener("click", async e => {
    const o = e.target.closest("[data-open]");
    if (o) { openRoute(o.dataset.open); return; }
    const d = e.target.closest("[data-del]");
    if (d) {
      const book = await getBook(d.dataset.del);
      const ok = await dialog(`<h2>Treure «${esc(book.title)}»?</h2><p>S’esborraran el llibre i les seves traduccions d’aquest navegador.</p>
        <div class="dlg-actions"><button type="button" class="btn" data-close="cancel">Cancel·la</button><button type="button" class="btn danger" data-close="ok">Treu</button></div>`);
      if (ok === "ok") { await deleteBook(book.id); toast("Llibre tret"); renderLibrary(); }
    }
  });
  $("#addFile").addEventListener("click", () => pickFile(ACCEPT, handleFile));
  $("#addPaste").addEventListener("click", pasteDialog);
  $("#addUrl").addEventListener("click", urlDialog);
  $("#addAi").addEventListener("click", () => aiDialog(openRoute));
  $$(".settingsBtn").forEach(b => b.addEventListener("click", settingsDialog));
  $("#helpBtn").addEventListener("click", helpDialog);
  $$(".themeBtn").forEach(b => b.addEventListener("click", cycleTheme));
  document.addEventListener("lf:settings", settingsDialog);

  const drop = $("#drop");
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  // shared links: ?llibre=<id or URL>&llengua=<code>&capitol=<n>
  const q = new URLSearchParams(location.search);
  const bookParam = q.get("llibre"), langParam = q.get("llengua"), lang2Param = q.get("llengua2");
  if (langParam) P.lang = langParam;
  if (lang2Param) { P.lang2 = lang2Param; P.show = "both"; }
  if (langParam || lang2Param) savePrefs();
  if (bookParam) {
    history.replaceState(null, "", location.pathname + location.hash);
    if (/^https?:\/\//.test(bookParam)) await openUrl(bookParam);
    else history.replaceState(null, "", location.pathname + "#/llibre/" + encodeURIComponent(bookParam) + (q.get("capitol") ? "/" + (+q.get("capitol")) : ""));
  } else if (langParam || lang2Param) history.replaceState(null, "", location.pathname + location.hash);

  addEventListener("hashchange", route);
  await route();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW:", e));
  }
}

boot();
