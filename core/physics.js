/**
 * CISLUNAR 2030 — Motore orbitale (core/physics.js)
 * ==================================================
 * PROBLEMA RISTRETTO DEI 3 CORPI: Terra (fissa all'origine) + Luna
 * (orbita circolare, moto analitico theta(t) = theta0 + omega*t) + astronave
 * (punto materiale con spinta). Trascurata la mutua influenza nave-corpi.
 *
 * INTEGRATORE: Runge-Kutta 4° ordine (RK4) sul vettore di stato [x, y, vx, vy]
 * con accelerazione tempo-dipendente (la Luna si muove durante lo step).
 *
 * PROPULSIONE: equazione di Tsiolkovsky implementata in forma differenziale:
 *   dm/dt = -T/(Isp*g0)   ;   a = T/m lungo l'attitudine
 * con consumo dinamico della massa e engine-out a propellente esaurito.
 */

import { ASTRO, G0 } from '../data/spacecraft_specs.js';
import { terrainHeight } from '../systems/terrain.js';

/* ---------------- Corpi celesti ---------------- */

export function moonState(t, astro = ASTRO) {
  const { radius, omega, startAngle } = astro.moonOrbit;
  const a = startAngle + omega * t;
  const c = Math.cos(a), s = Math.sin(a);
  return {
    x: radius * c, y: radius * s,
    vx: -omega * radius * s, vy: omega * radius * c,
    GM: astro.moon.GM, radius: astro.moon.radius, name: astro.moon.name,
  };
}

export function earthState(astro = ASTRO) {
  return { x: 0, y: 0, vx: 0, vy: 0, GM: astro.earth.GM, radius: astro.earth.radius, name: astro.earth.name };
}

/** Accelerazione gravitazionale Terra + Luna mobile (ristretto dei 3 corpi). */
export function gravityAt(x, y, t, astro = ASTRO) {
  let ax = 0, ay = 0;
  // Terra
  const re2 = x * x + y * y;
  const re = Math.sqrt(re2);
  const ke = astro.earth.GM / (re2 * re);
  ax -= ke * x; ay -= ke * y;
  // Luna
  const m = moonState(t, astro);
  const dx = m.x - x, dy = m.y - y;
  const rm2 = dx * dx + dy * dy;
  const rm = Math.sqrt(rm2);
  const km = m.GM / (rm2 * rm);
  ax += km * dx; ay += km * dy;
  return { ax, ay };
}

/* ---------------- Integratore RK4 ---------------- */

/**
 * Un passo RK4 su [x,y,vx,vy]. accel(x,y,t) -> {ax,ay}.
 * La dipendenza temporale esplicita (Luna mobile) e' valutata
 * a t, t+dt/2, t+dt come richiesto dalla teoria RK4.
 */
export function rk4Step(s, dt, accel) {
  const f = (st) => {
    const a = accel(st.x, st.y, st.t);
    return { x: st.vx, y: st.vy, vx: a.ax, vy: a.ay };
  };
  const add = (st, k, h) => ({
    x: st.x + k.x * h, y: st.y + k.y * h,
    vx: st.vx + k.vx * h, vy: st.vy + k.vy * h, t: st.t + h,
  });
  const k1 = f(s);
  const k2 = f(add(s, k1, dt / 2));
  const k3 = f(add(s, k2, dt / 2));
  const k4 = f(add(s, k3, dt));
  return {
    x:  s.x  + (dt / 6) * (k1.x  + 2 * k2.x  + 2 * k3.x  + k4.x),
    y:  s.y  + (dt / 6) * (k1.y  + 2 * k2.y  + 2 * k3.y  + k4.y),
    vx: s.vx + (dt / 6) * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx),
    vy: s.vy + (dt / 6) * (k1.vy + 2 * k2.vy + 2 * k3.vy + k4.vy),
  };
}

/* ---------------- Atmosfera terrestre (mondo scalato) ---------------- */

/**
 * Atmosfera semplificata per il rientro: densità esponenziale con quota di
 * scala H e top a 10 km scalati (= 100 km reali). CdA/ClA sono coefficienti
 * balistici di gioco tarati per far funzionare lo skip re-entry alla
 * velocità scalata (~3.5 km/s), con paracadute impliciti sotto i 5 km.
 */
export const ATM = { top: 10e3, rho0: 0.03, H: 2.0e3, CdA: 10, ClA: 30 };

