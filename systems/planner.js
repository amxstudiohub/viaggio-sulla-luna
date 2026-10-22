/**
 * CISLUNAR 2030 — Planner di volo (systems/planner.js)
 * =====================================================
 * - Calcolo elementi orbitali in tempo reale (Apoasse, Periasse, e, Δv, dist. Luna)
 * - Gestione Time-Warp stabile (1x, 10x, 100x, 1000x)
 * - Sistema "Maneuver Node": anteprima vettore Δv prograde/retrograde
 *   sulla traiettoria predittiva PRIMA di accendere i motori.
 */

import { ASTRO } from '../data/spacecraft_specs.js';
import { moonState, earthState } from '../core/physics.js';

/** Corpo dominante: Luna se dentro la sua SOI, altrimenti Terra. */
export function dominantBody(x, y, t, astro = ASTRO) {
  const m = moonState(t, astro);
  const dM = Math.hypot(m.x - x, m.y - y);
  if (dM < astro.soiMoon) return { key: 'moon', body: m, GM: astro.moon.GM, radius: astro.moon.radius, name: astro.moon.name };
  return { key: 'earth', body: earthState(astro), GM: astro.earth.GM, radius: astro.earth.radius, name: astro.earth.name };
}

/**
 * Elementi orbitali dello stato nave rispetto al corpo dominante.
 * Gestisce il caso iperbolico (fuga): escape=true, apoapsis=Infinity.
 */
export function orbitalElements(ship, t, astro = ASTRO) {
  const dom = dominantBody(ship.x, ship.y, t, astro);
  const rx = ship.x - dom.body.x, ry = ship.y - dom.body.y;
  const vx = ship.vx - dom.body.vx, vy = ship.vy - dom.body.vy;
  const r = Math.hypot(rx, ry);
  const v = Math.hypot(vx, vy);
  const mu = dom.GM;

  const eps = (v * v) / 2 - mu / r;                 // energia specifica
  const a = -mu / (2 * eps);                        // semiasse maggiore (neg. se iperbolica)
  // vettore eccentricità (2D)
  const rv = rx * vx + ry * vy;
  const ex = ((v * v - mu / r) * rx - rv * vx) / mu;
  const ey = ((v * v - mu / r) * ry - rv * vy) / mu;
  const e = Math.hypot(ex, ey);
  const escape = eps >= 0;
  const periapsis = escape ? a * (1 - e) : a * (1 - e);   // rp = a(1-e) (entrambi negativi se iperb.)
  const apoapsis = escape ? Infinity : a * (1 + e);

  const m = moonState(t, astro);
  return {
    bodyKey: dom.key, bodyName: dom.name, GM: mu, radius: dom.radius,
    r, v, eps, a, e, escape,
    apoapsis, periapsis,
    altAp: Number.isFinite(apoapsis) ? apoapsis - dom.radius : Infinity,
    altPe: periapsis - dom.radius,
    distToMoon: Math.hypot(m.x - ship.x, m.y - ship.y),
    inMoonSOI: dom.key === 'moon',
  };
}

/* ---------------- Time-Warp ---------------- */

export class TimeWarp {
  constructor(levels = [1, 10, 100, 1000, 2000, 5000]) { this.levels = levels; this.i = 0; }
  get current() { return this.levels[this.i]; }
  up()   { if (this.i < this.levels.length - 1) this.i++; return this.current; }
  down() { if (this.i > 0) this.i--; return this.current; }
  set(v) { const j = this.levels.indexOf(v); if (j >= 0) this.i = j; return this.current; }
}

/* ---------------- Maneuver Node ---------------- */

export class ManeuverNode {
  constructor() { this.active = false; this.time = 0; this.dv = 0; }
  /** Attiva/posticipa il node: dv>0 prograde, dv<0 retrograde [m/s]. */
  set(time, dv = 0) { this.active = true; this.time = time; this.dv = dv; return this; }
  adjust(dDv) { if (this.active) this.dv += dDv; return this; }
  setTime(time) { if (this.active) this.time = time; return this; }
  clear() { this.active = false; this.dv = 0; }
  get valid() { return this.active && Math.abs(this.dv) > 1e-9; }
  /** Oggetto per predictTrajectory, o null. */
  get asNode() { return this.valid ? { time: this.time, dv: this.dv } : null; }
}