import { MISSIONS, ASTRO } from './data/spacecraft_specs.js';
import { Sim, predictTrajectory, progradeUnit, moonState, hSim, vSim } from './core/physics.js';
import { orbitalElements, TimeWarp, ManeuverNode } from './systems/planner.js';
import { Autopilot, PHASE } from './systems/autopilot.js';
import { AudioComms } from './systems/audio_comms.js';
import { Cockpit, Hud } from './ui/cockpit.js';

const DT_PHYS = 0.1;          // passo fisica fisso [s]
const SUBSTEP_CAP = 4000;     // protezione freeze a warp estremi
const PRED_STEPS = 600;       // step predittivi (spec)
const PRED_EVERY = 0.25;      // refresh predizione [s reali]

let sim = null;
let cockpit = null;
let hud = null;
let autopilot = null;
const warp = new TimeWarp();
const audio = new AudioComms();
const jump = { active: false, idx: -1 };
let tlBtns = [];
const node = new ManeuverNode();
let pendingNode = null;       // {time, dv} impegnato (commit), in attesa del tempo
let surfaceHold = false;   // pausa attiva sulla superficie lunare
let surfaceDone = false;   // il hold si arma una sola volta per missione
let pred = null;
let predAcc = 1e9;
let acc = 0;                  // accumulatore substep
let warpLimited = false;
const keys = {};
let lastT = performance.now();

/* ---------------- Missione / reset ---------------- */

function startMission(mission, opts = {}) {
  sim = new Sim(mission);
  window.__sim = sim;   // hook per test headless / console
  warp.i = 0;
  node.clear();
  pendingNode = null;
  pred = null; predAcc = 1e9; acc = 0;
  autopilot = new Autopilot(sim, {
    warp, node,
    narrate: (text, phase) => hud.director(phase, audio.say(text, phase)),
  });
  window.__ap = autopilot; // (dopo la creazione: prima era null)
  window.__jump = (i) => jumpTo(i);
// Dev/test: teletrasporta la capsula all'interfaccia di rientro (120 km, 11,09 km/s,
// perigeo in km REALI) per provare la cinematica terminale senza correre 39 ore.
window.__rientro = (periKm = 57.6) => {
  const A = sim.astro, R = A.earth.radius, GM = A.earth.GM;
  sim.smJettisoned = true;
  sim.stageIndex = sim.stages.length - 1;
  const stg = sim.activeStage;
  if (stg && sim.mission.returnModule) { stg.dryMass = sim.mission.returnModule.mass; stg.propellant = 0; stg.groups = []; }
  const r0 = R + hSim(120e3), v = vSim(11094);
  const a = -GM / (v * v - 2 * GM / r0);
  const ecc = 1 - (R + hSim(periKm * 1e3)) / a;
  const p = a * (1 - ecc * ecc);
  const nu = -Math.acos(Math.max(-1, Math.min(1, (p / r0 - 1) / ecc)));
  const h = Math.sqrt(GM * p);
  sim.ship.x = r0; sim.ship.y = 0;
  sim.ship.vx = (GM / h) * ecc * Math.sin(nu); sim.ship.vy = h / r0;
  if (!autopilot.active) toggleAutopilot();
  autopilot.enter(PHASE.RIENTRO);
  return 'EI gamma ' + (Math.atan2(sim.ship.vx, sim.ship.vy) * 180 / Math.PI).toFixed(2) + '\u00b0';
};
  window.__jumpNext = () => jumpNext();
  window.__step = () => stepIndex();   // indice di fase corrente (tool di test)
  window.__audio = audio;
  audio.onMiss = (why) => { if (sim) sim.log('RADIO: ' + why, 'warn'); };
  window.__render = () => {
    const el = orbitalElements(sim.ship, sim.t);
    const ui = { dtReal: 1 / 60, warp: warp.current, warpLimited: false, node, el,
      accent: sim.mission.accent, site: autopilot && autopilot.site ? autopilot.site : null };
    cockpit.render(sim, el, null, ui);
    hud.update(sim, el, null, ui);
  };
  if (cockpit) {
    cockpit.setCamera('ship');
    const q = new URLSearchParams(location.search);
    const sc = parseFloat(q.get('scale'));
    cockpit.cam.targetScale = cockpit.cam.scale = Number.isFinite(sc) && sc > 0 ? sc : 3e-5;
  }
  document.getElementById('selector').style.display = 'none';
  jump.active = false; audio.muted = false; surfaceHold = false; surfaceDone = false;
  audio.stop();   // ripulisce la radio della missione precedente
  const q0 = new URLSearchParams(location.search);
  const wantAct0 = (opts.act0 && q0.get('auto') !== '1') || q0.get('act0') === '1';
  if (wantAct0 && cockpit.cine.els) {
    document.getElementById('hud').style.display = 'none';
    document.getElementById('timeline').style.display = 'none';
    cockpit.startAct0(mission.id, act0Event);
    return; // il loop congela la sim finché cockpit.act0 è attivo
  }
  document.getElementById('hud').style.display = 'block';
  document.getElementById('timeline').style.display = 'flex';
  sim.log('START — ' + mission.vehicle + ' in LEO scalata (' + Math.round(ASTRO.leo.v) + ' m/s)', 'info');
  // test/headless: ?tli=1000 applica un burn prograde nominale subito dopo il start
  const tli = parseFloat(new URLSearchParams(location.search).get('tli'));
  if (Number.isFinite(tli) && tli !== 0) { sim.applyProgradeDv(tli); sim.log('TLI nominale +' + tli + ' m/s (auto)', 'success'); }
  if (new URLSearchParams(location.search).get('auto') === '1') toggleAutopilot();
}

