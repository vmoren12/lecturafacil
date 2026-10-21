/* Prompt for an AI assistant (Claude, ChatGPT, Gemini…) that reads a document
   and returns a book in the app's JSON format, and the parser of its answer.
   Pure functions: no DOM, so they can be tested with Node. */

export const LEVELS = {
  original: { label: "Original", hint: "el text del document, sense canvis" },
  facil: { label: "Fàcil", hint: "lectura fàcil, nivell A2" },
  molt: { label: "Molt fàcil", hint: "lectura fàcil, nivell A1" }
};

export const DEFAULTS = {
  mode: "adapt",          // exact | adapt | levels
  level: "facil",         // for "adapt": facil | molt
  levels: ["original", "facil", "molt"], // for "levels"
  source: "ca",           // ca | other (the AI translates the text into Catalan)
  langs: [],              // translations to include, e.g. ["en", "ur"]
  langNames: {},          // code -> name, for the prompt
  keywords: true,         // key words with an easy definition (dict)
  glossary: true,         // keep the document's own glossary
  parts: 5,               // chapters per answer for long books (0 = all at once)
  title: "",
  author: "",
  audience: ""
};

const slugify = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

const LEVEL_RULES = {
  facil: `**Fàcil (A2)**: frases de 10 a 15 paraules com a màxim, una idea per frase. Vocabulari freqüent. Present, passat perifràstic («va arribar») i futur. Pocs connectors i senzills (i, però, perquè, quan, després). Es conserven tots els fets de la història i els diàlegs importants.`,
  molt: `**Molt fàcil (A1)**: frases de 5 a 10 paraules, una sola idea per frase. Vocabulari molt bàsic i concret. Preferentment en present. Sense subordinades. Es poden resumir les parts secundàries, però s’han de mantenir tots els fets clau, en el mateix ordre.`
};

