/* Target languages offered to students, with the script font each one needs.
   Fonts come from Google Fonts and are loaded only when a language is chosen. */

const F = {
  arab: ["Noto Naskh Arabic", "wght@400;600"],
  urdu: ["Noto Nastaliq Urdu", "wght@400;600"],
  deva: ["Noto Sans Devanagari", "wght@400;600"],
  beng: ["Noto Sans Bengali", "wght@400;600"],
  guru: ["Noto Sans Gurmukhi", "wght@400;600"],
  hans: ["Noto Sans SC", "wght@400;600"],
  geor: ["Noto Sans Georgian", "wght@400;600"],
  armn: ["Noto Sans Armenian", "wght@400;600"],
  ethi: ["Noto Sans Ethiopic", "wght@400;600"],
  tfng: ["Noto Sans Tifinagh", ""],
  taml: ["Noto Sans Tamil", "wght@400;600"],
  thai: ["Noto Sans Thai", "wght@400;600"],
  kore: ["Noto Sans KR", "wght@400;600"],
  jpan: ["Noto Sans JP", "wght@400;600"]
};

/** code: BCP 47 · name: in Catalan · native: endonym · font: key of F · rtl */
export const LANGUAGES = [
  { code: "ar", name: "Àrab", native: "العربية", font: "arab", rtl: true },
  { code: "zgh", name: "Amazic (tifinagh)", native: "ⵜⴰⵎⴰⵣⵉⵖⵜ", font: "tfng" },
  { code: "rif", name: "Amazic rifeny (llatí)", native: "Tarifit" },
  { code: "en", name: "Anglès", native: "English" },
  { code: "es", name: "Castellà", native: "Español" },
  { code: "fr", name: "Francès", native: "Français" },
  { code: "ur", name: "Urdú", native: "اردو", font: "urdu", rtl: true },
  { code: "pa", name: "Panjabi", native: "ਪੰਜਾਬੀ", font: "guru" },
  { code: "hi", name: "Hindi", native: "हिन्दी", font: "deva" },
  { code: "bn", name: "Bengalí", native: "বাংলা", font: "beng" },
  { code: "ne", name: "Nepalès", native: "नेपाली", font: "deva" },
  { code: "zh", name: "Xinès", native: "中文", font: "hans" },
  { code: "ro", name: "Romanès", native: "Română" },
  { code: "uk", name: "Ucraïnès", native: "Українська" },
  { code: "ru", name: "Rus", native: "Русский" },
  { code: "pl", name: "Polonès", native: "Polski" },
  { code: "bg", name: "Búlgar", native: "Български" },
  { code: "ka", name: "Georgià", native: "ქართული", font: "geor" },
  { code: "hy", name: "Armeni", native: "Հայերեն", font: "armn" },
  { code: "pt", name: "Portuguès", native: "Português" },
  { code: "it", name: "Italià", native: "Italiano" },
  { code: "de", name: "Alemany", native: "Deutsch" },
  { code: "fa", name: "Persa", native: "فارسی", font: "arab", rtl: true },
  { code: "ps", name: "Paixtu", native: "پښتو", font: "arab", rtl: true },
  { code: "tr", name: "Turc", native: "Türkçe" },
  { code: "tl", name: "Tagal", native: "Tagalog" },
  { code: "sw", name: "Suahili", native: "Kiswahili" },
  { code: "wo", name: "Wòlof", native: "Wolof" },
  { code: "ff", name: "Ful", native: "Fulfulde" },
  { code: "ha", name: "Haussa", native: "Hausa" },
  { code: "so", name: "Somali", native: "Soomaali" },
  { code: "am", name: "Amhàric", native: "አማርኛ", font: "ethi" },
  { code: "ti", name: "Tigrinya", native: "ትግርኛ", font: "ethi" },
  { code: "ta", name: "Tàmil", native: "தமிழ்", font: "taml" },
  { code: "th", name: "Tai", native: "ไทย", font: "thai" },
  { code: "vi", name: "Vietnamita", native: "Tiếng Việt" },
  { code: "ko", name: "Coreà", native: "한국어", font: "kore" },
  { code: "ja", name: "Japonès", native: "日本語", font: "jpan" },
  { code: "ca", name: "Català", native: "Català" }
];

const BY_CODE = Object.fromEntries(LANGUAGES.map(l => [l.code, l]));

/** Language info; unknown codes (e.g. from a shared link) still work as LTR. */
export function lang(code) {
  return BY_CODE[code] || { code, name: code, native: code };
}

export const isRtl = code => !!lang(code).rtl;

const loadedFonts = new Set();
/** CSS font-family for a language, loading its web font the first time. */
export function fontFor(code) {
  const key = lang(code).font;
  if (!key) return "var(--f-body)";
  const [family, axes] = F[key];
  if (!loadedFonts.has(key) && typeof document !== "undefined") {
    loadedFonts.add(key);
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}${axes ? ":" + axes : ""}&display=swap`;
    document.head.appendChild(l);
  }
  return `"${family}", var(--f-body)`;
}

/** Scripts that need extra line height to stay readable. */
export const tallScript = code => ["ur", "ar", "fa", "ps", "bn", "hi", "ne", "pa", "ta", "th"].includes(code);