/* ---------------- Atto 0: lancio verticale ---------------- */

const ACT0_LINES = {
  PAD_GO: ['Torre aperta, meteo verde. Sequenza automatica avviata: T meno dieci.', 'ATTO 0 — LANCIO'],
  T4: ['Quattro, tre, due, uno.', 'ATTO 0 — LANCIO'],
  IGNITION: ['Accensione. Spinta al cento percento.', 'ATTO 0 — LANCIO'],
  LIFTOFF: ['Il razzo lascia la rampa! Velocità verticale nominale, torre libera.', 'ATTO 0 — LANCIO'],
  MAXQ: ['Max-Q. Pressione dinamica al picco, motore all\u002780 percento.', 'ATTO 0 — LANCIO'],
  MECO: ['Spegnimento motori primo stadio. MECO.', 'ATTO 0 — LANCIO'],
  STAGE: ['Separazione confermata. Il booster si allontana.', 'ATTO 0 — LANCIO'],
  SES: ['Accensione secondo stadio. Via verso l\u0027orbita.', 'ATTO 0 — LANCIO'],
  SECO: ['Seconda accensione completata. Iniezione orbitale raggiunta: 2461 metri al secondo. Benvenuti in LEO.', 'ATTO 0 — LANCIO'],
};
function act0Event(name) {
  const L = ACT0_LINES[name];
  if (!L) return;
  audio.say(L[0], L[1]);
  sim.log('ATTO 0 — ' + name, 'info');
}
function finishAct0() {
  cockpit.endAct0();
  document.getElementById('hud').style.display = 'block';
  document.getElementById('timeline').style.display = 'flex';
  document.getElementById('director').style.display = 'block';
  sim.log('LEO raggiunta — ' + Math.round(ASTRO.leo.v) + ' m/s a 246 km', 'success');
  hud.director('ATTO 1 — ORBITA', audio.say('Orbita terrestre bassa raggiunta. Da qui in poi, la missione.', 'ATTO 1 — ORBITA'));
}

/* ---------------- Autopilot ---------------- */

function toggleAutopilot() {
  if (!sim || sim.status !== 'NOMINAL') return;
  const btn = document.getElementById('autopilot-btn');
  if (autopilot.active) { autopilot.disengage('pulsante/tasto V'); if (btn) btn.classList.remove('active'); }
  else {
    autopilot.engage();
    document.getElementById('director').style.display = 'block';
    if (btn) btn.classList.add('active');
  }
}

function updateRadio() {
  const b = document.getElementById('radio-btn');
  if (!b) return;
  b.innerHTML = (audio.lang === 'mute' ? '&#128263; RADIO: MUTE' : '&#128266; RADIO: ' + audio.label());
  b.classList.toggle('mute', audio.lang === 'mute');
}

