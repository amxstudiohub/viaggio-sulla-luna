#!/usr/bin/env node
/**
 * CISLUNAR 2030 — bake della voce radio (tools/tts_bake.mjs)
 * =========================================================
 * Trasforma il copione (data/comms_lines.js) in clip mp3 pronte per il
 * pacchetto offline: assets/audio/comms/*.mp3 + data/comms_manifest.json.
 *
 *   node tools/tts_bake.mjs                       # bake completo (engine=edge)
 *   node tools/tts_bake.mjs --dry-run            # elenca e basta
 *   node tools/tts_bake.mjs --force              # ribake tutto
 *   node tools/tts_bake.mjs --lang=it            # una sola lingua
 *   node tools/tts_bake.mjs --only=f2_meco,f4_loi
 *   node tools/tts_bake.mjs --engine=piper --model=/percorso/it_IT-serena-high.onnx
 *
 * Richiede: ffmpeg + ffprobe; engine=edge richiede edge-tts
 * (python3 -m venv /tmp/ttsenv && /tmp/ttsenv/bin/pip install edge-tts).
 * Il risultato finale NON dipende dalla rete: la rete serve solo qui, ora.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { LINES, VOICES, fill, slotGrid } from '../data/comms_lines.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTDIR = path.join(ROOT, 'assets', 'audio', 'comms');
const MANIFEST = path.join(ROOT, 'data', 'comms_manifest.json');
const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const has = (n) => argv.includes('--' + n);

const ENGINE = flag('engine', 'edge');
const LANGS = flag('lang', 'it,en').split(',').map(s => s.trim()).filter(Boolean);
const ONLY = flag('only', '').split(',').map(s => s.trim()).filter(Boolean);
const RATE = flag('rate', '+4%');
const BITRATE = flag('bitrate', '24k');
const PIPER = flag('piper', 'piper');
const MODEL = flag('model', '');
const DRY = has('dry-run');
const FORCE = has('force');

function which(cmd) {
  if (cmd.startsWith('/')) return fs.existsSync(cmd) ? cmd : null;
  for (const p of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(p, cmd);
    try { if (fs.existsSync(f)) return f; } catch (e) { /* ignore */ }
  }
  return null;
}

const EDGE = which(flag('edge', 'edge-tts')) || which('/tmp/ttsenv/bin/edge-tts');
if (ENGINE === 'edge' && !EDGE && !DRY) {
  console.error('edge-tts non trovato. Installa: python3 -m venv /tmp/ttsenv && /tmp/ttsenv/bin/pip install edge-tts');
  console.error('oppure passa --edge=/percorso/edge-tts, oppure --engine=piper.');
  process.exit(2);
}
if (ENGINE === 'piper' && !(which(PIPER) && MODEL) && !DRY) {
  console.error('piper: servono --piper=/percorso/piper e --model=/percorso/voce.onnx');
  process.exit(2);
}
for (const b of ['ffmpeg', 'ffprobe']) if (!which(b) && !DRY) { console.error(b + ' non trovato'); process.exit(2); }

/** Elenco completo delle clip: base + griglia chiusa degli slot numerici. */
function clipList() {
  const out = [];
  for (const e of LINES) {
    if (ONLY.length && !ONLY.some(o => e.id === o || e.id.startsWith(o))) continue;
    if (e.num) {
      const grid = slotGrid(e);
      if (!grid.length) { console.error('!! slot senza griglia: ' + e.id); continue; }
      for (const s of grid) for (const lang of LANGS) {
        out.push({ id: e.id + '@' + s.key, lang, text: fill(e, lang, s, true) });
      }
    } else {
      for (const lang of LANGS) out.push({ id: e.id, lang, text: fill(e, lang, null, true) });
    }
  }
  return out;
}

const fileOf = (lang, id) => (lang + '_' + id.replace(/[@]/g, '_')).replace(/[^A-Za-z0-9_-]/g, '') + '.mp3';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const run = (cmd, args, ms) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: ms || 120000, encoding: 'utf8' });

