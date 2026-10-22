/**
 * CISLUNAR 2030 — Smoke test dei moduli puri (physics + planner).
 * Esegui: node tests/smoke.mjs
 */
import assert from 'node:assert/strict';
import { ASTRO } from '../data/spacecraft_specs.js';
import { Sim, predictTrajectory, moonState } from '../core/physics.js';
import { orbitalElements } from '../systems/planner.js';

let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, name + ' ' + extra);
  console.log('  ✔ ' + name + (extra ? '  (' + extra + ')' : ''));
  passed++;
}

console.log('CISLUNAR 2030 — smoke test');
console.log('Mondo scalato: R_T=' + (ASTRO.earth.radius / 1e3).toFixed(1) + ' km, GM_T=' + ASTRO.earth.GM.toExponential(3) +
  ', a_Luna=' + (ASTRO.distance / 1e3).toFixed(0) + ' km, T_Luna=' + (ASTRO.moonOrbit.period / 86400).toFixed(2) + ' gg, SOI=' + (ASTRO.soiMoon / 1e3).toFixed(0) + ' km');

/* --- 1) RK4: conservazione energia + chiusura orbita circolare --- */
{
  const sim = new Sim({ craft: { stages: [{ dryMass: 1, propellant: 0, groups: [] }] }, initialOrbit: { body: 'earth', altitude: ASTRO.leo.altitude }, boilOffRate: 0, orbiterMarker: null });
  const r = ASTRO.leo.radius;
  const T = 2 * Math.PI * Math.sqrt(r ** 3 / ASTRO.earth.GM);
  const E0 = 0.5 * (sim.ship.vx ** 2 + sim.ship.vy ** 2) - ASTRO.earth.GM / Math.hypot(sim.ship.x, sim.ship.y);
  const p0 = { x: sim.ship.x, y: sim.ship.y };
  const dt = 0.1;
  for (let i = 0; i < Math.round(T / dt); i++) sim.step(dt);
  const E1 = 0.5 * (sim.ship.vx ** 2 + sim.ship.vy ** 2) - ASTRO.earth.GM / Math.hypot(sim.ship.x, sim.ship.y);
  const drift = Math.abs((E1 - E0) / E0);
  const closure = Math.hypot(sim.ship.x - p0.x, sim.ship.y - p0.y);
  ok('RK4 drift energia < 0.1%/periodo', drift < 1e-3, 'drift=' + (drift * 100).toExponential(2) + '%');
  ok('RK4 chiusura orbita (1 periodo)', closure < 100, 'Δ=' + closure.toFixed(1) + ' m su r=' + (r / 1e3).toFixed(0) + ' km');
}

/* --- 2) Tsiolkovsky: consumo massa e Δv --- */
{
  const sim = new Sim({ craft: { stages: [{ dryMass: 20000, propellant: 6000, groups: [{ thrust: 78453, isp: 315, minThrottle: 0 }] }] }, initialOrbit: { body: 'earth', altitude: ASTRO.leo.altitude }, boilOffRate: 0, orbiterMarker: null });
  sim.ship.x = 5e8; sim.ship.y = 0; sim.ship.vx = 0; sim.ship.vy = 0; // quasi zero-g
  sim.ship.attitude = 0; sim.setThrottle(1);
  const m0 = sim.mass, prop0 = sim.stages[0].propellant;
  const burnT = 100;
  for (let i = 0; i < burnT / 0.1; i++) sim.step(0.1);
  const dmExpected = (78453 * burnT) / (315 * 9.80665);
  const dmActual = prop0 - sim.stages[0].propellant;
  ok('Tsiolkovsky: dm = T·t/(Isp·g0)', Math.abs(dmActual - dmExpected) / dmExpected < 1e-3, dmActual.toFixed(1) + ' vs ' + dmExpected.toFixed(1) + ' kg');
  const ve = 315 * 9.80665;
  const dvExpected = ve * Math.log(m0 / (m0 - dmActual));
  const dvActual = Math.hypot(sim.ship.vx, sim.ship.vy);
  ok('Tsiolkovsky: Δv = Isp·g0·ln(m0/mf)', Math.abs(dvActual - dvExpected) / dvExpected < 0.01, dvActual.toFixed(1) + ' vs ' + dvExpected.toFixed(1) + ' m/s');
}