/* ---------------- Timeline fasi + Jump (fast-forward sincrono) ---------------- */

function altEarth() { return Math.hypot(sim.ship.x, sim.ship.y) - sim.astro.earth.radius; }
function altMoon() {
  const mo = moonState(sim.t, sim.astro);
  return Math.hypot(sim.ship.x - mo.x, sim.ship.y - mo.y) - sim.astro.moon.radius;
}

const JUMPS = [
  { label: '1. TLI', reached: () => autopilot.phase === PHASE.TLI },
  { label: '2. LOI Capture', reached: () => autopilot.phase === PHASE.LOI },
  { label: '3. Powered Descent', reached: () => autopilot.phase === PHASE.DISCESA },
  { label: '4. Touchdown & Ascent', reached: () => sim.status === 'TOUCHDOWN' || autopilot.phase === PHASE.ASCESA },
  { label: '5. Rendezvous', reached: () => sim.status === 'DOCKED' || autopilot.phase === PHASE.RENDEZVOUS },
  { label: '6. Trans-Earth Injection', reached: () => autopilot.phase === PHASE.TEI },
  { label: '7. Coast & SM Jettison', reached: () => autopilot.phase === PHASE.CRUCIERA || sim.smJettisoned },
  { label: '8. Skip Re-entry', reached: () => { const a = altEarth(); return a < 9e3 && a > 0 && sim.status === 'NOMINAL'; } },
  { label: '9. Splashdown', reached: () => sim.status === 'SPLASHDOWN' },
];

function stepIndex() {
  const p = autopilot.phase;
  if (sim.status === 'SPLASHDOWN' || p === PHASE.DONE) return 8;
  if (p === PHASE.AMMARAGGIO || p === PHASE.RIENTRO) return 7;
  if (p === PHASE.CRUCIERA) return 6;
  if (p === PHASE.TEI) return 5;
  if (sim.status === 'DOCKED' || p === PHASE.RENDEZVOUS) return 4;
  if (sim.status === 'TOUCHDOWN' || p === PHASE.ASCESA) return 3;
  if (p === PHASE.STAGE || p === PHASE.DESAT || p === PHASE.DISCESA) return 2;
  if (p === PHASE.CRUISE || p === PHASE.SOI || p === PHASE.LOI) return 1;
  return 0;
}

function jumpTo(i) {
  if (!sim || !autopilot || sim.status === 'CRASHED' || sim.status === 'SPLASHDOWN') return;
  if (jump.active) { sim.log('Salto già in corso: ' + JUMPS[jump.idx].label, 'info'); return; }
  // «superata» = il traguardo della fase è alle spalle (stepIndex), non solo «ci sono dentro ora»
  if (JUMPS[i].reached() || stepIndex() > i) { sim.log('Già in/superata: ' + JUMPS[i].label, 'info'); return; }
  if (!autopilot.active) toggleAutopilot();
  if (!autopilot.active) return;
  jump.active = true; jump.idx = i;
  // un salto in avanti non deve restare bloccato dalla pausa sulla superficie lunare
  surfaceHold = false; surfaceDone = true;
  // budget di wall-clock proporzionale alla distanza: un salto dalla partenza fino
  // all'ammaraggio deve poter attraversare tutta la crociera lunare
  jump.deadline = performance.now() + 25000 + Math.max(0, i - stepIndex()) * 24000;
  audio.muted = true;
  audio.stop();          // taglia la voce in onda (clip o TTS che sia)
  hud.director('SALTO FASE', '⏭ SALTO IN CORSO verso ' + JUMPS[i].label + ' — fast-forward della simulazione…');
}

function jumpNext() {
  const i = stepIndex() + 1; // sempre in avanti: mai ri-bersagli fasi già passate
  if (i < JUMPS.length) jumpTo(i);
}

