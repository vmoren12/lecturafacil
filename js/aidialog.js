/* "Prepara’l amb una IA": the teacher chooses how the book should be,
   copies a prompt for an AI assistant, and pastes the JSON it returns. */

import { $, $$, esc, toast, ICON, dialog, copyText, downloadText, slug } from "./ui.js";
import { prefs } from "./store.js";
import { LANGUAGES, lang as langInfo } from "./languages.js";
import { buildPrompt, parseAiAnswer, LEVELS, DEFAULTS } from "./aiprompt.js";
import { importPack } from "./books.js";
import { P, pickFile } from "./reader.js";

const AIS = [
  ["Claude", "https://claude.ai/new"],
  ["ChatGPT", "https://chatgpt.com/"],
  ["Gemini", "https://gemini.google.com/app"]
];

/** Opens the dialog. onBook(id) is called to open a book once it is added. */
export function aiDialog(onBook) {
  const saved = prefs.get("aiPrompt", {});
  const readerLangs = [P.lang, P.lang2].filter(l => l && l !== "none" && l !== "ca");
  const o = Object.assign({}, DEFAULTS, saved, { title: "", author: "" });
  if (!saved.langs) o.langs = readerLangs;
  let lastBook = null;

  const radio = (name, value, title, text) => `<label class="choice">
      <input type="radio" name="${name}" value="${value}" ${o[name] === value ? "checked" : ""}>
      <span><b>${title}</b><small>${text}</small></span></label>`;
  const check = (name, value, label, on) => `<label class="chk"><input type="checkbox" name="${name}" value="${esc(value)}" ${on ? "checked" : ""}> ${label}</label>`;
  const langChoices = [...new Set([...readerLangs, ...o.langs])];

  dialog(`<div class="ai">
    <h2>${ICON.ai} Prepara un llibre amb una IA</h2>
    <p class="muted">Si tens un document que l’app no llegeix bé (un PDF escanejat, un llibre en prosa que vols adaptar…), una IA com Claude, ChatGPT o Gemini el pot convertir en un llibre per a l’app. Fes servir només documents que tinguis permís per adaptar.</p>

    <section class="step"><h3><span class="stepn">1</span> Com el vols?</h3>
      <div class="choices">
        ${radio("mode", "adapt", "Adaptat a lectura fàcil", "La IA simplifica el text en un nivell.")}
        ${radio("mode", "levels", "Adaptat amb nivells", "Diverses versions del mateix llibre. L’alumne tria el nivell.")}
        ${radio("mode", "exact", "Còpia exacta", "El text tal com és, sense canvis. Per a llibres ja adaptats.")}
      </div>
      <div class="opt" data-for="adapt"><span class="lbl">Nivell</span>
        <div class="choices row">
          ${radio("level", "facil", "Fàcil · A2", "Frases curtes, vocabulari freqüent.")}
          ${radio("level", "molt", "Molt fàcil · A1", "Frases molt curtes, en present.")}
        </div></div>
      <div class="opt" data-for="levels"><span class="lbl">Nivells del llibre</span>
        <div class="chks">${Object.entries(LEVELS).map(([id, l]) => check("levels", id, `<b>${l.label}</b> <small>· ${l.hint}</small>`, o.levels.includes(id))).join("")}</div></div>

      <div class="opt"><span class="lbl">Traduccions dins del llibre <small>(opcional; si no, l’app les fa automàticament)</small></span>
        <div class="chks">${langChoices.map(l => check("langs", l, `${esc(langInfo(l).native)} <small>· ${esc(langInfo(l).name)}</small>`, o.langs.includes(l))).join("")}
          <label class="chk add">+ <select name="addLang" aria-label="Afegeix una llengua"><option value="">Afegeix una llengua…</option>${LANGUAGES.filter(l => l.code !== "ca" && !langChoices.includes(l.code)).map(l => `<option value="${l.code}">${esc(l.native)} · ${esc(l.name)}</option>`).join("")}</select></label>
        </div></div>

      <details class="more"><summary>Més opcions</summary>
        <div class="two">
          <label><span>Títol <small>(opcional)</small></span><input name="title" value=""></label>
          <label><span>Autor/a <small>(opcional)</small></span><input name="author" value=""></label>
        </div>
        <label><span>Alumnat <small>(opcional)</small></span><input name="audience" value="${esc(o.audience)}" placeholder="Per exemple: 12-16 anys, nivell A1 de català"></label>
        <span class="lbl">El document és en</span>
        <div class="choices row">
          ${radio("source", "ca", "Català", "No cal traduir-lo.")}
          ${radio("source", "other", "Una altra llengua", "La IA el passarà al català.")}
        </div>
        <div class="chks">
          ${check("keywords", "1", "Paraules clau de cada capítol amb definició fàcil", o.keywords)}
          ${check("glossary", "1", "Conserva el glossari o les notes de vocabulari del document", o.glossary)}
        </div>
        <label>Llibres llargs: la IA respon per parts de
          <select name="parts">${[[3, "3 capítols"], [5, "5 capítols"], [10, "10 capítols"], [0, "tot d’una vegada"]].map(([v, l]) => `<option value="${v}" ${+o.parts === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </details>
    </section>

    <section class="step"><h3><span class="stepn">2</span> Dona el prompt a la IA amb el document</h3>
      <p>Obre la IA, <b>adjunta el document</b> (PDF, Word, EPUB…) i enganxa-hi el prompt.</p>
      <div class="btns">
        <button type="button" class="btn primary" data-ai="copy">${ICON.copy} Copia el prompt</button>
        <button type="button" class="btn" data-ai="save">${ICON.download} Desa’l</button>
        <span class="muted">Obre:</span>${AIS.map(([n, u]) => `<a class="btn" href="${u}" target="_blank" rel="noopener">${n}</a>`).join("")}
      </div>
      <details><summary>Mostra el prompt</summary><textarea id="aiPrompt" rows="12" readonly></textarea></details>
    </section>

    <section class="step"><h3><span class="stepn">3</span> Enganxa la resposta</h3>
      <p>Copia el JSON que t’ha donat la IA i enganxa’l aquí. Si te’l dona per parts, enganxa-les una darrere l’altra: s’ajunten soles.</p>
      <textarea id="aiAnswer" rows="6" placeholder="{ &quot;format&quot;: &quot;lecturafacil&quot;, … }" spellcheck="false"></textarea>
      <div class="btns">
        <button type="button" class="btn primary" data-ai="import">${ICON.plus} Afegeix a la biblioteca</button>
        <button type="button" class="btn" data-ai="file">${ICON.upload} O tria el fitxer .json</button>
      </div>
      <p id="aiStatus" class="ai-status" aria-live="polite"></p>
    </section>

    <div class="dlg-actions"><button type="button" class="btn" data-close>Tanca</button></div>
  </div>`, {
    wide: true,
    onOpen: d => {
      const read = () => {
        const f = new FormData();
        $$("input, select", d).forEach(i => {
          if ((i.type === "radio" || i.type === "checkbox") && !i.checked) return;
          if (i.name) f.append(i.name, i.value);
        });
        o.mode = f.get("mode"); o.level = f.get("level"); o.source = f.get("source");
        o.levels = f.getAll("levels"); o.langs = f.getAll("langs");
        o.keywords = f.has("keywords"); o.glossary = f.has("glossary");
        o.parts = +f.get("parts"); o.title = f.get("title").trim(); o.author = f.get("author").trim(); o.audience = f.get("audience").trim();
        o.langNames = Object.fromEntries(o.langs.map(l => [l, langInfo(l).name]));
        $$(".opt[data-for]", d).forEach(x => { x.hidden = x.dataset.for !== o.mode; });
        $("#aiPrompt", d).value = buildPrompt(o);
        const { title, author, langNames, ...keep } = o;
        prefs.set("aiPrompt", keep);
      };
      read();
      d.addEventListener("change", e => {
        if (e.target.name === "addLang" && e.target.value) {
          const l = e.target.value;
          e.target.closest(".chk").insertAdjacentHTML("beforebegin", check("langs", l, `${esc(langInfo(l).native)} <small>· ${esc(langInfo(l).name)}</small>`, true));
          e.target.querySelector(`option[value="${l}"]`).remove();
          e.target.value = "";
        }
        if (e.target.name === "levels" && !$$('input[name="levels"]:checked', d).length) { e.target.checked = true; toast("Cal almenys un nivell."); }
        read();
      });
      d.addEventListener("input", e => { if (e.target.matches("input[type=text], input:not([type])")) read(); });

      const status = (html, ok) => { const s = $("#aiStatus", d); s.innerHTML = html; s.className = "ai-status " + (ok ? "ok" : "bad"); };
      const add = async text => {
        try {
          const r = await importPack(parseAiAnswer(text), { renameOnConflict: true });
          if (r.kind !== "book") throw new Error("Això és una traducció, no un llibre.");
          lastBook = r.book;
          const n = r.book.sections.filter(s => s.kind === "chapter").length;
          $("#aiAnswer", d).value = "";
          if (r.part) {
            status(`<b>Part ${esc(r.part)} afegida.</b> «${esc(r.book.title)}» ja té ${n} ${n === 1 ? "capítol" : "capítols"}. Demana a la IA la part següent («continua») i enganxa-la aquí, o <button type="button" class="linkb" data-ai="open">obre el llibre</button>.`, true);
          } else {
            toast("Llibre afegit a la biblioteca");
            d.close("done");
            onBook(r.book.id);
          }
        } catch (e) {
          status(`<b>No s’ha pogut afegir.</b> ${esc(e.message)}`, false);
        }
      };
      d.addEventListener("click", async e => {
        const b = e.target.closest("[data-ai]");
        if (!b) return;
        const act = b.dataset.ai;
        if (act === "copy") {
          if (await copyText($("#aiPrompt", d).value)) toast("Prompt copiat. Ara enganxa’l a la IA amb el document adjunt.", 3500);
          else { const t = $("#aiPrompt", d); t.closest("details").open = true; t.select(); toast("Copia’l amb Ctrl+C"); }
        } else if (act === "save") {
          downloadText($("#aiPrompt", d).value, `prompt-lectura-facil${o.title ? "-" + slug(o.title) : ""}.md`, "text/markdown;charset=utf-8");
        } else if (act === "import") {
          add($("#aiAnswer", d).value);
        } else if (act === "file") {
          pickFile(".json,.txt,.md", async f => add(await f.text()));
        } else if (act === "open" && lastBook) {
          d.close("done");
          onBook(lastBook.id);
        }
      });
    }
  });
}