/* ---------------- Utilità cinematiche ---------------- */

/** Unit vector prograde rispetto al corpo dominante (Luna intra-SOI, else Terra). */
export function progradeUnit(x, y, vx, vy, t, astro = ASTRO) {
  const m = moonState(t, astro);
  const dmx = m.x - x, dmy = m.y - y;
  const inMoon = Math.hypot(dmx, dmy) < astro.soiMoon;
  const rvx = inMoon ? vx - m.vx : vx;
  const rvy = inMoon ? vy - m.vy : vy;
  const n = Math.hypot(rvx, rvy) || 1;
  return { x: rvx / n, y: rvy / n, body: inMoon ? 'moon' : 'earth' };
}

export function altitudeAboveNearest(x, y, t, astro = ASTRO) {
  const dE = Math.hypot(x, y) - astro.earth.radius;
  const m = moonState(t, astro);
  const dM = Math.hypot(m.x - x, m.y - y) - astro.moon.radius;
  return Math.min(dE, dM);
}

/* ---------------- Simulazione ---------------- */

export class Sim {
  constructor(mission, astro = ASTRO) {
    this.astro = astro;
    this.mission = mission;
    this.t = 0;
    this.events = [];            // log {t, text, kind}
    this.debris = [];            // stadi gettati (crasher)
    this.trail = [];             // scia nave [{x,y}]
    this._lastTrail = -1e9;
    this._engineOut = false;
    this.status = 'NOMINAL';     // NOMINAL | CRASHED | TOUCHDOWN | DOCKED | SPLASHDOWN
    this.bank = 0;               // frazione portanza "up" (0..1) per lo skip
    this.thrustFactor = 1;       // 0.5 = engine-out diagonale (2 motori su 4)
    this.gLoad = 0; this.gMax = 0;
    this.landed = null;          // offset rigido dalla Luna quando TOUCHDOWN
    this.chutes = false;

    // stato nave
    const r = astro.earth.radius + mission.initialOrbit.altitude;
    const v = Math.sqrt(astro.earth.GM / r);
    this.ship = { x: r, y: 0, vx: 0, vy: v, attitude: Math.PI / 2, throttle: 0 };
    this.stages = mission.craft.stages.map(s => ({ ...s, groups: s.groups.map(g => ({ ...g })) }));
    this.stageIndex = 0;

    // marcatore orbiter (Mengzhou) — solo decorativo/AI
    if (mission.orbiterMarker) {
      const om = mission.orbiterMarker;
      this.orbiter = { ...om, r: astro.moon.radius + om.altitude, angle: 0.6,
        omega: Math.sqrt(astro.moon.GM / (astro.moon.radius + om.altitude) ** 3) };
    } else this.orbiter = null;
  }

  /** Posizione/velocità del marker Mengzhou in orbita lunare. */
  orbiterPos() {
    const o = this.orbiter; if (!o) return null;
    const m = moonState(this.t, this.astro);
    const c = Math.cos(o.angle), s = Math.sin(o.angle);
    return {
      x: m.x + o.r * c, y: m.y + o.r * s,
      vx: m.vx - o.omega * o.r * s, vy: m.vy + o.omega * o.r * c,
    };
  }

  log(text, kind = 'info') { this.events.push({ t: this.t, text, kind }); if (this.events.length > 40) this.events.shift(); }

  get activeStage() { return this.stages[this.stageIndex]; }

  /** Gruppo motori attivo: primo gruppo i cui vincoli (quota) sono soddisfatti
   *  E la cui spinta può reggere il peso locale (i RCS anti-plume dell'HLS da 240 kN
   *  non sostengono 680 t: senza questo controllo il veicolo andrebbe in caduta libera
   *  sotto i 100 m — il Raptor resta attivo fino al touchdown). */
  get activeGroup() {
    const alt = altitudeAboveNearest(this.ship.x, this.ship.y, this.t, this.astro);
    const gv = gravityAt(this.ship.x, this.ship.y, this.t, this.astro);
    const need = this.mass * Math.hypot(gv.ax, gv.ay) * 1.05;
    for (const g of this.activeStage.groups) {
      if (g.maxAltitude != null && alt > g.maxAltitude) continue;
      if (g.thrust * this.thrustFactor < need) continue;
      return g;
    }
    return this.activeStage.groups[this.activeStage.groups.length - 1] || null;
  }

