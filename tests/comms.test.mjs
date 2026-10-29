/**
 * CISLUNAR 2030 — test del copione radio e della libreria clip
 * ============================================================
 *   node tests/comms.test.mjs
 * Nessuna dipendenza, nessun browser: verifica il copione (data/comms_lines.js),
 * i numeri a parole, il matching su tutti i messaggi dei sorgenti e l'integrita
 * del manifest sfornato da tools/tts_bake.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LINES, VOICES, normalize, numToIt, numToEn, slotValue, slotGrid,
  fill, matchAll, resolveClip,
} from '../data/comms_lines.js';
import { AudioComms } from '../systems/audio_comms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['it', 'en'];
let n = 0;
const ok = (label) => { n++; console.log('  \u2714 ' + label); };

/* 1 — struttura del copione */
{
  const ids = new Set();
  for (const e of LINES) {
    assert.ok(e.id && /^[a-z0-9_]+$/.test(e.id), 'id valido: ' + e.id);
    assert.ok(!ids.has(e.id), 'id unico: ' + e.id);
    ids.add(e.id);
    assert.ok(e.re instanceof RegExp, 'regex presente: ' + e.id);
    for (const l of LANGS) {
      assert.ok(typeof e[l] === 'string' && e[l].length > 3, 'testo ' + l + ' per ' + e.id);
      assert.ok(e[l].length < 260, 'riga non chilometrica: ' + e.id);
      assert.ok(!/[\u2714\u2716\u26A0]/u.test(e[l]), 'niente emoji nel parlato: ' + e.id);
    }
    const slots = (e.it.match(/\{n\}/g) || []).length;
    if (e.num) {
      assert.equal(slots, 1, 'uno slot per riga con num: ' + e.id);
      assert.ok(e.num.step > 0 && e.num.max >= e.num.min, 'griglia valida: ' + e.id);
      assert.ok(slotGrid(e).length <= 20, 'griglia contenuta (' + slotGrid(e).length + '): ' + e.id);
    } else {
      assert.equal(slots, 0, 'senza num non ci sono {n}: ' + e.id);
    }
  }
  assert.ok(LINES.length >= 40, 'copione completo: ' + LINES.length + ' righe');
  ok('copione: ' + LINES.length + ' righe, ' + ids.size + ' id unici, voci ' + VOICES.it + ' / ' + VOICES.en);
}

/* 2 — numeri a parole */
{
  assert.equal(numToIt(0), 'zero');
  assert.equal(numToIt(7), 'sette');
  assert.equal(numToIt(15), 'quindici');
  assert.equal(numToIt(21), 'ventuno');
  assert.equal(numToIt(28), 'ventotto');
  assert.equal(numToIt(42), 'quarantadue');
  assert.equal(numToIt(105), 'centocinque');
  assert.equal(numToIt(61), 'sessantuno');
  assert.equal(numToIt(1600), 'milleseicento');
  assert.equal(numToIt(2461), 'duemilaquattrocentosessantuno');
  assert.equal(numToIt(3000), 'tremila');
  assert.equal(numToIt(10000), 'diecimila');
  assert.equal(numToIt(2.5), 'due virgola cinque');
  assert.equal(numToEn(2461), 'two thousand four hundred and sixty-one');
  assert.equal(numToEn(4.5), 'four point five');
  assert.equal(numToEn(100), 'one hundred');
  ok('numeri a parole IT/EN');
}

/* 3 — normalizzazione e slot numerici */
{
  assert.equal(normalize('FASE  4 — INGRESSO NELLA SOI!'), 'fase 4 ingresso nella soi');
  assert.equal(normalize('velocità è'), 'velocita e');
  const loi = LINES.find((e) => e.id === 'f4_loi');
  assert.equal(slotValue(loi, 'sottrarre ~612 m/s').value, 600);
  assert.equal(slotValue(loi, 'sottrarre ~99999 m/s').value, loi.num.max, 'cappa al massimo');
  assert.equal(slotValue(loi, 'nessun numero qui'), null);
  const fc = LINES.find((e) => e.id === 'f10_found');
  assert.ok(fc && fc.num, 'la riga corridoio TEI ha uno slot numerico');
  assert.equal(slotValue(fc, 'corridoio TEI trovato: 640 metri').value, 600);
  assert.equal(slotValue(fc, 'trovato 99999').value, fc.num.max, 'cappa al massimo');
  assert.equal(slotValue(fc, 'nessun numero qui'), null);
  const dec = { num: { re: /finora (\d+[.,]\d+)/i, step: 0.5, min: 2, max: 6 } };
  assert.equal(slotValue(dec, 'G max finora 4.2.').key, '4_0');
  assert.equal(slotValue(dec, 'G max finora 4.4.').key, '4_5');
  ok('normalizzazione + slot (arrotondamento, cappatura, decimali)');
}

