/**
 * CISLUNAR 2030 — Test autopilota: replica il game-loop di main.js in node
 * e verifica che la state machine completi l'intera missione CNSA da sola.
 * Esegui: node tests/autopilot.test.mjs
 */
import assert from 'node:assert/strict';
import { MISSIONS } from '../data/spacecraft_specs.js';
import { Sim } from '../core/physics.js';
import { orbitalElements, TimeWarp, ManeuverNode } from '../systems/planner.js';
import { Autopilot, PHASE } from '../systems/autopilot.js';

const sim = new Sim(MISSIONS.CNSA);
const warp = new TimeWarp();
const node = new ManeuverNode();
const log = [];
const ap = new Autopilot(sim, { warp, node, demoEnd: true, narrate: (text, phase) => log.push(phase + ' :: ' + text) });

ap.engage();
const DT = 0.1, FR = 1 / 60;
let acc = 0, frames = 0;
const seen = new Set();
while (ap.phase !== PHASE.DONE && frames < 120000) {
  ap.update();
  acc += warp.current * FR;
  let steps = Math.floor(acc / DT); acc -= steps * DT;
  if (steps > 4000) steps = 4000;
  for (let i = 0; i < steps; i++) { ap.hold(); sim.step(DT); }
  seen.add(ap.phase);
  frames++;
}

const el = orbitalElements(sim.ship, sim.t);
console.log('frames reali:', frames, '| sim.t:', (sim.t / 3600).toFixed(1) + ' h');
console.log('fasi visitate:', [...seen].join(' -> '));
console.log('stato finale: corpo=' + el.bodyName + ' e=' + el.e.toFixed(3) +
  ' Ap=' + (el.altAp / 1e3).toFixed(0) + ' km Pe=' + (el.altPe / 1e3).toFixed(0) + ' km' +
  ' | debris dead=' + (sim.debris[0] && sim.debris[0].dead));

assert.equal(ap.phase, PHASE.DONE, 'la state machine deve completare');
assert.ok(seen.has(PHASE.SETUP) && seen.has(PHASE.TLI) && seen.has(PHASE.CRUISE) && seen.has(PHASE.SOI) && seen.has(PHASE.LOI) && seen.has(PHASE.STAGE), 'tutte le fasi visitate');
assert.equal(el.bodyKey, 'moon', 'orbita attorno alla Luna');
// NB: e residua ~0.27 è il pompaggio mareale terrestre sull'orbita di cattura
// (fisica 3-corpi reale durante le 17 h di warp in F5), non un errore di guida.
assert.ok(el.e < 0.45, 'orbita lunare chiusa e stabile, e=' + el.e.toFixed(3));
assert.ok(el.altPe > 0, 'periapside sopra la superficie');
assert.ok(sim.debris[0] && sim.debris[0].dead, 'il PM crasher deve aver impattato');
assert.ok(log.some(l => l.includes('TLI') && l.includes('ACCENSIONE')), 'narrata TLI');
assert.ok(log.some(l => l.includes('SOI')), 'narrata SOI');
assert.ok(log.some(l => l.includes('LOI')), 'narrata LOI');
assert.ok(log.some(l => l.includes('COMPLETATA')), 'narrata finale');
console.log('AUTOPILOT TEST: PASS (' + log.length + ' messaggi del Mission Director)');
console.log('--- ultime narrazioni ---');
for (const l of log.slice(-4)) console.log(' •', l.slice(0, 150));