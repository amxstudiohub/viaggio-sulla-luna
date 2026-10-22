
import { MISSIONS, ASTRO } from '../data/spacecraft_specs.js';
import { Sim, predictTrajectory, moonState } from '../core/physics.js';
import { orbitalElements } from '../systems/planner.js';
const sim = new Sim(MISSIONS.CNSA);
sim.applyProgradeDv(1000);
const DT = 0.1;
let soiAt = null;
for (let i = 0; i < 750000 && !soiAt; i++) {
  sim.step(DT);
  const m = moonState(sim.t);
  if (Math.hypot(m.x - sim.ship.x, m.y - sim.ship.y) < ASTRO.soiMoon) soiAt = sim.t;
}
console.log('1) SOI raggiunta: T+' + (soiAt / 3600).toFixed(1) + ' h');
// attendiamo il periapside lunare (come da architettura: il PM impatta subito dopo la separazione)
for (let i = 0; i < 400000; i++) {
  const m = moonState(sim.t);
  if (Math.hypot(m.x - sim.ship.x, m.y - sim.ship.y) < 3000e3) break;
  sim.step(DT);
}
const mBefore = sim.mass, grpBefore = sim.activeGroup.id;
sim.stage();
console.log('2) STAGE: massa ' + (mBefore / 1e3).toFixed(1) + 't -> ' + (sim.mass / 1e3).toFixed(1) + 't (PM=16t gettato), motori ' + grpBefore + ' -> ' + sim.activeGroup.id);
// il PM esegue la deorbit burn verso la Luna (come da architettura: impatto controllato)
const d = sim.debris[0], mo = moonState(sim.t);
d.vx = mo.vx; d.vy = mo.vy; // deorbit burn: zero velocità relativa -> caduta verso la Luna
for (let i = 0; i < 400000; i++) { sim.step(DT); if (d.dead) break; }
console.log('3) CRASHER: ' + (d.dead ? 'IMPATTO LUNARE ✓ (crash deliberato)' : 'in volo ✗'));
const el = orbitalElements(sim.ship, sim.t);
const pred = predictTrajectory(sim, { steps: 600 });
console.log('4) LM post-stage: ' + sim.status + ', v_luna=' + el.v.toFixed(0) + ' m/s, pred=' + (pred.events.impact ? 'impatto ' + pred.events.impact.body : 'in SOI/valida'));
console.log('5) Δv LM residuo: ' + sim.dvActive.toFixed(0) + ' m/s (YF-36 x4, 6000 kg)');
const ok = soiAt && sim.activeGroup.id === 'LM_YF36' && d.dead && sim.status === 'NOMINAL';
console.log(ok ? 'INTEGRAZIONE CNSA: PASS' : 'INTEGRAZIONE CNSA: FAIL');
process.exit(ok ? 0 : 1);