/** Fast-forward sincrono: guida sim+autopilota a budget di wall-clock (come i test). */
function driveJump() {
  const t0 = performance.now();
  while (performance.now() - t0 < 60) { // ~60% del frame: salto rapido ma UI reattiva
    if (JUMPS[jump.idx].reached() || stepIndex() > jump.idx || sim.status === 'CRASHED' || sim.status === 'SPLASHDOWN') { endJump(); return; }
    if (performance.now() > jump.deadline) { sim.log('SALTO interrotto: fase non raggiungibile da qui', 'warn'); endJump(); return; }
    autopilot.update();
    // fasi critiche: warp limitato per non saltare le finestre di trigger (LOI, PDIT, touchdown)
    const p = autopilot.phase;
    const crit = p === PHASE.LOI || p === PHASE.STAGE || p === PHASE.DESAT || p === PHASE.DISCESA || p === PHASE.ASCESA;
    const w = Math.min(warp.current, crit ? 10 : 5000);
    const n = Math.max(1, Math.round(w / 6));
    for (let i = 0; i < n; i++) { autopilot.hold(); sim.step(DT_PHYS); if (sim.status !== 'NOMINAL') break; }
  }
}

function endJump() {
  jump.active = false; audio.muted = false;
  sim.log('SALTO completato — ' + JUMPS[jump.idx].label, 'info');
}

/* ---------------- Input ---------------- */

window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  keys[k] = true;
  audio.ensure(); // primo gesto: sblocca AudioContext
  if (k === 'l') { audio.cycle(); updateRadio(); audio.confirm(); return; }
  if (k === 'k') { cockpit.toggleCine(); return; }
  if (cockpit && cockpit.act0 && (k === ' ' || k === 'n')) { cockpit.act0.t = cockpit.act0.dur; return; }
  if (!sim) {
    if (k === '1') startMission(MISSIONS.CNSA);
    if (k === '2') startMission(MISSIONS.SPACEX);
    return;
  }
  if (k === '0') { startMission(sim.mission); return; }
  if (k === 'v') { toggleAutopilot(); return; }
  if (k === 'f') { sim.faultEngine(); return; } // guasto diagonale 1/4 YF-36
  if (k === 'pageup' || k === 'pagedown') { // warp manuale sempre disponibile (anche in autopilota)
    ev.preventDefault();
    warp[k === 'pageup' ? 'up' : 'down']();
    sim.log('WARP MANUALE — ' + warp.current + 'x', 'info');
    return;
  }
  if (surfaceHold && (k === ' ' || k === 'n')) {
    surfaceHold = false; surfaceDone = true;
    if (autopilot) autopilot.tdWait = sim.t - 1;
    sim.log('COMANDO DECOLLO — F8 ASCESA', 'success');
    return;
  }
  if (k === ' ' || k === 'n') { jumpNext(); return; } // salta alla prossima fase d'azione
  if (sim.status !== 'NOMINAL') return;
  if (autopilot && autopilot.active && [',', '.', '[', ']', 'enter', 'm'].includes(k)) return; // l'auto possiede warp e node
  if (k === ',') warp.down();
  if (k === '.') warp.up();
  if (k === 'x') sim.stage();
  if (k === 'c') sim.setThrottle(0);
  if (k === 'm') {
    if (node.active) node.clear();
    else node.set(sim.t + 60, 0);
  }
  if (k === '[') node.adjust(-10);
  if (k === ']') node.adjust(+10);
  if (k === 't' || k === '+') node.setTime(sim.t + Math.max(60, node.time - sim.t + 60));
  if (k === 'enter' && node.valid) {
    const budget = sim.dvActive;
    const dv = Math.sign(node.dv) * Math.min(Math.abs(node.dv), budget);
    if (Math.abs(node.dv - dv) > 1) sim.log('NODE limitato al Δv disponibile', 'warn');
    pendingNode = { time: Math.max(node.time, sim.t), dv };
    node.clear();
  }
  if (['1', '2', '3'].includes(k)) cockpit.setCamera(k === '1' ? 'earth' : k === '2' ? 'moon' : 'ship');
  if (['w', 'a', 's', 'd', 'p', 'r', ' ', 'arrowup', 'arrowdown'].includes(k)) ev.preventDefault();
});
window.addEventListener('keyup', (ev) => { keys[ev.key.toLowerCase()] = false; });

