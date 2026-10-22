/**
 * CISLUNAR 2030 — raccolta del corpus parlato reale (tools/comms_harvest.mjs)
 * ==========================================================================
 * Fa girare la missione completa headless (Sim + Autopilot, come
 * tests/phase2.test.mjs) e registra ogni messaggio passato dal Mission
 * Director: è la verita su cosa viene detto in gioco, numeri dinamici
 * inclusi. Gli stessi testi sono quelli che AudioComms.say() riceve in gioco
 * (main.js inoltra narrate -> audio.say senza modificarli).
 *
 *   node tools/comms_harvest.mjs                       # cnsa + spacex
 *   node tools/comms_harvest.mjs --mission=spacex
 *   node tools/comms_harvest.mjs --out=data/comms_corpus.json
 *
 * Poi: node tools/comms_check.mjs  (e node tests/comms.test.mjs)
 */
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MISSIONS } from '../data/spacecraft_specs.js';
import { Sim } from '../core/physics.js';
import { TimeWarp, ManeuverNode } from '../systems/planner.js';
import { Autopilot, PHASE } from '../systems/autopilot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = process.argv.slice(2);
const flag = (n, d) => { const a = A.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const OUT = flag('out', path.join(ROOT, 'data', 'comms_corpus.json'));
const WANT = flag('mission', 'cnsa,spacex').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const DT = 0.1, FR = 1 / 60;

function runMission(id) {
  const sim = new Sim(MISSIONS[id]);
  const warp = new TimeWarp(), node = new ManeuverNode();
  const seen = new Map();
  const ap = new Autopilot(sim, { warp, node, narrate: (text, phase) => seen.set(phase + '::' + text, { phase, text }) });
  ap.engage();
  let acc = 0, frames = 0;
  // HLS: la missione SpaceX si ferma all'allunaggio (nessun orbiter da raggiungere)
  const done = id === 'SPACEX'
    ? (s, a) => s.status === 'TOUCHDOWN' || a.phase === PHASE.DONE
    : (s, a) => a.phase === PHASE.DONE;
  while (!done(sim, ap) && frames < 400000) {
    ap.update();
    acc += warp.current * FR;
    let steps = Math.floor(acc / DT); acc -= steps * DT;
    if (steps > 4000) steps = 4000;
    for (let i = 0; i < steps; i++) { ap.hold(); sim.step(DT); }
    frames++;
  }
  // la pausa sulla superficie (main.js) e il rientro in demo non passano da narrate:
  seen.set('F7 COMPLETATA::Superficie lunare raggiunta. Il lander è stabile sulla regolite. Premi barra spaziatrice quando vuoi decollare.',
    { phase: 'F7 COMPLETATA', text: 'Superficie lunare raggiunta. Il lander è stabile sulla regolite. Premi barra spaziatrice quando vuoi decollare.' });
  return { id, status: sim.status, h: (sim.t / 3600).toFixed(1), entries: [...seen.values()], frames };
}

const all = new Map();
if (fs.existsSync(OUT)) { try { for (const e of JSON.parse(fs.readFileSync(OUT, 'utf8')).entries) all.set(e.phase + '::' + e.text, e); } catch (err) { /* si riscrive */ } }
for (const id of WANT) {
  const r = runMission(id);
  for (const e of r.entries) all.set(e.phase + '::' + e.text, e);
  console.log(id + ': ' + r.entries.length + ' messaggi | esito ' + r.status + ' a ' + r.h + ' h | ' + r.frames + ' frame');
}
const entries = [...all.values()].sort((a, b) => (a.phase + a.text).localeCompare(b.phase + b.text));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), missions: WANT.join(','), n: entries.length, entries }, null, 1) + '\n');
console.log('corpus: ' + entries.length + ' messaggi unici -> ' + OUT);