function duration(file) {
  const o = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).trim();
  return parseFloat(o) || 0;
}

function synth(text, voice, dest) {
  const raw = dest + '.raw';
  if (ENGINE === 'piper') {
    run(PIPER, ['--model', MODEL, '--output_file', raw, '--input_text', text], 180000);
  } else {
    run(EDGE, ['--voice', voice, '--rate', RATE, '--text', text, '--write-media', raw], 120000);
  }
  const af = 'highpass=f=80,'
    + 'silenceremove=start_periods=1:start_threshold=-45dB,'
    + 'areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,'
    + 'loudnorm=I=-16:TP=-1.5:LRA=11';
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', af, '-ac', '1', '-ar', '24000', '-b:a', BITRATE, dest], 120000);
  fs.unlinkSync(raw);
}

/* ------------------------- main ------------------------- */

fs.mkdirSync(OUTDIR, { recursive: true });
const man = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { version: 1, engine: ENGINE, voices: VOICES, clips: {} };
man.engine = ENGINE; man.voices = VOICES;

const list = clipList();
let done = 0, skipped = 0, failed = [];
const t0 = Date.now();
console.log('Bake ' + ENGINE + ' | ' + list.length + ' clip | lingue: ' + LANGS.join(','));
if (DRY) { for (const c of list) console.log('  ' + c.lang + '.' + c.id + '  ' + c.text.slice(0, 70)); console.log('(dry-run: nessun file scritto)'); process.exit(0); }

for (const c of list) {
  const key = c.lang + '.' + c.id;
  const file = fileOf(c.lang, c.id);
  const dest = path.join(OUTDIR, file);
  const voice = VOICES[c.lang];
  const sig = sha(ENGINE + '|' + voice + '|' + RATE + '|' + c.text);
  if (!FORCE && fs.existsSync(dest) && man.clips[key] && man.clips[key].sha === sig) { skipped++; continue; }
  let ok = false, tries = 0;
  while (!ok && tries < 3) {
    tries++;
    try {
      synth(c.text, voice, dest);
      const ms = Math.round(duration(dest) * 1000);
      if (fs.statSync(dest).size < 900 || ms < 300) throw new Error('clip troppo corta/vuota (' + ms + ' ms)');
      man.clips[key] = { f: 'assets/audio/comms/' + file, ms: ms, sha: sig, text: c.text };
      ok = true; done++;
      const pct = Math.round(100 * (done + skipped) / list.length);
      console.log('  [' + pct + '%] ' + key + '  ' + (ms / 1000).toFixed(1) + 's');
    } catch (e) {
      const msg = String(e.message || e).slice(0, 160);
      if (tries === 3) { failed.push(key + ': ' + msg); console.error('  !! ' + key + ' FALLITA: ' + msg); }
      else { const wait = 800 * tries; console.error('  .. retry ' + key + ' (' + msg + ') dopo ' + wait + ' ms'); fs.rmSync(dest, { force: true }); sleep(wait); }
    }
  }
}
function sleep(ms) { const t = Date.now(); while (Date.now() - t < ms) { /* busy: il tool e sequenziale e breve */ } }

fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 1) + '\n');
const tot = Object.values(man.clips).reduce((a, c) => a + c.ms, 0);
const bytes = Object.values(man.clips).reduce((a, c) => a + (fs.statSync(path.join(ROOT, c.f)).size || 0), 0);
console.log('---');
console.log('nuove ' + done + ' | già a posto ' + skipped + ' | fallite ' + failed.length);
console.log('manifest: ' + Object.keys(man.clips).length + ' clip, ' + (tot / 1000 / 60).toFixed(1) + ' min di parlato, ' + (bytes / 1048576).toFixed(2) + ' MB');
console.log('tempo ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s -> ' + MANIFEST);
if (failed.length) { console.log('DA RIFARE: node tools/tts_bake.mjs --only=' + failed.map(f => f.split(':')[0]).join(',')); process.exit(1); }
