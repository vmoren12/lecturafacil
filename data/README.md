# Llibres inclosos

`library.json` llista els llibres que veu tothom en obrir l’aplicació:

```json
{
  "books": [
    {
      "id": "illa-del-tresor-mostra",
      "src": "books/illa-del-tresor-mostra.json",
      "translations": { "ar": "translations/illa-del-tresor-mostra.ar.json" }
    }
  ]
}
```

| Camp | Obligatori | Què és |
|---|---|---|
| `id` | Sí | Identificador únic. Es fa servir als enllaços: `?llibre=<id>`. |
| `src` | Sí | Ruta, dins de `data/`, a un fitxer `.json` de Lectura fàcil o a un llibre (`.epub`, `.docx`, `.txt`…) que s’importa en obrir-lo. |
| `version` | No | Per a llibres que no són `.json`: augmenta-la quan canviï el fitxer perquè es torni a importar. |
| `title`, `subtitle`, `author`, `description` | No | Substitueixen les dades del fitxer. |
| `translations` | No | Traduccions revisades per llengua (fitxers desats amb *Desa la traducció*). Tenen prioritat sobre les automàtiques. |

`library.local.json` té el mateix format, **no es publica** (és al `.gitignore`, igual que la carpeta `local/`) i només es llegeix quan l’app s’obre des de `localhost`. Serveix per a còpies de llibres amb drets d’autor que només s’han de fer servir en aquest ordinador.

## Format dels fitxers `.json`

Els genera l’aplicació (*Desa el llibre amb les traduccions*). Resum:

```jsonc
{
  "format": "lecturafacil", "version": 1, "type": "book",
  "id": "…", "title": "…", "author": "…", "lang": "ca",
  "cover": "data:image/jpeg;base64,…",           // opcional
  "levels": [{ "id": "facil", "label": "Fàcil" }], // opcional: diverses versions del text
  "sections": [
    {
      "kind": "chapter",                    // chapter | front | activities | glossary | back
      "n": 1, "title": "…",
      "blocks": [                           // o "levels": { "facil": [...], "molt": [...] }
        { "type": "p", "s": ["Frase 1.\nAmb salt de línia.", "Frase 2."] },
        { "type": "img", "src": "…", "alt": "" },
        { "type": "h", "t": "Subtítol" }
      ]
    }
  ],
  "glossary": [{ "id": "g0", "term": "posada", "def": "…", "forms": ["posada"] }],
  "dict": { "illa": { "p": "nom f.", "d": "…", "en": "island", "f": ["illa", "illes"], "k": 1 } },
  "translations": { "en": { "<hash de la frase>": "Translation" } }
}
```

Un fitxer de traducció (`"type": "translation"`) conté `bookId`, `lang`, `m` (frases, per hash) i `w` (paraules).
