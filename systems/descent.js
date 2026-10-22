/**
 * CISLUNAR 2030 — GNC di discesa/risalita (systems/descent.js)
 * ============================================================
 * Controllore PID nel frame locale selenocentrico (radiale + tangenziale).
 * Comanda attitudine (vettore spinta) e throttle dei 4× YF-36 (throttleabili).
 *
 * Profilo:
 *   BRAKING  (alt > 25 km): uccide la velocità orizzontale puntando al sito
 *   APPROACH (25–2 km):    discesa ~12 m/s con convergenza laterale
 *   LANDING  (< 2 km):     soft landing, v_vert -> -1.2 m/s, v_horiz -> 0
 *
 * Engine-out diagonale: con thrustFactor=0.5 (2 motori su 4, coppia opposta)
 * il PID satura dolcemente e aumenta la velocità di discesa — atterra comunque
 * se il guasto arriva sotto i ~6 km (margini fisici reali del Lanyue).
 */

import { moonState } from '../core/physics.js';
import { terrainHeight } from './terrain.js';

export class Pid {
  /** max = limite sull'uscita (anti-windup: integra solo se non saturo). */
  constructor(kp, ki = 0, kd = 0, max = Infinity) { this.kp = kp; this.ki = ki; this.kd = kd; this.max = max; this.i = 0; this.prev = null; }
  step(err, dt) {
    const d = this.prev === null ? 0 : (err - this.prev) / dt;
    this.prev = err;
    const u = this.kp * err + this.ki * (this.i + err * dt) + this.kd * d;
    if (Math.abs(u) < this.max) this.i += err * dt; // conditional integration
    return Math.max(-this.max, Math.min(this.max, u));
  }
}

export class DescentGNC {
  constructor(sim, siteAngle) {
    this.sim = sim;
    this.site = siteAngle;
    // uscite in m/s², clampate all'autorità netta del quad YF-36
    this.up = new Pid(0.9, 0.02, 0.25, 6);
    this.tan = new Pid(0.8, 0.04, 0.20, 4);
    this.done = false;
  }

  /** Chiamato a ogni substep (dt=0.1 fissa, come DT_PHYS). */
  update(dt = 0.1) {
    const sim = this.sim;
    if (sim.status !== 'NOMINAL') { sim.setThrottle(0); this.done = true; return; }
    const m = moonState(sim.t, sim.astro);
    const dx = sim.ship.x - m.x, dy = sim.ship.y - m.y;
    const r = Math.hypot(dx, dy);
    const ux = dx / r, uy = dy / r;                 // radiale "up"
    const tx = -uy, ty = ux;                        // tangenziale progrado
    const ang = Math.atan2(dy, dx);
    const alt = r - sim.astro.moon.radius - terrainHeight(ang);
    const rvx = sim.ship.vx - m.vx, rvy = sim.ship.vy - m.vy; // velocità RELATIVA alla Luna
    const vUp = rvx * ux + rvy * uy;
    const vT = rvx * tx + rvy * ty;
    let dAng = this.site - ang;
    while (dAng > Math.PI) dAng -= Math.PI * 2;
    while (dAng < -Math.PI) dAng += Math.PI * 2;
    const x = dAng * sim.astro.moon.radius;         // distanza laterale dal sito

    // --- profilo di discesa ---
    let vUpTgt, vTTgt;
    // --- guida a glide-slope: il vettore velocità punta al sito (x, -alt) ---
    // dx/dt = -vT (x = (site-ang)*R), quindi muoversi verso x=0 richiede vT>0 se x>0.
    const L = Math.hypot(x, alt) || 1;
    let vMag;
    // Le perdite di gravità (g·t_hover) divorano propellente: discesa veloce in quota,
    // dolce solo sotto i 2 km dove il margine T/W è ampio.
    if (alt > 15e3) vMag = Math.min(200, 0.008 * alt + 60);
    else if (alt > 2e3) vMag = Math.min(100, 0.006 * alt + 25);
    else vMag = Math.min(12, 0.015 * L + 2); // keyata sulla distanza dal sito: lenta per non overshootare con l'approdo piatto
    if (alt < 60 && Math.abs(x) < 150) { vUpTgt = -1.0; vTTgt = 0; }  // tocco finale
    else {
      vTTgt = vMag * (x / L);
      // pendenza PROPORZIONALE auto-correttiva: -vT·(alt/x) mantiene il rapporto
      // quota/distanza costante -> la nave resta sulla rampa che passa per il suo
      // punto attuale, anche se frenata in quota l'ha tenuta alta.
      const ratio = Math.max(0.12, Math.min(1.1, alt / Math.max(Math.abs(x), 120)));
      vUpTgt = -Math.max(Math.abs(vT) * ratio, 2);
    }

    // --- PID -> accelerazione comandata (frame locale) ---
    // clamp: mai comandare una "picchiata" che ribalterebbe la nave (aUp >= -g)
    const aUp = Math.max(-1.4, this.up.step(vUpTgt - vUp, dt));
    const aTraw = this.tan.step(vTTgt - vT, dt);
    const g = sim.astro.moon.GM / (r * r);          // gravità locale da compensare
    const grp = sim.activeGroup;
    const aMax = (grp.thrust * sim.thrustFactor) / sim.mass;

    // --- saturazione del vettore di spinta ---
    // Se il vettore comandato eccede l'autorità, si scala proporzionalmente
    // (le due anelli rallentano insieme) ma il sostegno di peso non scende
    // mai sotto l'85% di g: la nave non va mai in caduta libera.
    let aUpEff = aUp + g;
    let aT = aTraw;
    const budget = 0.95 * aMax;
    const mag = Math.hypot(aUpEff, aT);
    if (mag > budget) {
      const sc = budget / mag;
      aUpEff = Math.max(0.85 * g, aUpEff * sc);
      aT = aT * sc;
    }

    const ax = aUpEff * ux + aT * tx;
    const ay = aUpEff * uy + aT * ty;
    const aMag = Math.min(Math.hypot(ax, ay), aMax);
    sim.ship.attitude = Math.atan2(ay, ax);
    sim.setThrottle(Math.max(0, Math.min(1, aMag / aMax)));
  }
}

