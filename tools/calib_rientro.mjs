/**
 * Simulatore di INGRESSO per la taratura del rientro (solo sviluppo).
 * Piazza la capsula sopra l'interfaccia con il perigeo reale scelto e integra
 * fino all'ammaraggio, stampando i keyframe in unit\u00e0 REALI.
 *   node tools/calib_rientro.mjs peri=60
 *   node tools/calib_rientro.mjs sweep=20:70:5
 */
import { MISSIONS } from '../data/spacecraft_specs.js';
import { Sim, ATM, hReal, vReal, vSim, hSim } from '../core/physics.js';
import { TimeWarp, ManeuverNode } from '../systems/planner.js';
import { Autopilot, PHASE } from '../systems/autopilot.js';

const P = Object.fromEntries(process.argv.slice(2).filter(a => a.includes('=')).map(a => {
  const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)];
}));
const num = (k, d) => (P[k] !== undefined ? parseFloat(P[k]) : d);
const H_EI = num('hEI', 120e3), V_EI = num('vEI', 11094);
if (P.ClA) ATM.ClA = +P.ClA;
if (P.CdA) MISSIONS.CNSA.returnModule.CdA = +P.CdA;
if (P.drogueH) ATM.drogueH = +P.drogueH;
if (P.mainH) ATM.mainH = +P.mainH;

function runOnce(periRealKm) {
  const sim = new Sim(MISSIONS.CNSA);
  const warp = new TimeWarp(), node = new ManeuverNode();
  const log = [];
  const ap = new Autopilot(sim, { warp, node, narrate: (text, phase) => log.push({ t: sim.t, phase, text }) });
  sim.smJettisoned = true;
  sim.stageIndex = sim.stages.length - 1;
  const st = sim.activeStage; st.dryMass = 5600; st.propellant = 0; st.groups = [];
  const A = sim.astro, R = A.earth.radius, GM = A.earth.GM;
  const r0 = R + hSim(H_EI), v = vSim(V_EI);
  const a = -GM / (v * v - 2 * GM / r0);
  const e = 1 - (R + hSim(periRealKm * 1e3)) / a;
  const p = a * (1 - e * e);
  const nu = -Math.acos(Math.max(-1, Math.min(1, (p / r0 - 1) / e)));
  const h = Math.sqrt(GM * p);
  sim.ship.x = r0; sim.ship.y = 0;
  sim.ship.vx = (GM / h) * e * Math.sin(nu); sim.ship.vy = h / r0;
  sim.t = 3600 * 39;
  const gamma = Math.atan2(sim.ship.vx, sim.ship.vy) * 180 / Math.PI;
  ap.active = true;   // hold() è gated su active: senza, la portanza non viene mai comandata
  ap.enter(PHASE.RIENTRO);
  const DT = 0.1;
  let t = 0, wasAtm = false, prevStage = null;
  const kf = { gamma };
  while (sim.status === 'NOMINAL' && t < 2400) {
    ap.hold();
    if (P.law === 'pullup') {
      // guida a "galoppo": immersione libera, cabrata (bank 1) sotto hSkip; dopo
      // lo skip il secondo ingresso e' balistico puro
      const rE = Math.hypot(sim.ship.x, sim.ship.y), altE = rE - sim.astro.earth.radius;
      const vUp = (sim.ship.vx * sim.ship.x + sim.ship.vy * sim.ship.y) / rE;
      const inA = altE < ATM.top && altE > 0;
      const skipped = ap.rientro && ap.rientro.skipped;
      sim.bank = (!skipped && inA && vUp < 0 && hReal(altE) < num('hSkip', 40) * 1e3) ? 1 : 0;
    }
    sim.step(DT); t += DT;
    const alt = Math.hypot(sim.ship.x, sim.ship.y) - sim.astro.earth.radius;
    const vel = Math.hypot(sim.ship.vx, sim.ship.vy);
    const inA = alt < ATM.top && alt > 0;
    if (inA && !wasAtm) { if (!kf.EI) kf.EI = { h: hReal(alt), v: vReal(vel), t }; else if (!kf.EI2) kf.EI2 = { h: hReal(alt), v: vReal(vel), t }; }
    if (wasAtm && !inA && !kf.exit) kf.exit = { h: hReal(alt), v: vReal(vel), t };
    wasAtm = inA;
    if (sim.chuteStage !== prevStage) {
      prevStage = sim.chuteStage;
      if (prevStage === 'drogue') kf.drogue = { h: hReal(alt), v: vReal(vel), t };
      if (prevStage === 'main') kf.main = { h: hReal(alt), v: vReal(vel), t };
    }
    if (sim.status !== 'NOMINAL') { kf.end = { status: sim.status, v: vReal(vel), t }; break; }
  }
  if (!kf.end) kf.end = { status: 'TIMEOUT', v: 0, t };
  return { kf, gMax: sim.gMax, ingressi: sim.atmIngressi, end: kf.end, log };
}

const f = (e) => e ? ((e.h ?? 0).toFixed(0).padStart(6) + ' m  ' + (e.v ?? 0).toFixed(0).padStart(5) + ' m/s') : '     MAI';
const show = (pk, r) => {
  const k = r.kf;
  console.log('peri=' + pk + ' km  gamma_EI=' + (k.EI ? k.gamma.toFixed(2) : '-') + '\u00b0  Gmax=' + r.gMax.toFixed(1) +
    '  ingressi=' + r.ingressi + '  fine=' + r.end.status + ' ' + r.end.v.toFixed(1) + ' m/s');
  for (const kk of ['EI', 'exit', 'EI2', 'drogue', 'main']) console.log('    ' + kk.padEnd(7) + f(k[kk]) + (k[kk] ? '   t+' + ((k[kk].t - (k.EI ? k.EI.t : 0)) / 60).toFixed(1) + ' min' : ''));
  if (k.EI) console.log('    EI\u2192fine ' + ((r.end.t - k.EI.t) / 60).toFixed(1) + ' min');
};

if (P.sweep) {
  const [a, b, s] = P.sweep.split(':').map(parseFloat);
  for (let pk = a; pk <= b + 1e-9; pk += s) show(pk, runOnce(pk));
} else {
  show(num('peri', 60), runOnce(num('peri', 60)));
}