  get mass() {
    let m = 0;
    for (let i = this.stageIndex; i < this.stages.length; i++) m += this.stages[i].dryMass + this.stages[i].propellant;
    return m;
  }
  get dryMassRemaining() {
    let m = 0;
    for (let i = this.stageIndex; i < this.stages.length; i++) m += this.stages[i].dryMass;
    return m;
  }
  get propellant() { return this.activeStage.propellant; }
  get propellantTotal() { return this.stages.slice(this.stageIndex).reduce((s, st) => s + st.propellant, 0); }
  get propellantCapacity() { return this.mission.craft.stages.slice(this.stageIndex).reduce((s, st) => s + st.propellant, 0); }

  /** Δv residuo del gruppo attivo (Tsiolkovsky) e totale (stadi rimanenti). */
  get dvActive() {
    const g = this.activeGroup; if (!g || this.activeStage.propellant <= 0) return 0;
    const ve = g.isp * G0, m0 = this.mass, mf = m0 - this.activeStage.propellant;
    return ve * Math.log(m0 / mf);
  }
  get dvTotal() {
    let dv = 0, m = this.mass;
    for (let i = this.stageIndex; i < this.stages.length; i++) {
      const st = this.stages[i]; if (st.propellant <= 0) continue;
      const g = st.groups[st.groups.length - 1];
      dv += g.isp * G0 * Math.log(m / (m - st.propellant));
      m -= st.propellant;
    }
    return dv;
  }

  setThrottle(v) { this.ship.throttle = Math.max(0, Math.min(1, v)); }
  rotate(dRad) { this.ship.attitude += dRad; }

  applyDv(vec) { this.ship.vx += vec.x; this.ship.vy += vec.y; }

  /** Impulso prograde/retrograde firmato (dv>0 prograde). */
  applyProgradeDv(dv) {
    const p = progradeUnit(this.ship.x, this.ship.y, this.ship.vx, this.ship.vy, this.t, this.astro);
    this.applyDv({ x: p.x * dv, y: p.y * dv });
    return p.body;
  }

  /** Separa lo stadio attivo (CNSA: il Modulo Propulsione diventa crasher). */
  stage() {
    if (this.stageIndex >= this.stages.length - 1) return false;
    const st = this.activeStage;
    this.debris.push({
      name: st.name, x: this.ship.x, y: this.ship.y, vx: this.ship.vx, vy: this.ship.vy,
      mass: st.dryMass + st.propellant, trail: [], dead: false,
    });
    this.stageIndex++;
    this.ship.throttle = 0;
    this.log('STAGE — ' + st.name + ' separato (crasher)', 'stage');
    return true;
  }