function handleHeld(dtReal) {
  if (!sim || sim.status !== 'NOMINAL') return;
  if (autopilot && autopilot.active && (keys['w'] || keys['s'] || keys['a'] || keys['d'] || keys['p'] || keys['r'])) {
    autopilot.disengage('input manuale');
    document.getElementById('autopilot-btn').classList.remove('active');
  }
  const rate = dtReal * 60; // normalizzato a 60 fps
  if (keys['w']) sim.setThrottle(sim.ship.throttle + 0.025 * rate);
  if (keys['s']) sim.setThrottle(sim.ship.throttle - 0.025 * rate);
  if (keys['a']) sim.rotate(+0.026 * rate);
  if (keys['d']) sim.rotate(-0.026 * rate);
  if (keys['p'] || keys['r']) {
    const p = progradeUnit(sim.ship.x, sim.ship.y, sim.ship.vx, sim.ship.vy, sim.t);
    const target = keys['r'] ? Math.atan2(-p.y, -p.x) : Math.atan2(p.y, p.x);
    let d = target - sim.ship.attitude;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) > 0.005) sim.rotate(Math.sign(d) * Math.min(Math.abs(d), 0.07 * rate));
  }
}

/* ---------------- Loop ---------------- */

function frame(now) {
  const dtReal = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (sim) {
    if (cockpit && cockpit.act0) {
      cockpit.actFrame(dtReal);
      if (cockpit.act0 && cockpit.act0.done) finishAct0();
      requestAnimationFrame(frame);
      return;
    }
    if (surfaceHold) {
      // pausa attiva: sim congelata, la cinematica di superficie continua ad animare
    } else if (jump.active) {
      driveJump();
    } else {
      if (autopilot && autopilot.active) autopilot.update();
      handleHeld(dtReal);

      // substep: tempo simulato = warp * tempo reale
      acc += dtReal * warp.current;
      let steps = Math.floor(acc / DT_PHYS);
      acc -= steps * DT_PHYS;
      warpLimited = steps > SUBSTEP_CAP;
      if (warpLimited) steps = SUBSTEP_CAP;
      for (let i = 0; i < steps; i++) {
        if (autopilot && autopilot.active) autopilot.hold();
        sim.step(DT_PHYS);
        if (pendingNode && sim.t >= pendingNode.time) {
          const body = sim.applyProgradeDv(pendingNode.dv);
          sim.log('NODE COMMIT — Δv ' + (pendingNode.dv >= 0 ? '+' : '') + pendingNode.dv.toFixed(0) + ' m/s (' + body + ')', 'success');
          pendingNode = null;
        }
      }
      if (pendingNode && pendingNode.time < sim.t - 1) pendingNode = null;
    }
    if (!surfaceHold && !surfaceDone && sim.status === 'TOUCHDOWN' &&
        (cockpit.cine.active || cockpit.forceSurface()) &&
        autopilot && autopilot.phase === PHASE.DISCESA) {
      surfaceHold = true;
      if (jump.active) endJump(); // non congelare un salto in corso dietro la pausa
      autopilot.tdWait = Infinity;
      sim.log('SURFACE HOLD — pausa attiva: premi SPAZIO per il decollo', 'info');
      hud.director('F7 COMPLETATA', audio.say('Superficie lunare raggiunta. Il lander è stabile sulla regolite. Premi barra spaziatrice quando vuoi decollare.', 'F7 COMPLETATA'));
    }
    if (surfaceHold && !cockpit.cine.active) {
      surfaceHold = false; surfaceDone = true;
      if (autopilot) autopilot.tdWait = sim.t - 1;
    }
    audio.tick(sim, altMoon());
    hud.onAir(audio.speaking);
    if (tlBtns.length) {
      const cur = stepIndex();
      tlBtns.forEach((b, i) => {
        b.classList.toggle('active', i === cur && !jump.active);
        b.classList.toggle('done', i < cur || jump.active && i < jump.idx);
      });
    }

    // predizione throttled
    predAcc += dtReal;
    if (predAcc >= PRED_EVERY) {
      predAcc = 0;
      try {
        pred = predictTrajectory(sim, { steps: PRED_STEPS, node: node.asNode });
      } catch (e) { pred = null; }
    }

    const el = orbitalElements(sim.ship, sim.t);
    if (!Number.isFinite(el.r) || !Number.isFinite(el.v)) { sim.log('ANOMALIA stato nave', 'danger'); }
    const ui = { dtReal, warp: warp.current, warpLimited, node, el, accent: sim.mission.accent,
      site: autopilot && autopilot.site ? autopilot.site : null };
    cockpit.render(sim, el, pred, ui);
    hud.update(sim, el, pred, ui);
  }
  requestAnimationFrame(frame);
}