/* --- 3) Elementi orbitali: LEO circolare --- */
{
  const sim = new Sim({ craft: { stages: [{ dryMass: 1, propellant: 0, groups: [] }] }, initialOrbit: { body: 'earth', altitude: ASTRO.leo.altitude }, boilOffRate: 0, orbiterMarker: null });
  const el = orbitalElements(sim.ship, sim.t);
  ok('Elementi: e ≈ 0 su circolare', el.e < 1e-4, 'e=' + el.e.toExponential(2));
  ok('Elementi: Pe ≈ Ap ≈ quota LEO', Math.abs(el.altPe - ASTRO.leo.altitude) < 5e3 && Math.abs(el.altAp - ASTRO.leo.altitude) < 5e3,
    'Pe=' + (el.altPe / 1e3).toFixed(1) + ' km Ap=' + (el.altAp / 1e3).toFixed(1) + ' km');
  ok('Elementi: corpo dominante Terra', el.bodyKey === 'earth');
}

/* --- 4) Predictor: TLI intercetta SOI lunare --- */
{
  const sim = new Sim({ craft: { stages: [{ dryMass: 20000, propellant: 6000, groups: [{ thrust: 78453, isp: 315, minThrottle: 0 }] }] }, initialOrbit: { body: 'earth', altitude: ASTRO.leo.altitude }, boilOffRate: 0, orbiterMarker: null });
  sim.applyProgradeDv(1000); // TLI scalata
  const pred = predictTrajectory(sim, { steps: 600 });
  ok('Predictor: TLI → ingresso SOI lunare', !!pred.events.soiEntry,
    pred.events.soiEntry ? 'T+' + (pred.points[pred.events.soiEntry.i].t / 3600).toFixed(1) + ' h' : 'nessun evento');
}

/* --- 5) Predictor: impatto rilevato (periapside sotto superficie) --- */
{
  const sim = new Sim({ craft: { stages: [{ dryMass: 20000, propellant: 6000, groups: [{ thrust: 78453, isp: 315, minThrottle: 0 }] }] }, initialOrbit: { body: 'earth', altitude: ASTRO.leo.altitude }, boilOffRate: 0, orbiterMarker: null });
  sim.applyProgradeDv(-300); // deorbit burn
  const pred = predictTrajectory(sim, { steps: 600, dt: 50 });
  ok('Predictor: impatto Terra rilevato', !!pred.events.impact && pred.events.impact.body === 'earth',
    pred.events.impact ? 'body=' + pred.events.impact.body : 'nessun impatto');
}

/* --- 6) Maneuver node: anteprima cambia la predizione --- */
{
  const sim = new Sim({ craft: { stages: [{ dryMass: 20000, propellant: 6000, groups: [{ thrust: 78453, isp: 315, minThrottle: 0 }] }] }, initialOrbit: { body: 'earth', altitude: ASTRO.leo.altitude }, boilOffRate: 0, orbiterMarker: null });
  // NB: node a T+30 s (non T+100: 100 s ≈ 21° di fase in LEO, fuori finestra)
  const base = predictTrajectory(sim, { steps: 600 });
  const withNode = predictTrajectory(sim, { steps: 600, node: { time: sim.t + 30, dv: 1000 } });
  ok('Maneuver node: anteprima SOI solo col node', !base.events.soiEntry && !!withNode.events.soiEntry);
}

/* --- 7) Sanity: posizione lunare coerente --- */
{
  const m0 = moonState(0), m1 = moonState(ASTRO.moonOrbit.period);
  const d = Math.hypot(m0.x - m1.x, m0.y - m1.y);
  ok('Luna: periodo chiude orbita', d < 1, 'Δ=' + d.toFixed(3) + ' m');
}

console.log('TUTTI I TEST PASSATI: ' + passed + '/' + passed);