  /** Un passo di fisica (dt fisso, es. 0.1 s). */
  step(dt) {
    if (this.status === 'TOUCHDOWN') { this._rideMoon(dt); this._stepDebris(dt); return; }
    if (this.status === 'DOCKED') { this._rideOrbiter(dt); this._stepDebris(dt); return; }
    if (this.status !== 'NOMINAL') { this._stepDebris(dt); return; }
    const s = this.ship;

    // --- Propulsione: Tsiolkovsky differenziale ---
    let tax = 0, tay = 0;
    const g = this.activeGroup;
    if (g && s.throttle > 0 && this.activeStage.propellant > 0) {
      const T = g.thrust * s.throttle * this.thrustFactor;
      const m = this.mass;
      const a = T / m;
      tax = a * Math.cos(s.attitude);
      tay = a * Math.sin(s.attitude);
      const dm = Math.min((T * dt) / (g.isp * G0), this.activeStage.propellant);
      this.activeStage.propellant -= dm;
      if (this.activeStage.propellant <= 1e-6 && !this._engineOut) {
        this._engineOut = true; s.throttle = 0;
        this.log('ENGINE-OUT — propellente ' + this.activeStage.name + ' esaurito', 'warn');
      }
    }

    // --- Boil-off criogenico (HLS) ---
    if (this.mission.boilOffRate > 0 && this.activeStage.propellant > 0) {
      this.activeStage.propellant = Math.max(0, this.activeStage.propellant - this.mission.boilOffRate * dt);
    }

    // --- Atmosfera terrestre: drag + portanza (skip re-entry) ---
    const astro = this.astro;
    let dax = 0, day = 0;
    const rE0 = Math.hypot(s.x, s.y);
    const altE0 = rE0 - astro.earth.radius;
    const vNow = Math.hypot(s.vx, s.vy);
    if (altE0 < ATM.top && altE0 > 0) {
      const rho = ATM.rho0 * Math.exp(-altE0 / ATM.H);
      const q = 0.5 * rho * vNow;                        // ½ρv (×v = ½ρv²)
      const m = this.mass;
      const aD = q * ATM.CdA / m;
      dax -= aD * s.vx; day -= aD * s.vy;                // drag opposto a v
      if (this.bank > 0) {
        const ux = s.x / rE0, uy = s.y / rE0;            // radiale "up"
        let lx = -s.vy / (vNow || 1), ly = s.vx / (vNow || 1);
        if (lx * ux + ly * uy < 0) { lx = -lx; ly = -ly; }
        const aL = q * ATM.ClA * this.bank * vNow / m; // ×v: portanza ~ ½ρv²·ClA/m
        dax += aL * lx; day += aL * ly;                  // portanza perpendicolare a v
      }
    }
    if (altE0 < 5e3 && vNow < 1300 && this.mission.chutes) {
      if (!this.chutes) { this.chutes = true; this.log('PARACADUTE — apertura a ' + (altE0 / 1e3).toFixed(1) + ' km quota', 'info'); }
      const aP = 15; // frenamento paracadute (droga+main)
      dax -= aP * s.vx / (vNow || 1); day -= aP * s.vy / (vNow || 1);
    }
    this.gLoad = Math.hypot(tax + dax, tay + day) / G0;
    if (this.gLoad > this.gMax) this.gMax = this.gLoad;

    // --- RK4 gravità + spinta + aerodinamica ---
    const accel = (x, y, t) => {
      const gr = gravityAt(x, y, t, astro);
      return { ax: gr.ax + tax + dax, ay: gr.ay + tay + day };
    };
    const ns = rk4Step({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, t: this.t }, dt, accel);
    s.x = ns.x; s.y = ns.y; s.vx = ns.vx; s.vy = ns.vy;
    this.t += dt;

    // --- Scia ---
    if (this.t - this._lastTrail > 5) {
      this.trail.push({ x: s.x, y: s.y });
      this._lastTrail = this.t;
      if (this.trail.length > 4000) this.trail = this.trail.filter((_, i) => i % 2 === 0);
    }

    // --- Collisioni ---
    const dE = Math.hypot(s.x, s.y);
    const mo = moonState(this.t, astro);
    const dM = Math.hypot(mo.x - s.x, mo.y - s.y);
    if (dE <= astro.earth.radius) {
      const vRel = Math.hypot(s.vx, s.vy);
      if (vRel < 150) { this.status = 'SPLASHDOWN'; this.log('AMMARAGGIO — rientro completato (v=' + vRel.toFixed(1) + ' m/s, G max ' + this.gMax.toFixed(1) + ')', 'success'); }
      else { this.status = 'CRASHED'; this.log('IMPATTO — superficie TERRA (v=' + vRel.toFixed(0) + ' m/s)', 'danger'); }
    } else if (dM <= astro.moon.radius + terrainHeight(Math.atan2(s.y - mo.y, s.x - mo.x))) {
      const vRel = Math.hypot(s.vx - mo.vx, s.vy - mo.vy);
      if (vRel < 3) {
        this.status = 'TOUCHDOWN';
        s.throttle = 0; // niente LIFTOFF parassita da throttle residuo del PID
        this.landed = { dx: s.x - mo.x, dy: s.y - mo.y };
        this.log('TOUCHDOWN — allunaggio riuscito (v=' + vRel.toFixed(2) + ' m/s)', 'success');
      } else { this.status = 'CRASHED'; this.log('IMPATTO — superficie LUNA (v=' + vRel.toFixed(1) + ' m/s)', 'danger'); }
    }

    // --- Mengzhou in orbita: moto + aggancio ---
    if (this.orbiter) {
      this.orbiter.angle += this.orbiter.omega * dt;
      if (this.status === 'NOMINAL' && (!this.dockCooldown || this.t > this.dockCooldown)) {
        const op = this.orbiterPos();
        const dd = Math.hypot(op.x - s.x, op.y - s.y);
        const dv = Math.hypot(op.vx - s.vx, op.vy - s.vy);
        if (dd < 2e3 && dv < 30) {
          this.status = 'DOCKED';
          this.log('DOCKING — aggancio a Mengzhou riuscito (d=' + (dd / 1e3).toFixed(1) + ' km, dv=' + dv.toFixed(0) + ' m/s)', 'success');
        }
      }
    }

    this._stepDebris(dt);
  }

