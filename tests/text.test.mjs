import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSentences, hashText, normalize, sectionize, textToBlocks, isLineMode, toNum, kindOf } from "../js/text.js";

test("splits sentences and keeps the easy-to-read line breaks", () => {
  const p = "—M’agrada aquesta posada –li va dir al meu pare–.\nQue té molts clients?\nEl meu pare li va contestar que no.";
  assert.deepEqual(splitSentences(p), [
    "—M’agrada aquesta posada –li va dir al meu pare–.",
    "Que té molts clients?",
    "El meu pare li va contestar que no."
  ]);
  const q = "Diversos cavallers amics meus m’han demanat\nque escrigui tot el que ens va passar.";
  assert.deepEqual(splitSentences(q), [q]);
});

test("does not split after abbreviations and splits list items", () => {
  assert.deepEqual(splitSentences("Va venir el Dr. Livesey. Era tard."), ["Va venir el Dr. Livesey.", "Era tard."]);
  assert.deepEqual(splitSentences("a) Per què viatges?\nb) On aniries?"), ["a) Per què viatges?", "b) On aniries?"]);
});

test("hash ignores spacing and apostrophe style", () => {
  assert.equal(hashText("L’illa  del tresor"), hashText("L'illa del tresor"));
  assert.notEqual(hashText("L'illa del tresor"), hashText("L'illa del tresors"));
  assert.equal(normalize(" a\n b "), "a b");
});

test("roman, digit and word chapter numbers", () => {
  assert.equal(toNum("XIV"), 14);
  assert.equal(toNum("7"), 7);
  assert.equal(toNum("tres"), 3);
  assert.equal(kindOf("I TU, COM HO VEUS?"), "activities");
  assert.equal(kindOf("Índex"), "toc");
});

test("plain text with chapter headings becomes chapters", () => {
  const txt = [
    "# Presentació", "", "Una illa deserta.", "",
    "# 1 El vell mariner", "", "Un dia va arribar un mariner.", "Era alt i fort.", "",
    "Portava un bagul.", "",
    "# 2 Gos Negre", "", "Un matí va venir un home."
  ].join("\n");
  const secs = sectionize(textToBlocks(txt));
  assert.deepEqual(secs.map(s => [s.kind, s.n, s.title]), [
    ["front", null, "Presentació"],
    ["chapter", 1, "El vell mariner"],
    ["chapter", 2, "Gos Negre"]
  ]);
  assert.equal(secs[1].blocks.filter(b => b.type === "p").length, 2);
});

test("line mode joins the short lines of one group", () => {
  const lines = ["Un dia va arribar", "a la porta d’aquella posada", "un vell mariner amb un carretó,", "on portava un bagul.",
    "Era un home alt i fort.", "La cicatriu d’una ganivetada", "li travessava la cara,", "des de la mandíbula fins al front."];
  const blocks = [{ t: "1 La posada", h: 1, g: 0 }, ...lines.map(t => ({ t, h: 0, g: 1 }))];
  assert.ok(isLineMode(blocks));
  const [ch] = sectionize(blocks);
  assert.equal(ch.n, 1);
  assert.deepEqual(ch.blocks[0].s, [
    "Un dia va arribar\na la porta d’aquella posada\nun vell mariner amb un carretó,\non portava un bagul.",
    "Era un home alt i fort.",
    "La cicatriu d’una ganivetada\nli travessava la cara,\ndes de la mandíbula fins al front."
  ]);
});

test("a duplicated chapter number keeps the longest section", () => {
  const blocks = [
    { t: "1 El mar", h: 1, g: 0 }, { t: "Curt.", h: 0, g: 1 },
    { t: "1 El mar", h: 1, g: 2 }, { t: "Aquest és el capítol de veritat, amb moltes més paraules que l’altre.", h: 0, g: 3 }
  ];
  const secs = sectionize(blocks);
  assert.deepEqual(secs.map(s => s.sel), [false, true]);
});

test("hard-wrapped prose is joined into paragraphs", () => {
  const txt = "This is a long line of prose that was wrapped at a fixed width by the\neditor and continues on the next line without any punctuation at the\nend of each line.\n\nSecond paragraph.";
  const b = textToBlocks(txt);
  assert.equal(b.length, 2);
});