/* 4 — ogni messaggio dei sorgenti aggancia UNA SOLA riga del copione */
{
  const files = ['main.js', 'systems/autopilot.js', 'systems/descent.js', 'ui/cockpit.js'];
  const calls = [];
  const LIT = /"([^"]*)"|'([^']*)'/g;
  for (const f of files) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const key of ['narrate(', '.say(']) {
      let from = 0, k;
      while ((k = s.indexOf(key, from)) >= 0) {
        from = k + key.length;
        let end = s.indexOf(');', from);
        if (end < 0 || end - from > 900) continue;
        const win = s.slice(from, end).replace(/\s+/g, ' ');
        const lits = [...win.matchAll(LIT)].map((x) => (x[1] !== undefined ? x[1] : x[2]));
        if (!lits.length) continue;                    // es. narrate(text, phase)
        const text = lits[0], phase = lits.length > 1 ? lits[lits.length - 1] : f;
        if (text.length < 12) continue;
        calls.push({ text, phase, where: f });
      }
    }
  }
  // righe recitate dalla tabella ACT0_LINES di main.js
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const a0 = main.slice(main.indexOf('ACT0_LINES'), main.indexOf('function act0Event'));
  for (const x of a0.matchAll(/'([^']{12,})'\s*,\s*'([^']{3,})'/g)) calls.push({ text: x[1], phase: x[2], where: 'ACT0' });
  // sotto-stati del rendezvous (tabella interna all'autopilota)
  const extra = [
    ["Rendezvous: allineo quota/velocità con l'orbita di Mengzhou...", "F9"],
    ["Impulso di fase: accensione per creare la deriva di chiusura...", "F9"],
    ["Deriva di chiusura: aspetto che il gap si riduca sotto i 10 km...", "F9"],
    ["Controimpulso: ricircolarizzo sull'orbita di Mengzhou...", "F9"],
    ["Chiusura finale: molla CW, velocità relativa < 1 m/s...", "F9"],
  ].map(([text, phase]) => ({ text, phase, where: 'F9' }));

  const seen = new Set();
  const problems = [];
  let checked = 0;
  for (const c of calls.concat(extra)) {
    const k = c.phase + '::' + c.text;
    if (seen.has(k)) continue;
    seen.add(k);
    const hits = matchAll(c.text, c.phase);
    if (hits.length !== 1) problems.push('[' + c.where + '][' + c.phase + '] ' + c.text.slice(0, 60) + ' -> ' + (hits.map((h) => h.id).join(',') || 'NESSUN MATCH'));
    else if (!resolveClip(c.text, c.phase).id) problems.push('id mancante: ' + c.text.slice(0, 40));
    else checked++;
  }
  assert.equal(problems.length, 0, 'messaggi non coperti dal copione:\n  - ' + problems.join('\n  - '));
  assert.ok(checked >= 30, 'almeno 30 messaggi verificati, trovati ' + checked);
  ok('matching univoco su ' + checked + ' messaggi dei sorgenti (narrate/say/ACT0/F9)');
}

/* 5 — AudioComms resta un no-op sicuro in Node */
{
  const a = new AudioComms();
  assert.equal(a.say('FASE 2 — ACCENSIONE TLI: X', 'F2'), 'FASE 2 — ACCENSIONE TLI: X');
  assert.equal(a.ensure(), false);
  assert.equal(a.libraryReady, false);
  assert.equal(a.allowTTS, false, 'la voce del browser è disattivata di default');
  a.speakLine('prova');                       // senza flag non deve fare nulla
  a.tick({ status: 'NOMINAL', ship: { throttle: 0, attitude: 0 }, thrustFactor: 1 }, 1000);
  a.stop();
  assert.equal(a.cycle(), 'ENG');
  ok('AudioComms no-op sicuro in Node + TTS browser disattivato');
}

/* 6 — manifest + file su disco */
{
  const mp = path.join(ROOT, 'data', 'comms_manifest.json');
  if (!fs.existsSync(mp)) console.log('  [SKIP] manifest assente: lancia node tools/tts_bake.mjs');
  else {
    const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
    let need = 0;
    const missing = [];
    for (const e of LINES) {
      for (const s of (e.num ? slotGrid(e) : [null])) {
        const id = s ? e.id + '@' + s.key : e.id;
        for (const lang of LANGS) {
          need++;
          const c = man.clips[lang + '.' + id];
          if (!c) { missing.push(lang + '.' + id); continue; }
          const f = path.join(ROOT, c.f);
          assert.ok(fs.existsSync(f), 'file clip presente: ' + c.f);
          assert.ok(fs.statSync(f).size > 900, 'clip non vuota: ' + c.f);
          assert.ok(c.ms > 300 && c.ms < 40000, 'durata plausibile (' + c.ms + ' ms): ' + id);
          assert.equal(c.text, fill(e, lang, s, true), 'testo baked = copione: ' + lang + '.' + id);
        }
      }
    }
    assert.equal(missing.length, 0, 'clip mancanti: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' +' + (missing.length - 8) : ''));
    ok('manifest: ' + Object.keys(man.clips).length + ' clip su ' + need + ' richieste, tutte su disco');
  }
}

/* 7 — corpus del gioco (se harvestato) */
{
  const cp = path.join(ROOT, 'data', 'comms_corpus.json');
  if (!fs.existsSync(cp)) console.log('  [SKIP] corpus assente: lancia node tools/comms_harvest.mjs');
  else {
    const cor = JSON.parse(fs.readFileSync(cp, 'utf8'));
    for (const en of cor.entries) {
      const hits = matchAll(en.text, en.phase);
      assert.equal(hits.length, 1, 'corpus: match univoco per [' + en.phase + '] ' + en.text.slice(0, 60));
      const r = resolveClip(en.text, en.phase);
      if (r.entry.num) assert.ok(r.slot, 'corpus: slot riempito per ' + r.id);
    }
    ok('corpus gioco: ' + cor.entries.length + ' messaggi reali tutti coperti');
  }
}

console.log('comms.test: ' + n + ' gruppi di asserzioni superati');