  /** A TOUCHDOWN la nave è ancorata alla Luna: ruota con lei; throttle > 0 = decollo. */
  _rideMoon(dt) {
    const m = moonState(this.t, this.astro);
    const w = this.astro.moonOrbit.omega;
    const L = this.landed;
    const c = Math.cos(w * dt), s = Math.sin(w * dt);
    const nx = L.dx * c - L.dy * s, ny = L.dx * s + L.dy * c;
    L.dx = nx; L.dy = ny;
    this.ship.x = m.x + nx; this.ship.y = m.y + ny;
    this.ship.vx = m.vx - w * ny; this.ship.vy = m.vy + w * nx;
    if (this.ship.throttle > 0.05 && this.activeStage.propellant > 0) {
      this.status = 'NOMINAL'; this.landed = null;
      this.log('LIFTOFF — decollo dal suolo lunare', 'success');
    }
    this.t += dt; // il tempo scorre anche sul suolo lunare
  }

  /** A DOCKED la nave viaggia con Mengzhou. */
  _rideOrbiter(dt) {
    this.t += dt; // il tempo scorre anche agganciati
    const op = this.orbiterPos();
    this.ship.x = op.x; this.ship.y = op.y;
    this.ship.vx = op.vx; this.ship.vy = op.vy;
  }

  /** Guasto simulato: 1 motore su 4 fuori uso -> logica diagonale CNSA (coppia opposta, spinta 50%). */
  faultEngine() {
    if (this.thrustFactor === 1) {
      this.thrustFactor = 0.5;
      this.log('FAULT — 1/4 YF-36 fuori uso: logica diagonale, la coppia opposta compensa il momento (spinta 50%)', 'danger');
    } else {
      this.thrustFactor = 1;
      this.log('YF-36 quad ripristinato (spinta 100%)', 'success');
    }
  }

  undock() {
    if (this.status === 'DOCKED') {
      this.status = 'NOMINAL';
      // separazione fisica: 3 km radiali + 15 m/s di divergenza, altrimenti
      // il check di aggancio (dist<2 km) ri-aggancia immediatamente
      const mo = moonState(this.t, this.astro);
      const dx = this.ship.x - mo.x, dy = this.ship.y - mo.y;
      const r = Math.hypot(dx, dy) || 1, ux = dx / r, uy = dy / r;
      this.ship.x += ux * 3e3; this.ship.y += uy * 3e3;
      this.ship.vx += ux * 15 + (this.orbiter ? -uy * 25 : 0);
      this.ship.vy += uy * 15 + (this.orbiter ? ux * 25 : 0);
      this.dockCooldown = this.t + 300;
      this.log('UNDOCK — separazione da Mengzhou (3 km radiali + divergenza)', 'info');
    }
  }

  _stepDebris(dt) {
    const astro = this.astro;
    for (const d of this.debris) {
      if (d.dead) continue;
      const accel = (x, y, t) => gravityAt(x, y, t, astro);
      const ns = rk4Step({ x: d.x, y: d.y, vx: d.vx, vy: d.vy, t: this.t }, dt, accel);
      d.x = ns.x; d.y = ns.y; d.vx = ns.vx; d.vy = ns.vy;
      d.trail.push({ x: d.x, y: d.y });
      if (d.trail.length > 600) d.trail.shift();
      const mo = moonState(this.t, astro);
      if (Math.hypot(d.x, d.y) <= astro.earth.radius || Math.hypot(mo.x - d.x, mo.y - d.y) <= astro.moon.radius) {
        d.dead = true;
        this.log(d.name + ': IMPATTO controllato (crash deliberato)', 'stage');
      }
    }
  }
}

/* ---------------- Trajectory Predictor ---------------- */

/**
 * Simula in avanti 'steps' passi RK4 (gravità pura + eventuale nodo di manovra)
 * e restituisce i punti per la linea tratteggiata predittiva + eventi:
 *   events.soiEntry : primo ingresso nella SOI lunare {x,y,i}
 *   events.impact   : impatto con un corpo {body,x,y,i} (interrompe la previsione)
 *   node: {time, dv} → impulso prograde(+)/retrograde(-) applicato al tempo dato.
 */