/** Builds the prompt (Catalan, Markdown) from the teacher's choices. */
export function buildPrompt(opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  const levelIds = o.mode === "levels" ? o.levels.filter(l => LEVELS[l]) : [];
  const useLevels = o.mode === "levels" && levelIds.length > 0;
  const adapting = o.mode === "adapt" || (useLevels && levelIds.some(l => l !== "original"));
  const langs = o.langs.filter(Boolean);
  const langList = langs.map(l => `${l} (${o.langNames[l] || l})`).join(", ");
  const id = slugify(o.title) || "titol-del-llibre";
  const L = [];

  L.push(`# Encàrrec: convertir un document en un llibre per a l’app «Lectura fàcil»`);
  L.push(``);
  L.push(`Actua com a editor especialitzat en **lectura fàcil** (pautes de l’IFLA i de l’Associació Lectura Fàcil) i en materials per a **alumnat nouvingut que aprèn català**${o.audience ? ` (${o.audience})` : ""}.`);
  L.push(``);
  L.push(`T’adjunto un document. Llegeix-lo **sencer** i converteix-lo en un fitxer JSON que segueixi **exactament** l’esquema d’aquest encàrrec. L’app el carregarà directament, així que el format ha de ser perfecte.`);
  if (o.title || o.author) {
    L.push(``);
    L.push(`Dades del llibre: ${[o.title && `títol «${o.title}»`, o.author && `autor/a: ${o.author}`].filter(Boolean).join(", ")}.`);
  }

  // ---------- task
  L.push(``, `## 1. Què has de fer`, ``);
  if (o.source === "other") L.push(`- El document **no és en català**: primer passa’l a un català correcte i natural, i després aplica-hi el que es demana a continuació.`);
  if (o.mode === "exact") {
    L.push(`- **Còpia exacta.** Copia el text tal com és${o.source === "other" ? " (en la traducció catalana)" : ""}: no resumeixis, no simplifiquis, no canviïs ni afegeixis cap paraula.`);
    L.push(`- Només pots arreglar errors de digitalització: guionets de partició de mots, salts de línia trencats, números de pàgina i capçaleres o peus de pàgina repetits.`);
    L.push(`- Si el document ja és de lectura fàcil, **conserva els salts de línia** originals (cada línia, un grup de sentit).`);
  } else if (o.mode === "adapt") {
    L.push(`- **Adaptació a lectura fàcil en un sol nivell:** ${LEVEL_RULES[o.level]}`);
  } else {
    L.push(`- **Adaptació en ${levelIds.length} nivells.** Fes una versió completa del text per a cada nivell, amb els mateixos capítols i en el mateix ordre:`);
    for (const l of levelIds) {
      L.push(`  - \`${l}\` → ${l === "original" ? `**Original**: el text del document${o.source === "other" ? " traduït al català" : ""}, sense resumir ni simplificar.` : LEVEL_RULES[l]}`);
    }
  }

  if (adapting) {
    L.push(``, `### Pautes de lectura fàcil`, ``);
    L.push(`- Ordre natural: subjecte + verb + complements. Veu activa.`);
    L.push(`- Una idea per frase. Evita les subordinades llargues, el subjuntiu i les frases fetes.`);
    L.push(`- Sense metàfores ni ironies. Si una expressió figurada és important, explica-la amb paraules senzilles.`);
    L.push(`- Anomena els personatges sempre igual. Repetir el nom és millor que fer servir pronoms que confonguin.`);
    L.push(`- Diàlegs amb guió (—) i dient sempre qui parla.`);
    L.push(`- Números amb xifres. Dates i hores clares.`);
    L.push(`- No hi afegeixis opinions ni fets nous. No eliminis cap fet important de la història.`);
    L.push(`- Respecta la normativa del català (IEC).`);
  }

  // ---------- structure
  L.push(``, `## 2. Estructura del llibre`, ``);
  L.push(`- Divideix el llibre en **seccions** (\`sections\`), en l’ordre del document. Camp \`kind\`:`);
  L.push(`  - \`"front"\`: presentació, pròleg o introducció.`);
  L.push(`  - \`"chapter"\`: cada capítol, amb el número a \`n\` (1, 2, 3…) i el títol a \`title\` **sense** el número.`);
  L.push(`  - \`"activities"\`: activitats o preguntes.`);
  L.push(`  - \`"back"\`: epíleg, apèndixs, bibliografia i crèdits (autoria, il·lustracions, editorial). Conserva sempre els crèdits.`);
  L.push(`  - No incloguis l’índex.`);
  L.push(`- Dins de cada secció, el text va en **blocs**:`);
  L.push(`  - Paràgraf: \`{ "type": "p", "s": [ …frases… ] }\`. Cada element de \`s\` és **una sola frase** (acaba amb . ! ? o …).`);
  L.push(`  - Subtítol dins d’una secció: \`{ "type": "h", "t": "…" }\`.`);
  L.push(`- **Salts de línia:** en lectura fàcil cada línia és un grup de sentit. Quan una frase ocupi més d’una línia, separa-les amb \`\\n\` en un punt natural (mai entre l’article i el nom, ni entre el verb i el complement curt). Les frases curtes van en una sola línia.`);
  L.push(`- Les il·lustracions no es poden incloure: no les descriguis dins del text.`);
  if (useLevels) L.push(`- Com que hi ha nivells, cada secció no té \`blocks\` sinó \`levels\`: un objecte amb una llista de blocs per a cada nivell (${levelIds.map(l => `\`${l}\``).join(", ")}). El títol de la secció és el mateix per a tots els nivells.`);

  // ---------- translations
  if (langs.length) {
    L.push(``, `## 3. Traduccions`, ``);
    L.push(`Afegeix la traducció a: **${langList}**. Tradueix cada frase, cada títol i cada subtítol de manera fidel i natural, **amb la mateixa facilitat** que el text català. Conserva els noms propis.`);
    L.push(`- Frase amb traducció: \`{ "t": "Frase en català.", "tr": { ${langs.map(l => `"${l}": "…"`).join(", ")} } }\` en lloc de la frase sola.`);
    L.push(`- Títol de secció: afegeix \`"titleTr": { ${langs.map(l => `"${l}": "…"`).join(", ")} }\`.`);
    L.push(`- Subtítol: \`{ "type": "h", "t": "…", "tr": { … } }\`.`);
    L.push(`- Si una frase té \`\\n\`, la traducció també pot tenir-ne.`);
  }

  // ---------- words
  let sec = langs.length ? 4 : 3;
  if (o.keywords || o.glossary) L.push(``, `## ${sec++}. Vocabulari`, ``);
  if (o.keywords) {
    L.push(`- **Paraules clau** (\`dict\`): per a cada capítol, tria de 3 a 8 paraules importants o difícils per a un alumne que aprèn català. Per a cadascuna:`);
    L.push(`  - la clau és la forma de diccionari (\`"illa"\`, \`"amagar"\`);`);
    L.push(`  - \`p\`: categoria (\`"nom m."\`, \`"nom f."\`, \`"verb"\`, \`"adj."\`, \`"adv."\`);`);
    L.push(`  - \`d\`: definició molt fàcil en català (màxim 15 paraules, sense fer servir la mateixa paraula);`);
    L.push(`  - \`f\`: **totes les formes tal com apareixen al text**, en minúscules (\`["illa", "illes"]\`, \`["amaga", "amagarem"]\`);`);
    L.push(`  - \`k\`: \`1\`${langs.length ? `;` : "."}`);
    if (langs.length) L.push(`  - una traducció curta per a cada llengua (${langs.map(l => `\`"${l}"\``).join(", ")}).`);
    L.push(`  - No repeteixis una paraula que ja hi sigui.`);
  }
  if (o.glossary) {
    L.push(`- **Glossari** (\`glossary\`): si el document té glossari, notes de vocabulari o notes al peu que expliquen paraules, posa-les aquí i **no** com a secció: \`{ "term": "…", "def": "…", "forms": ["formes del text"] }\`. Si no en té, deixa la llista buida.`);
  }

  // ---------- schema
  L.push(``, `## ${sec++}. Esquema del JSON`, ``);
  L.push(`Fes servir exactament aquests camps (aquí, un exemple reduït):`, ``);
  L.push("```json");
  L.push(JSON.stringify(exampleBook(o, { id, useLevels, levelIds, langs }), null, 2));
  L.push("```");
  L.push(``);
  L.push(`- \`id\`: identificador en minúscules, sense espais ni accents (per exemple \`"${id}"\`).`);
  L.push(`- \`lang\`: sempre \`"ca"\`.`);

  // ---------- long books
  if (o.parts > 0) {
    L.push(``, `## ${sec++}. Llibres llargs`, ``);
    L.push(`Si el llibre no hi cap en una sola resposta, **divideix-lo en parts de ${o.parts} capítols com a màxim**:`);
    L.push(`- Cada part ha de ser un JSON **complet i vàlid**, amb el mateix \`id\`, \`title\`, \`author\`${useLevels ? ", `levels`" : ""} i el camp \`"part": 1\`, \`2\`, \`3\`…`);
    L.push(`- Cada part només conté les seccions que li toquen. El \`dict\` i el \`glossary\` de cada part, només amb les paraules noves.`);
    L.push(`- Després del bloc JSON, escriu només: «Part X de Y. Escriu *continua* per a la part següent.»`);
    L.push(`- No tallis mai una secció entre dues parts.`);
  }

  // ---------- output
  L.push(``, `## ${sec++}. Format de la resposta`, ``);
  L.push(`- Respon **només** amb el JSON dins d’un bloc \`\`\`json, sense explicacions abans${o.parts > 0 ? " (només la línia de continuació després, si cal)" : " ni després"}.`);
  L.push(`- JSON vàlid: cometes dobles, sense comes al final de les llistes, sense comentaris.`);
  L.push(`- Dins del text, fes servir cometes catalanes « » o tipogràfiques “ ”, o escapa les dobles (\\").`);
  L.push(`- No inventis contingut. Si un fragment del document no es pot llegir, posa’l entre claudàtors: [il·legible].`);

  L.push(``, `## ${sec}. Comprovació final`, ``);
  L.push(`Abans de respondre, comprova que:`);
  L.push(`- hi ha totes les seccions del document${o.parts > 0 ? " (o de la part)" : ""}, en ordre, i cap capítol no s’ha resumit${o.mode === "exact" ? " ni modificat" : " més del que demana el nivell"};`);
  L.push(`- cada element de \`s\` és una sola frase;`);
  if (langs.length) L.push(`- totes les frases, títols i subtítols tenen traducció a ${langs.join(", ")};`);
  if (o.keywords) L.push(`- totes les formes de \`f\` apareixen realment al text;`);
  L.push(`- el JSON és vàlid i comença per \`{\` i acaba per \`}\`.`);
  return L.join("\n");
}