/* ---------------- Avvio ---------------- */

window.addEventListener('DOMContentLoaded', () => {
  cockpit = new Cockpit(document.getElementById('view'));
// Beat del recupero in mare: le narra la cinematica a tempo reale, non la fisica.
const BEATS = [
  'Nave di recupero in vista: la capsula ondeggia a cinquanta metri, il portellone di poppa è aperto.',
  'Elicottero di recupero in discesa: sei metri sopra la capsula, il rotore alza acqua. Nuotatori in mare.',
  'Portello aperto: equipaggio in sicurezza, i quattro taikonauti salutano il ponte di volo.',
  'Missione completata: dalla LEO alla superficie lunare, e ritorno fino al recupero in mare.',
];
cockpit.onBeat = (n) => {
  const b = BEATS[n];
  if (b) hud.director('RECUPERO', audio.say(b, 'RECUPERO'));
};
  window.__cockpit = cockpit;
  hud = new Hud();
  // avvio rapido via URL: ?mission=cnsa | ?mission=spacex (utile per headless/test)
  const q = (new URLSearchParams(location.search).get('mission') || '').toUpperCase();
  if (MISSIONS[q]) { startMission(MISSIONS[q]); }
  // pulsante autopilota (il click non aveva listener: solo tasto V funzionava)
  document.getElementById('autopilot-btn').addEventListener('click', () => { audio.ensure(); toggleAutopilot(); });
  // radio toggle
  document.getElementById('radio-btn').addEventListener('click', () => { audio.ensure(); audio.cycle(); updateRadio(); audio.confirm(); });
  // warp manuale: pulsanti in barra (equivalenti a PagSu/PagGiù)
  const warpBtn = (id, fn) => document.getElementById(id).addEventListener('click', () => { audio.ensure(); fn(); if (sim) sim.log('WARP MANUALE — ' + warp.current + 'x', 'info'); });
  warpBtn('warp-down-btn', () => warp.down());
  warpBtn('warp-up-btn', () => warp.up());
  // timeline fasi cliccabile
  const tl = document.getElementById('timeline');
  JUMPS.forEach((j, i) => {
    if (i) { const ar = document.createElement('span'); ar.className = 'tl-arrow'; ar.textContent = '▸'; tl.appendChild(ar); }
    const b = document.createElement('button');
    b.className = 'tl'; b.textContent = j.label; b.title = 'Salta a: ' + j.label;
    b.addEventListener('click', () => { audio.ensure(); jumpTo(i); });
    tl.appendChild(b); tlBtns.push(b);
  });
  // card selettore
  const sel = document.getElementById('cards');
  for (const id of ['CNSA', 'SPACEX']) {
    const m = MISSIONS[id];
    const card = document.createElement('button');
    card.className = 'card';
    card.style.setProperty('--accent', m.accent);
    card.innerHTML =
      '<div class="card-tag">' + m.agency + '</div>' +
      '<div class="card-title">' + m.label + '</div>' +
      '<div class="card-sub">' + m.vehicle + '</div>' +
      '<div class="card-desc">' + m.description + '</div>' +
      '<div class="card-keys">tasto ' + (id === 'CNSA' ? '1' : '2') + '</div>';
    card.addEventListener('click', () => {
      audio.ensure();
      startMission(m, { act0: document.getElementById('act0-check').checked });
    });
    sel.appendChild(card);
  }
  // qualsiasi primo gesto sblocca l'AudioContext (autoplay policy)
  window.addEventListener('pointerdown', () => audio.ensure(), { once: true });
  document.getElementById('cinematic-viewport').addEventListener('click', () => {
    if (cockpit && cockpit.act0) cockpit.act0.t = cockpit.act0.dur;
  });
  requestAnimationFrame(frame);
});