export function predictTrajectory(sim, { steps = 600, dt = null, node = null, dtMin = 0.5, dtMax = 240, burn = null } = {}) {
  const astro = sim.astro;
  let s = { x: sim.ship.x, y: sim.ship.y, vx: sim.ship.vx, vy: sim.ship.vy, t: sim.t };
  const points = [{ x: s.x, y: s.y, t: s.t }];
  const events = { soiEntry: null, impact: null, nodeApplied: false, atmEntry: null };
  let nodeApplied = !node;
  // burn finito opzionale: { tStart, dv, thrust, isp, mass } — modella il piano
  // di accensione dell'autopilota (spinta prograde, consumo massa, MECO a dv)
  let burnState = burn ? { mass: burn.mass, dvLeft: burn.dv, done: false } : null;
  const m0 = moonState(s.t, astro);
  let wasInSoi = Math.hypot(m0.x - s.x, m0.y - s.y) < astro.soiMoon;

  for (let i = 1; i <= steps; i++) {
    if (node && !nodeApplied && s.t >= node.time) {
      const p = progradeUnit(s.x, s.y, s.vx, s.vy, s.t, astro);
      s.vx += p.x * node.dv; s.vy += p.y * node.dv;
      nodeApplied = true; events.nodeApplied = true;
    }
    // Passo ADATTIVO (se dt=null): 5% della scala temporale locale r/v,
    // clampato in [dtMin, dtMax] -> preciso in LEO, capiente in crociera.
    let h = dt;
    if (h == null) {
      const mq = moonState(s.t, astro);
      const inMoon = Math.hypot(mq.x - s.x, mq.y - s.y) < astro.soiMoon;
      const rx = inMoon ? s.x - mq.x : s.x, ry = inMoon ? s.y - mq.y : s.y;
      const vx = inMoon ? s.vx - mq.vx : s.vx, vy = inMoon ? s.vy - mq.vy : s.vy;
      const rr = Math.hypot(rx, ry), vv = Math.hypot(vx, vy) || 1;
      h = Math.max(dtMin, Math.min(dtMax, 0.05 * rr / vv));
    }

    let accel = (x, y, t) => gravityAt(x, y, t, astro);
    if (burnState && !burnState.done && s.t >= burn.tStart) {
      h = Math.min(h, 1); // burn: passo fine per fedeltà col passo di simulazione
      const p = progradeUnit(s.x, s.y, s.vx, s.vy, s.t, astro);
      if (burn.retro) { p.x = -p.x; p.y = -p.y; }
      const aT = burn.thrust / burnState.mass;
      accel = (x, y, t) => { const g = gravityAt(x, y, t, astro); return { ax: g.ax + aT * p.x, ay: g.ay + aT * p.y }; };
      burnState.mass -= burn.thrust * h / (burn.isp * G0);
      burnState.dvLeft -= aT * h;
      if (burnState.dvLeft <= 0) burnState.done = true;
    }
    s = { ...rk4Step(s, h, accel), t: s.t + h };
    points.push({ x: s.x, y: s.y, t: s.t });

    const mo = moonState(s.t, astro);
    const dM = Math.hypot(mo.x - s.x, mo.y - s.y);
    if (!wasInSoi && dM < astro.soiMoon) {
      events.soiEntry = { x: s.x, y: s.y, i };
      wasInSoi = true;
    }
    const rE = Math.hypot(s.x, s.y);
    if (!events.atmEntry && rE - astro.earth.radius < ATM.top) {
      const prev = points[points.length - 2];
      const vx = (s.x - prev.x), vy = (s.y - prev.y);
      const ux = s.x / rE, uy = s.y / rE;               // radiale
      const gamma = Math.asin(Math.max(-1, Math.min(1, (vx * ux + vy * uy) / (Math.hypot(vx, vy) || 1))));
      events.atmEntry = { x: s.x, y: s.y, i, gammaDeg: gamma * 180 / Math.PI };
    }
    if (rE <= astro.earth.radius) { events.impact = { body: 'earth', x: s.x, y: s.y, i }; break; }
    if (dM <= astro.moon.radius) { events.impact = { body: 'moon', x: s.x, y: s.y, i }; break; }
  }
  return { points, events };
}