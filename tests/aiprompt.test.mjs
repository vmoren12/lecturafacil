import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, parseAiAnswer } from "../js/aiprompt.js";
import { normalizeBook, mergePart } from "../js/books.js";
import { hashText } from "../js/text.js";

test("exact copy prompt forbids changes and asks for valid JSON", () => {
  const p = buildPrompt({ mode: "exact", langs: [], keywords: false, glossary: false, parts: 0 });
  assert.match(p, /Còpia exacta/);
  assert.match(p, /no canviïs ni afegeixis cap paraula/);
  assert.doesNotMatch(p, /Pautes de lectura fàcil/);
  assert.doesNotMatch(p, /"levels"/);
  const json = p.match(/```json\n([\s\S]*?)\n```/)[1];
  const example = JSON.parse(json);
  assert.equal(example.format, "lecturafacil");
  assert.ok(Array.isArray(example.sections[1].blocks));
});

test("levels prompt lists the chosen levels and uses them in the example", () => {
  const p = buildPrompt({ mode: "levels", levels: ["original", "molt"], langs: ["en", "ur"], langNames: { en: "anglès", ur: "urdú" }, parts: 5, title: "L’illa del tresor" });
  assert.match(p, /2 nivells/);
  assert.match(p, /en \(anglès\), ur \(urdú\)/);
  assert.match(p, /parts de 5 capítols/);
  const example = JSON.parse(p.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(example.id, "l-illa-del-tresor");
  assert.deepEqual(example.levels.map(l => l.id), ["original", "molt"]);
  assert.deepEqual(Object.keys(example.sections[1].levels), ["original", "molt"]);
  assert.deepEqual(Object.keys(example.sections[1].levels.molt[0].s[0].tr), ["en", "ur"]);
});

test("the answer is found inside text and code fences, and trailing commas are forgiven", () => {
  const ans = 'Aquí tens el llibre:\n```json\n{ "format": "lecturafacil", "sections": [1, 2,], }\n```\nPart 1 de 3.';
  assert.deepEqual(parseAiAnswer(ans), { format: "lecturafacil", sections: [1, 2] });
  assert.throws(() => parseAiAnswer('{ "format": "lecturafacil", "sections": [ {"a": 1'), /tallada/);
  assert.throws(() => parseAiAnswer("Ho sento, no puc."), /cap JSON/);
});

test("translations written next to the sentences become built-in translations", () => {
  const book = normalizeBook({
    id: "x", title: "T", titleTr: { en: "T-en" },
    sections: [{ kind: "chapter", n: "1", title: "El mar", titleTr: { en: "The sea" }, levels: {
      facil: [{ type: "p", s: [{ t: "Hola.", tr: { en: "Hello.", ur: "سلام۔" } }, "Adéu."] }, { type: "h", t: "Sub", tr: { en: "Sub-en" } }]
    } }],
    glossary: [{ term: "Posada", def: "Casa." }]
  });
  assert.deepEqual(book.sections[0].levels.facil[0].s, ["Hola.", "Adéu."]);
  assert.equal(book.sections[0].n, 1);
  assert.equal(book.translations.en[hashText("Hola.")], "Hello.");
  assert.equal(book.translations.ur[hashText("Hola.")], "سلام۔");
  assert.equal(book.translations.en[hashText("El mar")], "The sea");
  assert.equal(book.translations.en[hashText("Sub")], "Sub-en");
  assert.deepEqual(book.levels, [{ id: "facil", label: "Fàcil" }]);
  assert.deepEqual(book.glossary[0].forms, ["posada"]);
});

test("parts of a long book are merged in chapter order", () => {
  const p1 = normalizeBook({ id: "x", title: "T", sections: [{ kind: "front", title: "Presentació", blocks: [] }, { kind: "chapter", n: 1, title: "U", blocks: [] }, { kind: "chapter", n: 2, title: "Dos", blocks: [] }], dict: { a: { d: "1" } } });
  const p2 = normalizeBook({ id: "x", title: "T", sections: [{ kind: "back", title: "Crèdits", blocks: [] }, { kind: "chapter", n: 3, title: "Tres", blocks: [] }, { kind: "chapter", n: 2, title: "Dos (nou)", blocks: [] }], dict: { b: { d: "2" } } });
  const m = mergePart(p1, p2);
  assert.deepEqual(m.sections.map(s => s.title), ["Presentació", "U", "Dos (nou)", "Tres", "Crèdits"]);
  assert.deepEqual(Object.keys(m.dict), ["a", "b"]);
});
