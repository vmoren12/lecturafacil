# Lectura fàcil

Eina de lectura per a alumnat nouvingut: llibres de **lectura fàcil en català** amb la **traducció a la llengua de cada alumne** frase a frase, diccionari de paraules, veu i paraules desades.

**Obre l’aplicació:** https://vmoren12.github.io/lecturafacil/

El professorat hi puja un text que ja ha adaptat (EPUB, Word, PDF, HTML o text). L’aplicació el divideix en capítols i frases i el tradueix automàticament a la llengua que triï l’alumne. La traducció es pot revisar, corregir i compartir.

## Què pot fer

### Alumnat

- **Llibre obert:** cada frase en català té la traducció al costat (o a sota, al mòbil). En passar el ratolí o tocar una frase, es marquen l’original i la traducció.
- **Més de 35 llengües:** àrab, amazic, urdú, panjabi, bengalí, xinès, romanès, ucraïnès, anglès, francès… amb la tipografia adequada i escriptura de dreta a esquerra quan cal.
- **Què vol dir aquesta paraula?** Clica qualsevol paraula: es mostra la definició del glossari del llibre (si en té) i la traducció. Les paraules del glossari surten subratllades.
- **Les meves paraules:** desa paraules per repassar-les. Al final de cada capítol hi ha la llista de paraules importants.
- **Escolta:** una frase, o tota la pàgina en català (i, si es vol, també la traducció). Veu lenta opcional.
- **Adaptació personal (Aa):** mida de la lletra, espai entre línies, vista per pàgines o capítol sencer, traducció al costat o a sota, mode concentració, colors clars o foscos, i **Amaga** la traducció per practicar.
- **Explica-m’ho fàcil** (amb Claude): reescriu una frase difícil en un català més senzill i l’explica en la llengua de l’alumne.
- Funciona al mòbil i, un cop oberta, també sense connexió.

### Professorat

- **Afegeix un llibre:** EPUB, DOCX, PDF, HTML, TXT o Markdown. Es detecten capítols, presentació, activitats, il·lustracions, portada, crèdits i el **glossari** dels EPUB que enllacen paraules a definicions. Abans de desar-lo es pot revisar què s’ha trobat.
- **Enganxa un text** directament (`# Títol` per separar capítols) o **obre un enllaç** a un fitxer publicat.
- **Tradueix tot el llibre** a una llengua d’una vegada.
- **Mode docent:** clica una traducció per corregir-la. Les traduccions revisades tenen prioritat sobre les automàtiques.
- **Comparteix:** desa el llibre amb totes les traduccions en un fitxer (`.lecturafacil.json`) per enviar-lo a l’alumnat, desa només la traducció per compartir-la amb altres docents, o crea un enllaç directe.
- **Imprimeix** un capítol en format bilingüe.

## Traducció automàtica i privacitat

Tot (llibres, traduccions, paraules, posició de lectura) es desa **només al navegador** (IndexedDB). No hi ha servidor propi.

Serveis de traducció disponibles (menú **Traductor**):

| Servei | Cost | Què s’envia | Notes |
|---|---|---|---|
| Traductor del navegador | Gratuït | Res: tradueix dins l’ordinador | Chrome/Edge recents d’escriptori. Algunes llengües no hi són. |
| MyMemory | Gratuït amb límit diari | Les frases, a `api.mymemory.translated.net` | Amb un correu a la configuració, la quota és més gran. |
| LibreTranslate | Segons el servidor | Les frases, al servidor que configuris | Ideal si el centre en té un de propi. |
| Claude (Anthropic) | De pagament, clau pròpia | Les frases, a l’API d’Anthropic | La millor qualitat, també per a llengües amb pocs recursos. Activa «Explica-m’ho fàcil» i el significat de qualsevol paraula en context. |

En mode **Automàtic** s’usa Claude si hi ha clau; si no, el traductor del navegador; si no, LibreTranslate si està configurat; i si no, MyMemory.

> Les claus API es desen només al navegador on s’escriuen. No les poseu als dispositius de l’alumnat: traduïu el llibre des de l’ordinador del docent i compartiu-ne el fitxer.

## Compartir

1. **Fitxer** (recomanat): menú ⋯ → *Desa el llibre amb les traduccions*. L’alumne l’obre a *Afegeix un llibre → Tria un fitxer*.
2. **Enllaç a un fitxer publicat:** pengeu el `.lecturafacil.json` en un lloc públic (aquest repositori, un Gist…) i compartiu
   `https://vmoren12.github.io/lecturafacil/?llibre=<adreça del fitxer>&llengua=ur`
3. **Llibres inclosos a l’aplicació:** afegiu el fitxer a `data/books/` i una entrada a [`data/library.json`](data/library.json). Hi podeu afegir traduccions revisades perquè tothom les tingui (vegeu [`data/README.md`](data/README.md)). Enllaç: `?llibre=<id>&llengua=<codi>`.

## Llibres amb drets d’autor

Moltes edicions de lectura fàcil són obres protegides. **No publiqueu al repositori ni a GitHub Pages llibres sense permís de l’editorial**: el lloc és públic.

Per fer servir una còpia pròpia només en local hi ha la carpeta `data/local/` i el fitxer `data/library.local.json`, que el `.gitignore` exclou. Per exemple, l’edició de lectura fàcil de *L’illa del tresor* de Castellnou Edicions es pot llegir sencera en local així:

```json
// data/library.local.json
{ "books": [ { "id": "illa-del-tresor-castellnou", "src": "local/illa-del-tresor-castellnou.epub", "version": 1 } ] }
```

Cada docent també pot carregar el seu EPUB des de l’aplicació: es processa i es desa només al seu navegador.

La mostra publicada (`data/books/illa-del-tresor-mostra.json`) és una adaptació pròpia dels capítols 1 i 2 de l’obra de Stevenson, que és de domini públic.

## Desenvolupament

No cal compilar res: és HTML, CSS i JavaScript (mòduls ES) estàtic.

```bash
npm start      # servidor local a http://localhost:8080
npm test       # proves unitàries (Node 20+)
```

Estructura:

```
index.html              pàgina única (biblioteca + lector)
css/app.css             estils (tema clar/fosc, mòbil, impressió)
js/main.js              arrencada, rutes, biblioteca, afegir llibres, configuració
js/reader.js            lector: pàgines, traducció, paraules, veu, eines del docent
js/books.js             dades: llibres inclosos i propis, paquets, memòria de traduccions
js/importers.js         lectura d’EPUB, DOCX, PDF, HTML i TXT
js/text.js              funcions pures: frases, capítols, hash (provades amb Node)
js/translate.js         serveis de traducció
js/languages.js         llengües i tipografies
js/store.js             IndexedDB i preferències
js/speech.js            veu
js/ui.js                utilitats d’interfície
sw.js                   funcionament sense connexió
data/                   llibres inclosos (vegeu data/README.md)
tests/                  proves
```

Les traduccions es guarden per *hash* de cada frase normalitzada, de manera que un paquet de traducció serveix per a qualsevol còpia del mateix llibre.

El desplegament a GitHub Pages és automàtic amb GitHub Actions en cada canvi a `main`, després de passar les proves.

## Llicència

Codi sota llicència [MIT](LICENSE). Els textos dels llibres tenen la llicència que indica cada llibre.
