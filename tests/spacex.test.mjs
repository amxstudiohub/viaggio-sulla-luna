/**
 * TEST CICLO SPACEX — Starship HLS: TLI → LOI → deorbit → discesa tattica
 * con fault → TOUCHDOWN. (Le fasi post-allunaggio condividono il codice CNSA.)
 * Uso: node tests/spacex.test.mjs
 */
import assert from 'node:assert';
import { MISSIONS } from '../data/spacecraft_specs.js';
import { Sim } from '../core/physics.js';
import { TimeWarp, ManeuverNode } from '../systems/planner.js';
import { Autopilot, PHASE } from '../systems/autopilot.js';

const sim = new Sim(MISSIONS.SPACEX);
const warp = new TimeWarp();
const node = new ManeuverNode();
const log = [];
const ap = new Autopilot(sim, { warp, node, narrate: (t, p) => log.push(p + ' :: ' + t) });
ap.engage();

const DT = 0.1, FR = 1 / 60;
let acc = 0, frames = 0;
const seen = new Set();
while (frames < 900000 && sim.status === 'NOMINAL' && ap.phase !== PHASE.DONE) {
  ap.update(); seen.add(ap.phase);
  acc += warp.current * FR;
  let steps = Math.floor(acc / DT); acc -= steps * DT;
  if (steps > 4000) steps = 4000;
  for (let i = 0; i < steps; i++) { ap.hold(); sim.step(DT); }
  frames++;
}
console.log('fasi:', [...seen].join(' -> '));
console.log('esito:', sim.status, '| t=' + (sim.t / 3600).toFixed(1) + 'h | G max', sim.gMax.toFixed(2));
assert.ok(seen.has(PHASE.DISCESA), 'raggiunta la discesa tattica');
assert.strictEqual(sim.status, 'TOUCHDOWN', 'Starship alluna');
assert.ok(sim.gMax < 6.5, 'G entro il limite');
assert.ok(log.some(l => l.includes('ANOMALIA') && l.includes('Raptor')), 'narrato il fault Raptor');
console.log('SPACEX TEST: PASS');
