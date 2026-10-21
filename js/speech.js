/* Text to speech with the voices installed on the device. */

const synth = globalThis.speechSynthesis;
let voices = [];
const load = () => { try { voices = synth ? synth.getVoices() : []; } catch { voices = []; } };
load();
if (synth) synth.onvoiceschanged = load;

const DEFAULT_LOCALE = { ca: "ca-ES", en: "en-GB", es: "es-ES", ur: "ur-PK", ar: "ar-SA", zh: "zh-CN", pa: "pa-IN", hi: "hi-IN", bn: "bn-BD" };

export function voiceFor(lang) {
  const l = lang.toLowerCase();
  return voices.find(v => v.lang && v.lang.toLowerCase().replace("_", "-").startsWith(l));
}
export const canSpeak = () => !!synth;
export const hasVoice = lang => !!voiceFor(lang);
export const stop = () => { if (synth) synth.cancel(); };

/** Speaks text; returns false when the browser has no speech synthesis. */
export function speak(text, lang, { slow = false, onend } = {}) {
  if (!synth) return false;
  const u = new SpeechSynthesisUtterance(String(text).replace(/[«»—–“”\n]/g, " "));
  const v = voiceFor(lang);
  u.lang = v ? v.lang : DEFAULT_LOCALE[lang] || lang;
  if (v) u.voice = v;
  u.rate = slow ? 0.7 : 0.92;
  if (onend) { u.onend = onend; u.onerror = onend; }
  synth.speak(u);
  return true;
}
