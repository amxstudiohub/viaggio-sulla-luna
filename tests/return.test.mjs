/**
 * CISLUNAR 2030 — Test del RITORNO (F10 TEI → F11 crociera → F12 rientro →
 * F13 ammaraggio). Verifica i KEYFRAME fisici in unità REALI: è il contratto
 * della scala (h_reale = h_sim × 10, v_reale = v_sim × √10).
 * Esegui: node tests/return.test.mjs
 */
import assert from 'node:assert/strict';
import { MISSIONS } from '../data/spacecraft_specs.js';
import { Sim, ATM, hReal, vReal } from '../core/physics.js';
import { TimeWarp, ManeuverNode } from '../systems/planner.js';
import { Autopilot, PHASE } from '../systems/autopilot.js';

const sim = new Sim(MISSIONS.CNSA);
const warp = new TimeWarp();
const node = new ManeuverNode();
const log = [];
const ap = new Autopilot(sim, { warp, node, narrate: (text, phase) => log.push({ t: sim.t, phase, text }) });

ap.engage();
const DT = 0.1, FR = 1 / 60;
let acc = 0, frames = 0, wasAtm = false, prevStage = null, prevStatus = sim.status;
const kf = {};

while (ap.phase !== PHASE.DONE && frames < 600000) {
  ap.update();
  acc += warp.current * FR;
  let steps = Math.floor(acc / DT); acc -= steps * DT;
  if (steps > 4000) steps = 4000;
  for (let i = 0; i < steps; i++) {
    ap.hold(); sim.step(DT);
    const altE = Math.hypot(sim.ship.x, sim.ship.y) - sim.astro.earth.radius;
    const v = Math.hypot(sim.ship.vx, sim.ship.vy);
    const inAtm = altE < ATM.top && altE > 0;
    if (inAtm && !wasAtm) { if (!kf.EI) kf.EI = { t: sim.t, h: hReal(altE), v: vReal(v), f: frames }; else if (!kf.EI2) kf.EI2 = { t: sim.t, h: hReal(altE), v: vReal(v), f: frames }; }
    wasAtm = inAtm;
    if (sim.chuteStage !== prevStage) {
      prevStage = sim.chuteStage;
      if (sim.chuteStage === 'drogue') kf.drogue = { t: sim.t, h: hReal(altE), v: vReal(v) };
      if (sim.chuteStage === 'main') kf.main = { t: sim.t, h: hReal(altE), v: vReal(v) };
    }
    if (sim.smJettisoned && !kf.sm) kf.sm = { t: sim.t, h: hReal(altE) };
    if (sim.status !== prevStatus && sim.status === 'SPLASHDOWN') kf.splash = { t: sim.t, h: 0, v: vReal(v), f: frames };
    prevStatus = sim.status;
  }
  frames++;
}

const min = (s) => (s / 60).toFixed(1);
console.log('stato finale:', sim.status, '| fase:', ap.phase, '| t:', (sim.t / 3600).toFixed(2), 'h');
for (const k of ['sm', 'EI', 'EI2', 'drogue', 'main', 'splash']) {
  const e = kf[k];
  console.log('  ' + k.padEnd(7), e ? ('h ' + e.h.toFixed(0).padStart(7) + ' m | v ' + (e.v ?? 0).toFixed(0).padStart(6) + ' m/s | t ' + (e.t / 3600).toFixed(2) + ' h') : 'MAI');
}
console.log('  G max:', sim.gMax.toFixed(2), '| ingressi in atmosfera:', sim.atmIngressi);
if (kf.EI && kf.splash) console.log('  EI→ammaraggio:', min(kf.splash.t - kf.EI.t), 'min reali');

assert.equal(sim.status, 'SPLASHDOWN', 'ammaraggio raggiunto, invece: ' + sim.status);
assert.ok(sim.smJettisoned, 'sgancio modulo di servizio avvenuto');
assert.ok(kf.sm && kf.EI && kf.sm.t < kf.EI.t, "lo SM si sgancia prima dell'interfaccia");
assert.ok(sim.atmIngressi <= 2, 'al massimo UN rimbalzo atmosferico (ingressi: ' + sim.atmIngressi + ')');
assert.ok(kf.EI.v > 10400 && kf.EI.v < 11600, 'EI a ~11 km/s reali, invece ' + kf.EI.v.toFixed(0));
assert.ok(kf.drogue, 'droga aperta');
assert.ok(kf.drogue.h > 6100 && kf.drogue.h < 9100, 'droga a 7,6 km reali ±1,5: ' + kf.drogue.h.toFixed(0));
assert.ok(kf.drogue.v < 520, 'droga sotto 520 m/s reali: ' + kf.drogue.v.toFixed(0));
assert.ok(kf.main, 'principali aperti');
assert.ok(kf.main.h > 2000 && kf.main.h < 4000, 'principali a 3 km reali ±1: ' + kf.main.h.toFixed(0));
assert.ok(kf.main.v < 140, 'principali sotto 140 m/s reali: ' + kf.main.v.toFixed(0));
assert.ok(kf.splash.v > 0 && kf.splash.v <= 12, 'ammaraggio a ~8,5 m/s reali, invece ' + kf.splash.v.toFixed(1));
assert.ok(sim.gMax <= 8, 'G max <= 8, invece ' + sim.gMax.toFixed(2));
const realSec = (kf.splash.f - kf.EI.f) / 60;
console.log('  scena EI→ammaraggio:', realSec.toFixed(0), 's REALI (warp dell\u0027autopilota)');
assert.ok(realSec <= 240, 'scena terminale <= 4 min reali, invece ' + realSec.toFixed(0) + ' s');
assert.ok(kf.splash.t - kf.EI.t <= 45 * 60, 'EI→ammaraggio <= 45 min simulati: ' + min(kf.splash.t - kf.EI.t));

const dup = [];
for (let i = 1; i < log.length; i++) {
  if (log[i].text === log[i - 1].text && log[i].t - log[i - 1].t < 60) dup.push(log[i].text.slice(0, 50));
}
assert.equal(dup.length, 0, 'nessuna narrazione ripetuta a meno di 60 s: ' + dup.join(' | '));
for (const key of ['F11', 'F12', 'F13']) {
  assert.ok(log.some(l => l.phase.startsWith(key)), 'almeno una riga narrata per ' + key);
}
console.log('righe narrate F10-F13:', log.filter(l => /^F1[0-3]/.test(l.phase)).length);
for (const l of log.filter(l => /Corridoio|RICHIAMO|SKIP RIUSCITO/.test(l.text))) console.log('   ·', l.text.slice(0, 130));
console.log('RITORNO OK');
