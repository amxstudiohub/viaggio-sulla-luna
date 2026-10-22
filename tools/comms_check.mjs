/**
 * CISLUNAR 2030 — verifica copertura radio (tools/comms_check.mjs)
 * ===============================================================
 * Controlla che ogni messaggio del copione (e ogni messaggio realmente
 * detto in gioco, se esiste data/comms_corpus.json) abbia la sua clip mp3
 * nel manifest, presente su disco, in entrambe le lingue.
 *
 *   node tools/comms_check.mjs [--corpus=data/comms_corpus.json]
 * Esce 1 se manca qualcosa (da usare dopo il bake e dopo l'harvest).
 */
import fs from 'fs';
import path from 'path';
import { LINES, resolveClip, matchAll, slotGrid, fill } from '../data/comms_lines.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const A = process.argv.slice(2);
const flag = (n, d) => { const a = A.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const MANIFEST = path.join(ROOT, 'data', 'comms_manifest.json');
const CORPUS = flag('corpus', path.join(ROOT, 'data', 'comms_corpus.json'));
const LANGS = ['it', 'en'];
const errs = [], warns = [];

if (!fs.existsSync(MANIFEST)) { console.error('MANIFEST ASSENTE: ' + MANIFEST + ' — lancia node tools/tts_bake.mjs'); process.exit(1); }
const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

/* 1) id duplicati nel copione */
const ids = new Map();
for (const e of LINES) {
  const grid = e.num ? slotGrid(e) : [null];
  for (const s of grid) {
    const id = s ? e.id + '@' + s.key : e.id;
    ids.set(id, (ids.get(id) || 0) + 1);
  }
}
for (const [id, n] of ids) if (n > 1) errs.push('id duplicato nel copione: ' + id + ' (' + n + ')');

/* 2) ogni riga/variante del copione deve avere la clip, per ogni lingua */
let need = 0;
for (const e of LINES) {
  const grid = e.num ? slotGrid(e) : [null];
  if (e.num && !grid.length) errs.push('slot senza griglia: ' + e.id);
  for (const s of grid) {
    const id = s ? e.id + '@' + s.key : e.id;
    for (const lang of LANGS) {
      need++;
      const key = lang + '.' + id;
      const c = man.clips[key];
      if (!c) { errs.push('clip mancante nel manifest: ' + key); continue; }
      const f = path.join(ROOT, c.f);
      if (!fs.existsSync(f)) { errs.push('file mancante: ' + c.f); continue; }
      if (fs.statSync(f).size < 900) errs.push('file troppo piccolo (' + fs.statSync(f).size + ' B): ' + c.f);
      if (!(c.ms > 300)) errs.push('durata dubbia (' + c.ms + ' ms): ' + key);
      const txt = fill(e, lang, s, true);
      if (c.text && c.text !== txt) warns.push('testo cambiato (ribake): ' + key);
    }
  }
}

/* 3) clip nel manifest che non corrispondono piu a nessuna riga */
for (const key of Object.keys(man.clips)) {
  const id = key.split('.').slice(1).join('.');
  const base = id.split('@')[0];
  if (!LINES.some((e) => e.id === base)) warns.push('clip orfana nel manifest (riga rimossa?): ' + key);
}

/* 4) corpus del gioco: ogni messaggio deve agganciare UNA SOLA riga con clip */
let nCorpus = 0;
if (fs.existsSync(CORPUS)) {
  const cor = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  nCorpus = (cor.entries || []).length;
  for (const en of cor.entries || []) {
    const all = matchAll(en.text, en.phase);
    if (!all.length) { errs.push('NESSUN MATCH per [' + en.phase + '] ' + en.text.slice(0, 70)); continue; }
    if (all.length > 1) errs.push('AMBIGUO (' + all.map(x => x.id).join(',') + ') per [' + en.phase + '] ' + en.text.slice(0, 60));
    const r = resolveClip(en.text, en.phase);
    if (r.entry.num && !r.slot) errs.push('slot non riempito per ' + r.id + ' :: ' + en.text.slice(0, 60));
    for (const lang of LANGS) if (!man.clips[lang + '.' + r.id]) errs.push('clip mancante per il corpus: ' + lang + '.' + r.id);
  }
} else {
  warns.push('corpus assente (' + CORPUS + '): lancia node tools/comms_harvest.mjs per la verifica end-to-end');
}

const tot = Object.values(man.clips).reduce((a, c) => a + (c.ms || 0), 0);
const bytes = Object.values(man.clips).reduce((a, c) => { try { return a + fs.statSync(path.join(ROOT, c.f)).size; } catch { return a; } }, 0);
console.log('copione: ' + LINES.length + ' righe (' + [...ids].filter(x => x[0].includes('@')).length + ' varianti numeriche) | richieste ' + need + ' clip');
console.log('manifest: ' + Object.keys(man.clips).length + ' clip | ' + (tot / 60000).toFixed(1) + ' min | ' + (bytes / 1048576).toFixed(2) + ' MB');
if (nCorpus) console.log('corpus gioco: ' + nCorpus + ' messaggi unici verificati');
for (const w of warns) console.log('  [warn] ' + w);
for (const e of errs) console.log('  [ERR ] ' + e);
console.log(errs.length ? 'ESITO: ' + errs.length + ' problemi' : 'ESITO: copertura OK');
process.exit(errs.length ? 1 : 0);