/**
 * Guida di risalita: verticale fino a targetAlt, poi pitch-over progrado
 * e accelerazione fino a v_circ. Ritorna 'ORBIT' quando in orbita chiusa.
 */
export class AscentGNC {
  constructor(sim, targetAlt) {
    this.sim = sim; this.targetAlt = targetAlt; this.phase = 'RISE';
    this.up = new Pid(2.0, 0.15, 0.1, 4);
    this.tan = new Pid(2.0, 0.15, 0.1, 4); // PID separati con anti-windup
  }
  update(dt = 0.1) {
    const sim = this.sim;
    if (sim.status === 'TOUCHDOWN') {
      // da fermi sul suolo: spinta a fondo lungo la verticale locale per il LIFTOFF
      const m0 = moonState(sim.t, sim.astro);
      sim.ship.attitude = Math.atan2(sim.ship.y - m0.y, sim.ship.x - m0.x);
      sim.setThrottle(1);
      return 'RISE';
    }
    if (sim.status !== 'NOMINAL') return 'WAIT';
    const m = moonState(sim.t, sim.astro);
    const dx = sim.ship.x - m.x, dy = sim.ship.y - m.y;
    const r = Math.hypot(dx, dy);
    const ux = dx / r, uy = dy / r;
    const tx = -uy, ty = ux;
    const alt = r - sim.astro.moon.radius;
    const rvx = sim.ship.vx - m.vx, rvy = sim.ship.vy - m.vy; // velocità RELATIVA alla Luna
    const vUp = rvx * ux + rvy * uy;
    const vT = rvx * tx + rvy * ty;
    const vc = Math.sqrt(sim.astro.moon.GM / (sim.astro.moon.radius + this.targetAlt));

    let ax, ay;
    if (this.phase === 'RISE') {
      const aUp = this.up.step(Math.min(40, 0.015 * (this.targetAlt - alt) + 3) - vUp, dt);
      const g = sim.astro.moon.GM / (r * r);
      ax = (aUp + g) * ux; ay = (aUp + g) * uy;
      if (alt >= this.targetAlt * 0.92) this.phase = 'PITCH';
    } else {
      // pitch-over: mix radiale/tangenziale verso v_circ (vUp -> 0: burnout quasi-circolare)
      const aT = this.tan.step(vc - vT, dt);
      const aUp = this.up.step(0 - vUp, dt);
      const g = sim.astro.moon.GM / (r * r);
      ax = (aUp + g) * ux + aT * tx;
      ay = (aUp + g) * uy + aT * ty;
      if (vT > vc * 0.99 && Math.abs(vUp) < 5 && alt > this.targetAlt * 0.85) { sim.setThrottle(0); return 'ORBIT'; }
    }
    const aMag = Math.hypot(ax, ay);
    sim.ship.attitude = Math.atan2(ay, ax);
    const grp = sim.activeGroup;
    const aMax = (grp.thrust * sim.thrustFactor) / sim.mass;
    sim.setThrottle(Math.max(0, Math.min(1, aMag / aMax)));
    return this.phase;
  }
}