function exampleBook(o, { id, useLevels, levelIds, langs }) {
  const tr = (ca, en) => langs.length ? { t: ca, tr: Object.fromEntries(langs.map(l => [l, l === "en" ? en : "…"])) } : ca;
  const titleTr = en => langs.length ? { titleTr: Object.fromEntries(langs.map(l => [l, l === "en" ? en : "…"])) } : {};
  const para = (lv = "facil") => lv === "molt"
    ? [{ type: "p", s: [tr("Un dia arriba un mariner.", "One day a sailor arrives."), tr("Porta un bagul gran.", "He carries a big chest.")] }]
    : [{ type: "p", s: [tr("Un dia, un vell mariner\nva arribar a la posada.", "One day, an old sailor\narrived at the inn."), tr("Portava un bagul gran i pesat.", "He carried a big, heavy chest.")] }];
  const chapter = Object.assign({ kind: "chapter", n: 1, title: "El vell mariner" }, titleTr("The old sailor"),
    useLevels ? { levels: Object.fromEntries(levelIds.map(l => [l, para(l)])) } : { blocks: para(o.mode === "adapt" ? o.level : "facil") });
  const book = {
    format: "lecturafacil", version: 1, type: "book",
    id, title: o.title || "Títol del llibre", author: o.author || "Autor o autora", lang: "ca"
  };
  if (o.parts > 0) book.part = 1;
  if (useLevels) book.levels = levelIds.map(l => ({ id: l, label: LEVELS[l].label }));
  book.credits = ["Adaptació: …", "Il·lustracions: …"];
  book.sections = [
    Object.assign({ kind: "front", title: "Presentació" }, useLevels ? { levels: Object.fromEntries(levelIds.map(l => [l, [{ type: "p", s: [tr("Aquesta és la història d’un tresor.", "This is the story of a treasure.")] }]])) } : { blocks: [{ type: "p", s: [tr("Aquesta és la història d’un tresor.", "This is the story of a treasure.")] }] }),
    chapter
  ];
  if (o.glossary) book.glossary = [{ term: "posada", def: "Casa on els viatgers menjaven i dormien.", forms: ["posada", "posades"] }];
  if (o.keywords) book.dict = { bagul: Object.assign({ p: "nom m.", d: "Caixa gran per guardar roba i coses.", f: ["bagul", "baguls"], k: 1 }, Object.fromEntries(langs.map(l => [l, l === "en" ? "chest" : "…"]))) };
  return book;
}

/** Finds and parses the JSON in an AI answer (code fences, text around it…).
    Throws an Error with a message the teacher can act on. */
export function parseAiAnswer(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Enganxa primer la resposta de la IA.");
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1].trim()).filter(s => s.startsWith("{"));
  let candidate = fenced.length ? fenced.sort((a, b) => b.length - a.length)[0] : null;
  if (!candidate) {
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    if (a < 0) throw new Error("A la resposta no hi ha cap JSON. Torna-ho a demanar a la IA.");
    if (b < a) throw new Error("La resposta està tallada (no acaba amb «}»). Demana a la IA que continuï o que ho faci per parts.");
    candidate = raw.slice(a, b + 1);
  }
  try {
    return JSON.parse(candidate);
  } catch (e) {
    // the usual slip: commas before ] or }
    try { return JSON.parse(candidate.replace(/,\s*([\]}])/g, "$1")); } catch { /* fall through */ }
    if (!/}\s*$/.test(candidate)) throw new Error("La resposta està tallada. Demana a la IA que continuï o que ho faci per parts més petites.");
    throw new Error("El JSON no és vàlid (" + e.message + "). Demana a la IA que el revisi i el torni a enviar.");
  }
}
