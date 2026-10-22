/**
 * CISLUNAR 2030 — Test FASE 2 end-to-end: l'autopilota completa DA SOLO
 * l'intera missione: TLI -> LOI -> stage -> discesa tattica (fault incluso)
 * -> allunaggio -> ascesa -> rendezvous/docking -> TEI -> skip re-entry
 * -> paracadute -> SPLASHDOWN.
 * Esegui: node tests/phase2.test.mjs
 */
import assert from 'node:assert/strict';
import { MISSIONS } from '../data/spacecraft_specs.js';
import { Sim } from '../core/physics.js';
import { TimeWarp, ManeuverNode } from '../systems/planner.js';
import { Autopilot, PHASE } from '../systems/autopilot.js';

const sim = new Sim(MISSIONS.CNSA);
const warp = new TimeWarp();
const node = new ManeuverNode();
const log = [];
const ap = new Autopilot(sim, { warp, node, narrate: (text, phase) => log.push(phase + ' :: ' + text) });

ap.engage();
const DT = 0.1, FR = 1 / 60;
let acc = 0, frames = 0;
const seen = new Set();
const statuses = new Set();
let lastStatus = sim.status;
while (ap.phase !== PHASE.DONE && frames < 400000) {
  ap.update();
  acc += warp.current * FR;
  let steps = Math.floor(acc / DT); acc -= steps * DT;
  if (steps > 4000) steps = 4000;
  for (let i = 0; i < steps; i++) { ap.hold(); sim.step(DT); }
  seen.add(ap.phase);
  if (sim.status !== lastStatus) { statuses.add(sim.status); lastStatus = sim.status; }
  frames++;
}

console.log('frames:', frames, '| sim.t:', (sim.t / 3600).toFixed(1), 'h | status:', sim.status);
console.log('fasi visitate:', [...seen].join(' -> '));
console.log('transizioni di stato:', [...statuses].join(', '));
console.log('G max:', sim.gMax.toFixed(2), '| propellente LM residuo:', (sim.activeStage.propellant / 1e3).toFixed(2), 't');

assert.equal(ap.phase, PHASE.DONE, 'state machine completata');
assert.equal(sim.status, 'SPLASHDOWN', 'ammaraggio raggiunto, invece: ' + sim.status);
assert.ok(statuses.has('TOUCHDOWN'), 'allunaggio avvenuto');
assert.ok(statuses.has('DOCKED'), 'aggancio con Mengzhou avvenuto');
for (const p of [PHASE.DESAT, PHASE.DISCESA, PHASE.ASCESA, PHASE.RENDEZVOUS, PHASE.TEI, PHASE.RIENTRO]) {
  assert.ok(seen.has(p), 'fase visitata: ' + p);
}
assert.ok(sim.gMax < 6.5, 'limite G equipaggio rispettato, gMax=' + sim.gMax.toFixed(2));
assert.ok(log.some(l => l.includes('TOUCHDOWN')), 'narrata discesa');
assert.ok(log.some(l => l.includes('ANOMALIA')), 'narrato il fault diagonale YF-36');
assert.ok(log.some(l => l.includes('DOCKED')), 'narrato il docking');
assert.ok(log.some(l => l.includes('SKIP RIUSCITO')), 'narrato lo skip atmosferico');
assert.ok(log.some(l => l.includes('AMMARAGGIO')), 'narrato lammaraggio');
console.log('PHASE2 TEST: PASS (' + log.length + ' messaggi del Mission Director)');
console.log('--- ultime narrazioni ---');
for (const l of log.slice(-5)) console.log(' •', l.slice(0, 160));
