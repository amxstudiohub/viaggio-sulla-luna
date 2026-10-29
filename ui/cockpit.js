/**
 * CISLUNAR 2030 — Cockpit 2D (ui/cockpit.js)
 * ===========================================
 * Rendering Canvas2D stile "Modern Glass Cockpit": tema scuro, telemetria
 * vettoriale ad alto contrasto. Camera su Terra/Luna/Nave con zoom
 * logaritmico fluido (rotella). Nessuna dipendenza.
 */


import { ASTRO } from '../data/spacecraft_specs.js';
import { moonState, progradeUnit, ATM, hReal, vReal } from '../core/physics.js';
import { terrainHeight, terrainSlope } from '../systems/terrain.js';

const COL = {
  bg: '#04060c',
  earth: '#2e7fd4', earthDark: '#0a2a55', atmo: 'rgba(90,170,255,0.35)',
  moon: '#b9bcc4', moonDark: '#6f737d',
  trail: 'rgba(120,200,255,0.45)',
  pred: '#4dd8ff', predSoi: '#ffb347', predImpact: '#ff5c5c',
  soi: 'rgba(255,179,71,0.30)',
  ship: '#e8f6ff', flame: '#ffb347', flameHot: '#ff5c5c',
  prograde: '#7cffb2', retro: '#ffb347',
  node: '#7cffb2',
  debris: '#8a93a6',
};

function fmtLen(m) {
  if (!Number.isFinite(m)) return 'INFINITO';
  const a = Math.abs(m);
  if (a >= 1e6) return (m / 1e3).toLocaleString('it-IT', { maximumFractionDigits: 0 }) + ' km';
  if (a >= 1e3) return (m / 1e3).toFixed(1) + ' km';
  return m.toFixed(0) + ' m';
}
function fmtVel(v) { return v >= 1000 ? (v / 1000).toFixed(3) + ' km/s' : v.toFixed(1) + ' m/s'; }
function fmtMass(kg) { return kg >= 1000 ? (kg / 1000).toFixed(1) + ' t' : kg.toFixed(0) + ' kg'; }
export function fmtMET(t) {
  const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600),
        mi = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return (d > 0 ? d + 'g ' : '') + String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/** PRNG deterministico per il starfield. */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Cockpit {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { target: 'ship', x: 0, y: 0, scale: 3e-5, targetScale: 3e-5 };
    this.minScale = 1.2e-5;   // vista sistema completo
    this.maxScale = 2.5;      // vista ravvicinata nave
    this._stars = [];
    this._genStars();
    // sfondo fotorealistico per la vista tattica (generato via ComfyUI/FLUX)
    this._lunarImg = new Image();
    this._lunarImg.src = 'assets/lunar_tactical.png';
    // --- vista cinematografica di allunaggio (asset Qwen Image 2.1) ---
    this._cineSprites = { CNSA: new Image(), SPACEX: new Image(), LM10: new Image(), SH: new Image() };
    this._cineSprites.CNSA.src = 'assets/img/lander_lanyue_key.png';
    this._cineSprites.SPACEX.src = 'assets/img/lander_hls_key.png';
    this._cineSprites.LM10.src = 'assets/img/rocket_lm10_key.png';
    this._cineSprites.SH.src = 'assets/img/rocket_sh_key.png';
    this._plume = [];
    this._atmoImg = new Image();
    this._atmoImg.src = 'assets/img/atmo_launch.png';
    // --- sprite della cinematica di RIENTRO (Flux su DGX, chroma verde -> alpha) ---
    this._rientroSprites = {};
    for (const [k, f] of Object.entries({
      plasma: 'capsule_plasma_key.png', drogue: 'capsule_drogue_key.png',
      mains: 'capsule_mains_key.png', ship: 'ship_recovery_key.png', heli: 'heli_recovery_key.png',
    })) { const im = new Image(); im.src = 'assets/img/' + f; this._rientroSprites[k] = im; }
    this._plateImgs = { reentry: new Image(), ocean: new Image() };
    this._plateImgs.reentry.src = 'assets/img/reentry_plate.jpg';
    this._plateImgs.ocean.src = 'assets/img/ocean_plate.jpg';
    this._seaVideo = null; this._seaOk = false;
    this.act0 = null;
    this.cine = {
      enabled: true, active: false, scroll: 0, lastT: 0,
      els: typeof document !== 'undefined' ? {
        vp: document.getElementById('cinematic-viewport'),
        bg: document.getElementById('cine-bg'),
        lander: document.getElementById('cine-lander'),
        overlay: document.getElementById('cine-overlay'),
        exit: document.getElementById('cine-exit'),
        pad: document.getElementById('cine-pad'),
        smoke: document.getElementById('cine-smoke'),
        booster: document.getElementById('cine-booster'),
        stage2: document.getElementById('cine-stage2'),
        plate: document.getElementById('cine-plate'),
        capsule: document.getElementById('cine-capsule'),
        ship: document.getElementById('cine-ship'),
        heli: document.getElementById('cine-heli'),
      } : null,
    };
    if (this.cine.els.vp) {
      this._cineCtx = this.cine.els.overlay.getContext('2d');
      this.cine.els.exit.addEventListener('click', () => this.toggleCine());
    } else this.cine.els = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.zoomBy(ev.deltaY);
    }, { passive: false });
  }

  _genStars() {
    const rnd = mulberry32(20300720);
    for (let i = 0; i < 420; i++) {
      this._stars.push({ x: rnd(), y: rnd(), r: rnd() * 1.4 + 0.3, a: rnd() * 0.7 + 0.15 });
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Zoom logaritmico: moltiplicativo per la rotella. */
  zoomBy(deltaY) {
    const k = Math.exp(-deltaY * 0.0016);
    this.cam.targetScale = Math.max(this.minScale, Math.min(this.maxScale, this.cam.targetScale * k));
  }

  setCamera(target) { this.cam.target = target; }

  _focus(sim) {
    const m = moonState(sim.t, ASTRO);
    if (this.cam.target === 'earth') return { x: 0, y: 0 };
    if (this.cam.target === 'moon') return { x: m.x, y: m.y };
    return { x: sim.ship.x, y: sim.ship.y };
  }

  _updateCam(sim, dtReal) {
    const f = this._focus(sim);
    const lerp = Math.min(1, dtReal * 6);
    this.cam.x += (f.x - this.cam.x) * lerp;
    this.cam.y += (f.y - this.cam.y) * lerp;
    this.cam.scale = Math.exp(Math.log(this.cam.scale) + (Math.log(this.cam.targetScale) - Math.log(this.cam.scale)) * lerp);
  }

  _sx(x) { return (x - this.cam.x) * this.cam.scale + this.w / 2; }
  _sy(y) { return this.h / 2 - (y - this.cam.y) * this.cam.scale; }

  render(sim, el, pred, ui) {
    const ctx = this.ctx;
    this._updateCam(sim, ui.dtReal || 0.016);
    const S = this.cam.scale;

    // sfondo
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    // starfield (parallasse debole)
    ctx.save();
    for (const st of this._stars) {
      const px = (st.x * this.w - (this.cam.x * S * 0.02) % this.w + this.w) % this.w;
      const py = (st.y * this.h - (this.cam.y * S * 0.02) % this.h + this.h) % this.h;
      ctx.globalAlpha = st.a;
      ctx.fillStyle = '#cfe3ff';
      ctx.fillRect(px, py, st.r, st.r);
    }
    ctx.restore();

    const m = moonState(sim.t, ASTRO);

    // orbita lunare (ring guida)
    ctx.save();
    ctx.strokeStyle = 'rgba(140,160,190,0.18)';
    ctx.setLineDash([2, 10]);
    ctx.beginPath();
    ctx.arc(this._sx(0), this._sy(0), ASTRO.moonOrbit.radius * S, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // SOI lunare
    ctx.save();
    ctx.strokeStyle = COL.soi;
    ctx.setLineDash([6, 8]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this._sx(m.x), this._sy(m.y), ASTRO.soiMoon * S, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Terra
    const ex = this._sx(0), ey = this._sy(0), er = ASTRO.earth.radius * S;
    const gE = ctx.createRadialGradient(ex - er * 0.3, ey - er * 0.3, er * 0.1, ex, ey, er);
    gE.addColorStop(0, '#5fb0ff'); gE.addColorStop(0.6, COL.earth); gE.addColorStop(1, COL.earthDark);
    ctx.save();
    ctx.shadowColor = COL.atmo; ctx.shadowBlur = Math.min(60, er * 0.5);
    ctx.fillStyle = gE;
    ctx.beginPath(); ctx.arc(ex, ey, er, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(120,190,255,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(ex, ey, er + 2, 0, Math.PI * 2); ctx.stroke();

    // Luna: sprite procedurale (mari, crateri con luce/ombra, raggi) in cache
    const mx = this._sx(m.x), my = this._sy(m.y), mr = ASTRO.moon.radius * S;
    ctx.drawImage(this._moonSprite(mr), mx - mr, my - mr);

    // orbiter marker (Mengzhou)
    if (sim.orbiter) {
      const ob = sim.orbiter;
      const ang = ob.phase + ob.omega * sim.t;
      const ox = m.x + ob.r * Math.cos(ang), oy = m.y + ob.r * Math.sin(ang);
      ctx.fillStyle = ob.color;
      ctx.beginPath(); ctx.arc(this._sx(ox), this._sy(oy), 3, 0, Math.PI * 2); ctx.fill();
      if (S > 3e-5) {
        ctx.fillStyle = 'rgba(124,255,178,0.8)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(ob.name, this._sx(ox) + 6, this._sy(oy) - 5);
      }
    }

    // scia nave
    if (sim.trail.length > 1) {
      ctx.strokeStyle = COL.trail; ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (const p of sim.trail) {
        const px = this._sx(p.x), py = this._sy(p.y);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // detriti (crasher)
    for (const d of sim.debris) {
      if (d.dead) continue;
      ctx.strokeStyle = 'rgba(138,147,166,0.5)';
      ctx.beginPath();
      let st0 = false;
      for (const p of d.trail) { const px = this._sx(p.x), py = this._sy(p.y); if (!st0) { ctx.moveTo(px, py); st0 = true; } else ctx.lineTo(px, py); }
      ctx.stroke();
      ctx.fillStyle = COL.debris;
      ctx.beginPath(); ctx.arc(this._sx(d.x), this._sy(d.y), 2.5, 0, Math.PI * 2); ctx.fill();
    }

    // predizione (tratteggiata, segmenti colorati per evento)
    if (pred && pred.points.length > 1) {
      const pts = pred.points;
      const soiI = pred.events.soiEntry ? pred.events.soiEntry.i : Infinity;
      const impI = pred.events.impact ? pred.events.impact.i : Infinity;
      ctx.save();
      ctx.setLineDash([7, 6]);
      ctx.lineWidth = 1.4;
      for (let i = 1; i < pts.length; i++) {
        const col = i >= impI ? COL.predImpact : (i >= soiI ? COL.predSoi : COL.pred);
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(this._sx(pts[i - 1].x), this._sy(pts[i - 1].y));
        ctx.lineTo(this._sx(pts[i].x), this._sy(pts[i].y));
        ctx.stroke();
      }
      ctx.restore();
      if (pred.events.impact) {
        const ip = pred.events.impact;
        const px = this._sx(ip.x), py = this._sy(ip.y);
        ctx.strokeStyle = COL.predImpact; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px - 7, py - 7); ctx.lineTo(px + 7, py + 7);
        ctx.moveTo(px + 7, py - 7); ctx.lineTo(px - 7, py + 7);
        ctx.stroke();
      }
      if (pred.events.soiEntry) {
        const sp = pred.events.soiEntry;
        ctx.fillStyle = COL.predSoi;
        ctx.beginPath(); ctx.arc(this._sx(sp.x), this._sy(sp.y), 3.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    // maneuver node marker
    if (ui.node && ui.node.active && pred) {
      const pts = pred.points;
      let np = pts[pts.length - 1];
      for (const p of pts) { if (p.t >= ui.node.time) { np = p; break; } }
      const nx = this._sx(np.x), ny = this._sy(np.y);
      ctx.save();
      ctx.strokeStyle = COL.node; ctx.fillStyle = 'rgba(124,255,178,0.25)'; ctx.lineWidth = 1.5;
      ctx.translate(nx, ny); ctx.rotate(Math.PI / 4);
      ctx.fillRect(-6, -6, 12, 12); ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
      ctx.fillStyle = COL.node; ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('NODE ' + (ui.node.dv >= 0 ? '+' : '') + ui.node.dv.toFixed(0) + ' m/s', nx + 10, ny - 8);
    }

    // nave
    const s = sim.ship;
    const sx = this._sx(s.x), sy = this._sy(s.y);
    const shipPx = Math.max(5, Math.min(26, sim.mission.craft.height_m * S * 0.6));
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-s.attitude);
    // fiamma
    if (s.throttle > 0 && sim.status === 'NOMINAL') {
      const fl = shipPx * (0.8 + 0.5 * s.throttle) * (0.85 + Math.random() * 0.3);
      const fg = ctx.createLinearGradient(-shipPx, 0, -shipPx - fl, 0);
      fg.addColorStop(0, COL.flameHot); fg.addColorStop(1, 'rgba(255,179,71,0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-shipPx * 0.4, -shipPx * 0.28);
      ctx.lineTo(-shipPx * 0.4 - fl, 0);
      ctx.lineTo(-shipPx * 0.4, shipPx * 0.28);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = COL.ship;
    ctx.strokeStyle = ui.accent || COL.pred;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(shipPx, 0);
    ctx.lineTo(-shipPx * 0.6, -shipPx * 0.45);
    ctx.lineTo(-shipPx * 0.6, shipPx * 0.45);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();

    // vettori prograde/retrograde
    if (S > 2e-4) {
      const vrel = ui.el ? ui.el.v : 0;
      if (vrel > 0.01) {
        // frame-aware: velocità relativa al corpo dominante (come l'autopilota),
        // così dentro la SOI lunare le frecce non divergono dal muso
        const pg = progradeUnit(s.x, s.y, s.vx, s.vy, sim.t);
        const ang = Math.atan2(pg.y, pg.x);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(-ang);
        ctx.strokeStyle = COL.prograde; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(shipPx + 8, 0); ctx.lineTo(shipPx + 26, 0);
        ctx.moveTo(shipPx + 20, -4); ctx.lineTo(shipPx + 26, 0); ctx.lineTo(shipPx + 20, 4);
        ctx.stroke();
        ctx.strokeStyle = COL.retro;
        ctx.beginPath(); ctx.moveTo(-shipPx - 8, 0); ctx.lineTo(-shipPx - 26, 0);
        ctx.moveTo(-shipPx - 20, -4); ctx.lineTo(-shipPx - 26, 0); ctx.lineTo(-shipPx - 20, 4);
        ctx.stroke();
        ctx.restore();
      }
    }

    // --- RIENTRO: plasma → paracadute → ammaraggio → recupero ---
    if (this.cine.els && this.cine.enabled && this.cam.target === 'ship' && this._rientroVisible(sim)) {
      this._rientroCine(sim, ui);
      return;
    }
    // --- SOTTO I 25 km: vista cinematografica o pannello tattico ---
    const mo = moonState(sim.t, sim.astro);
    const altM = Math.hypot(s.x - mo.x, s.y - mo.y) - sim.astro.moon.radius;
    if (altM < 25e3 && this.cam.target === 'ship') {
      const angM = Math.atan2(s.y - mo.y, s.x - mo.x);
      const vRad = (s.vx - mo.vx) * Math.cos(angM) + (s.vy - mo.vy) * Math.sin(angM);
      if (this.cine.els && this.cine.enabled && sim.status === 'TOUCHDOWN' && this.cine.active) {
        this._surface(sim, mo, altM, ui);
        return;
      }
      if (this.cine.els && this.cine.enabled && Math.abs(vRad) > 0.05 && sim.status === 'NOMINAL') {
        this._cinematic(sim, mo, altM, ui, vRad);
        return;
      }
      this._hideCine();
      this._tactical(sim, mo, altM, ui);
    } else this._hideCine();
  }

  toggleCine() {
    if (!this.cine.els) return;
    this.cine.enabled = !this.cine.enabled;
    const e = this.cine.els.exit;
    e.textContent = this.cine.enabled ? '\u{1F3A5} VISTA CINEMA: ON' : '\u{1F3A5} VISTA CINEMA: OFF';
    e.classList.toggle('off', !this.cine.enabled);
    if (!this.cine.enabled) this._hideCine();
  }

  _hideCine() {
    if (!this.cine.active || !this.cine.els) return;
    this.cine.active = false;
    this.cine.els.vp.style.display = 'none';
    this.canvas.classList.remove('cine-mini');
  }

  /** Vero quando la cinematica del rientro deve prendere il controllo del viewport. */
  _rientroVisible(sim) {
    const altE = Math.hypot(sim.ship.x, sim.ship.y) - sim.astro.earth.radius;
    if (sim.status === 'SPLASHDOWN') return true;
    return !!sim.smJettisoned && altE > 0 && altE < ATM.top * 1.35 && (sim.qHeat > 0 || !!sim.chuteStage);
  }

  /**
   * CINEMATICA DEL RIENTRO: plasma -> droga -> principali -> ammaraggio -> recupero.
   * Gli stati sono letti dalla simulazione (nulla è inventato); le animazioni
   * girano a tempo REALE così reggono il warp 3-100 dell'autopilota. Le placche
   * Flux e il video del mare sono opzionali: senza, tutto è procedurale.
   */
  _rientroCine(sim, ui) {
    const E = this.cine.els, R = this.cine;
    const rdt = Math.min(0.1, ui.dtReal || 1 / 60);
    const dpr = window.devicePixelRatio || 1, W = this.w, H = this.h;
    if (!R.active) {
      E.vp.style.display = 'block';
      this.canvas.classList.add('cine-mini');
      R.active = true;
      E.bg.style.display = 'none';
      E.lander.style.display = 'none';
      for (const k of ['pad', 'smoke', 'booster', 'stage2']) if (E[k]) E[k].style.display = 'none';
      R.ret = { stage: '', age: 0, beat: -1, embers: [], ring: 0, sea: null };
    }
    const rt = (R.ret = R.ret || { stage: '', age: 0, beat: -1, embers: [], ring: 0, sea: null });
    rt.age += rdt;
    if (E.overlay.width !== Math.round(W * dpr) || E.overlay.height !== Math.round(H * dpr)) {
      E.overlay.width = Math.round(W * dpr); E.overlay.height = Math.round(H * dpr);
    }
    const ctx = this._cineCtx || (this._cineCtx = E.overlay.getContext('2d'));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const stage = sim.status === 'SPLASHDOWN' ? 'splash'
      : sim.chuteStage === 'main' ? 'mains'
      : sim.chuteStage === 'drogue' ? 'drogue' : 'plasma';
    if (stage !== rt.stage) { rt.stage = stage; rt.age = 0; this._rientroStage(E, stage); }

    if (stage === 'plasma') {
      const q = Math.max(0, Math.min(1, sim.qHeat / ATM.qRef));
      this._plate(E, W, H, 'reentry', rt.age, q);
      const sh = 1.2 + 7 * q;
      const sx = (Math.random() - 0.5) * sh, sy = (Math.random() - 0.5) * sh;
      const sc = 0.6 + 0.28 * Math.min(1, rt.age / 45);
      E.capsule.style.transform = 'translate(-50%,-50%) translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) +
        'px) scale(' + sc.toFixed(2) + ') rotate(' + (-12 + 2.5 * Math.sin(rt.age)).toFixed(1) + 'deg)';
      E.capsule.style.filter = 'brightness(' + (1 + 1.5 * q).toFixed(2) + ') drop-shadow(0 0 ' +
        (16 + 90 * q).toFixed(0) + 'px rgba(255,120,40,' + (0.3 + 0.55 * q).toFixed(2) + '))';
      this._plasmaField(ctx, W, H, q, rt, rdt);
      if (sim.blackout) this._static(ctx, W, H, rt.age);
    } else if (stage === 'drogue' || stage === 'mains') {
      const hy = H * (stage === 'drogue' ? 0.86 : 0.72) + Math.min(70, rt.age * (stage === 'mains' ? 16 : 3));
      this._seaBackdrop(E, W, H, hy, rt.age, stage);
      const sway = Math.sin(rt.age * 1.5) * 3.2, bob = Math.sin(rt.age * 0.8) * 5;
      const sc = stage === 'drogue' ? 0.74 : 0.98;
      E.capsule.style.transform = 'translate(-50%,-50%) translateY(' + (bob - (stage === 'drogue' ? H * 0.16 : H * 0.04)).toFixed(1) +
        'px) rotate(' + sway.toFixed(2) + 'deg) scale(' + sc + ')';
      E.capsule.style.filter = 'brightness(1.05) drop-shadow(0 10px 26px rgba(0,0,0,0.45))';
    } else {
      const hy = H * 0.54;                    // linea d'orizzonte della placca di mare
      this._seaBackdrop(E, W, H, hy, rt.age, 'splash');
      const bob = Math.sin(rt.age * 1.1) * 3 + Math.sin(rt.age * 2.3) * 1.2;
      const cx = W * 0.07;                    // capsula in primo piano, leggermente a destra
      E.capsule.style.transform = 'translate(-50%,-50%) translate(' + cx.toFixed(0) + 'px,' +
        (hy - H / 2 + 34 + bob).toFixed(1) + 'px) rotate(' + (Math.sin(rt.age * 0.7) * 1.5).toFixed(2) +
        'deg) scale(0.62)';
      E.capsule.style.filter = 'brightness(0.96) drop-shadow(0 6px 18px rgba(0,0,0,0.5))';
      if (rt.age < 3.2) this._splashRing(ctx, W / 2 + cx, hy + 34 + bob, rt.age);
      const beats = [6, 16, 28, 44];
      while (rt.beat < beats.length - 1 && rt.age >= beats[rt.beat + 1]) { rt.beat++; this.onBeat(rt.beat, sim); }
      if (rt.beat >= 0 && E.ship) {           // la nave arriva di poppa e resta sull'orizzonte
        const a = Math.min(1, (rt.age - beats[0]) / 5);
        const ease = 1 - Math.pow(1 - a, 3);
        E.ship.style.display = ''; E.ship.style.opacity = a.toFixed(2);
        E.ship.style.transform = 'translate(-50%,-50%) translate(' + (-W * 0.3 + ease * W * 0.16).toFixed(0) +
          'px,' + (hy - H / 2 + 4 + Math.sin(rt.age * 0.9) * 2).toFixed(0) + 'px) scale(' +
          (1.05 + 0.15 * ease).toFixed(2) + ')';
      }
      if (rt.beat >= 1 && E.heli) {           // l'elicottero scende da destra sulla capsula
        const p = Math.min(1, (rt.age - beats[1]) / 6);
        const ease = 1 - Math.pow(1 - p, 2);
        E.heli.style.display = ''; E.heli.style.opacity = p.toFixed(2);
        E.heli.style.transform = 'translate(-50%,-50%) translate(' + (W * 0.3 - ease * W * 0.1).toFixed(0) + 'px,' +
          (-H * 0.3 + ease * H * 0.2 + Math.sin(rt.age * 6) * 2).toFixed(0) + 'px) scale(' +
          (0.42 + 0.2 * ease).toFixed(2) + ')';
      }
      if (rt.beat >= 3) this._missionCard(ctx, W, H, sim, rt);
    }
  }

  /** Scambia gli sprite allo stato di rientro corrente. */
  _rientroStage(E, stage) {
    const sp = this._rientroSprites;
    // se si arriva qui da una cinematica di superficie lunare, i suoi strati vanno spenti
    if (E.lander) E.lander.style.display = 'none';
    for (const k of ['pad', 'smoke', 'booster', 'stage2']) if (E[k]) E[k].style.display = 'none';
    const which = stage === 'plasma' ? sp.plasma : stage === 'drogue' ? sp.drogue : sp.mains;
    const ok = which && which.complete && which.naturalWidth;
    if (ok) { E.capsule.src = which.src; E.capsule.style.display = ''; }
    else E.capsule.style.display = 'none';
    if (E.plate) E.plate.style.display = 'none';
    if (E.ship && sp.ship && sp.ship.complete && sp.ship.naturalWidth) E.ship.src = sp.ship.src;
    if (E.heli && sp.heli && sp.heli.complete && sp.heli.naturalWidth) E.heli.src = sp.heli.src;
    if (E.ship) E.ship.style.display = 'none';
    if (E.heli) E.heli.style.display = 'none';
    const v = this._ensureSeaVideo(E);
    if (v) v.style.display = (stage === 'plasma') ? 'none' : '';
  }

  /** Video plate del mare (LTX, opzionale): creato al primo bisogno. */
  _ensureSeaVideo(E) {
    if (this._seaVideo !== null && this._seaVideo !== undefined) return this._seaVideo;
    this._seaVideo = false;
    try {
      const v = document.createElement('video');
      v.id = 'cine-sea';
      v.src = 'assets/video/mare.mp4';
      v.muted = true; v.loop = true; v.defaultMuted = true; v.playsInline = true;
      v.style.display = 'none';
      v.addEventListener('canplay', () => { this._seaOk = true; });
      v.addEventListener('error', () => { this._seaOk = false; this._seaVideo = false; });
      E.vp.insertBefore(v, E.plate || E.overlay);
      v.play().then(() => { this._seaVideo = v; }).catch(() => { this._seaVideo = false; });
      if (this._seaVideo !== false) this._seaVideo = v;
    } catch (err) { this._seaVideo = false; }
    return this._seaVideo;
  }

  /** Placca a tutto schermo per lo stato di plasma (elemento SOTTO gli sprite). */
  _plate(E, W, H, which, age, q) {
    const im = this._plateImgs[which];
    if (im && im.complete && im.naturalWidth) {
      if (E.plate.dataset.which !== which) { E.plate.src = im.src; E.plate.dataset.which = which; }
      E.plate.style.display = '';
      E.bg.style.display = 'none';
      const sh = 1 + 6 * q;
      E.plate.style.transform = 'translate(' + ((Math.random() - 0.5) * sh).toFixed(1) + 'px,' +
        ((Math.random() - 0.5) * sh).toFixed(1) + 'px) scale(' + (1.05 + 0.08 * q).toFixed(3) + ')';
      E.plate.style.filter = 'brightness(' + (1 + 0.4 * q).toFixed(2) + ') saturate(' + (1 + 0.6 * q).toFixed(2) + ')';
      return;
    }
    E.plate.style.display = 'none';
    E.bg.style.display = '';
    E.bg.style.backgroundImage = 'linear-gradient(180deg,#00030a 0%,#0a1430 55%,#5a2a10 82%,#1b0c06 100%)';
    E.bg.style.transform = 'none';
  }

  /** Mare: video LTX se c'è, placca Qwen, altrimenti gradiente CSS. */
  _seaBackdrop(E, W, H, hy, age, stage) {
    const v = this._ensureSeaVideo(E);
    if (v && this._seaOk) {
      v.style.display = '';
      E.plate.style.display = 'none';
      E.bg.style.display = 'none';
      return;
    }
    const im = this._plateImgs.ocean;
    if (im && im.complete && im.naturalWidth) {
      if (v) v.style.display = 'none';
      if (E.plate.dataset.which !== 'ocean') { E.plate.src = im.src; E.plate.dataset.which = 'ocean'; }
      E.plate.style.display = '';
      E.bg.style.display = 'none';
      E.plate.style.transform = 'translateY(' + (hy - H / 2).toFixed(0) + 'px) scale(1.04)';
      E.plate.style.filter = 'brightness(1.04)';
      return;
    }
    if (v) v.style.display = 'none';
    E.plate.style.display = 'none';
    E.bg.style.display = '';
    const pct = ((hy / H) * 100).toFixed(0);
    E.bg.style.backgroundImage = 'linear-gradient(180deg,#7ea9cf 0%,#f0dcb6 ' + pct + '%,#1d4a6b '
      + (+pct + 1) + '%,#06202f 100%)';
    E.bg.style.transform = 'none';
  }

  /** Scia di plasma: brandelli incandescenti che sfrecciano verso l'alto. */
  _plasmaField(ctx, W, H, q, rt, rdt) {
    const n = Math.round(10 + 46 * q);
    while (rt.embers.length < n) rt.embers.push({
      x: Math.random() * W, y: H * (0.3 + Math.random() * 0.8),
      v: 260 + Math.random() * 900 * (0.4 + q), l: 0.3 + Math.random() * 0.7,
    });
    ctx.lineCap = 'round';
    for (const p of rt.embers) {
      p.y -= p.v * rdt * (0.6 + q);
      if (p.y < -40) { p.y = H + Math.random() * 60; p.x = Math.random() * W; }
      const a = 0.25 + 0.6 * q * p.l;
      ctx.strokeStyle = 'rgba(255,' + (140 + Math.round(90 * p.l)) + ',60,' + a.toFixed(2) + ')';
      ctx.lineWidth = 1 + 2.6 * p.l * q;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 3, p.y + 26 + 70 * q * p.l); ctx.stroke();
    }
  }

  /** Blackout da plasma: neve TV + lamming, senza testo. */
  _static(ctx, W, H, age) {
    const a = 0.10 + 0.05 * Math.sin(age * 30);
    for (let i = 0; i < 900; i++) {
      const v = Math.random();
      ctx.fillStyle = 'rgba(' + (v * 255 | 0) + ',' + (v * 255 | 0) + ',' + (v * 255 | 0) + ',' + a.toFixed(2) + ')';
      ctx.fillRect(Math.random() * W, Math.random() * H, 3, 2);
    }
  }

  /** Anello d'impatto sull'acqua dopo l'ammaraggio. */
  _splashRing(ctx, cx, cy, age) {
    for (let i = 0; i < 3; i++) {
      const t = age - i * 0.35;
      if (t <= 0) continue;
      const r = 20 + t * 190, a = Math.max(0, 0.5 - t * 0.28);
      ctx.strokeStyle = 'rgba(235,245,255,' + a.toFixed(2) + ')';
      ctx.lineWidth = 3 - i;
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.26, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(240,250,255,0.5)';
    for (let i = 0; i < 26; i++) {
      const t = Math.min(1, age / 1.1), a = (i / 26) * Math.PI * 2;
      const r = 30 + t * 150;
      ctx.fillRect(cx + Math.cos(a) * r, cy - Math.abs(Math.sin(a)) * (60 * (1 - t)) + Math.sin(a) * r * 0.2, 2.5, 2.5);
    }
  }

  /** Scheda di fine missione disegnata sulla cinematica. */
  _missionCard(ctx, W, H, sim, rt) {
    const a = Math.min(1, (rt.age - 44) / 3);
    ctx.fillStyle = 'rgba(4,10,18,' + (0.62 * a).toFixed(2) + ')';
    ctx.fillRect(W * 0.5 - 230, H * 0.5 - 120, 460, 240);
    ctx.strokeStyle = 'rgba(120,220,255,' + (0.7 * a).toFixed(2) + ')';
    ctx.lineWidth = 1.4; ctx.strokeRect(W * 0.5 - 230, H * 0.5 - 120, 460, 240);
    ctx.fillStyle = 'rgba(190,240,255,' + a.toFixed(2) + ')';
    ctx.font = '600 26px ui-monospace, monospace'; ctx.textAlign = 'center';
    ctx.fillText('AMMARAGGIO COMPLETATO', W / 2, H * 0.5 - 66);
    ctx.font = '500 16px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(150,200,225,' + a.toFixed(2) + ')';
    const righe = [
      'G massime    ' + sim.gMax.toFixed(1) + ' g',
      'Ingressi in atmosfera   ' + sim.atmIngressi,
      'Durata missione   ' + (sim.t / 3600).toFixed(1) + ' h',
      'Recupero   equipaggio in sicurezza',
    ];
    righe.forEach((r, i) => ctx.fillText(r, W / 2, H * 0.5 - 18 + i * 28));
    ctx.textAlign = 'left';
  }


  /**
   * VISTA TATTICA DI DISCESA (sotto i 25 km lunari): riquadro con profilo del
   * terreno procedurale (crateri/massi da terrain.js), cono LiDAR a 15 raggi —
   * verdi dove la pendenza locale è < 3° (zona atterrabile), rossi dove no —
   * marcatore del sito scelto dall'autopilota e telemetria verticale.
   */
  /**
   * VISTA CINEMATOGRAFICA DI ALLUNAGGIO (sotto i 25 km, in discesa):
   * texture regolite Qwen che scorre e zooma, lander sprite fermo al centro,
   * LiDAR e targeting disegnati su canvas trasparente con coordinate reali.
   */
  _cinematic(sim, mo, altM, ui, vUp) {
    const E = this.cine.els;
    const s = sim.ship;
    if (!this.cine.active) {
      E.vp.style.display = 'block';
      this.canvas.classList.add('cine-mini');
      E.lander.style.display = '';
      this.cine.active = true;
      this.cine.lastT = sim.t;
      this.cine.touchAge = 0;
    }
    const dtSim = Math.max(0, Math.min(30, sim.t - this.cine.lastT));
    this.cine.lastT = sim.t;

    const dpr = window.devicePixelRatio || 1;
    const W = this.w, H = this.h;
    if (E.overlay.width !== Math.round(W * dpr) || E.overlay.height !== Math.round(H * dpr)) {
      E.overlay.width = Math.round(W * dpr); E.overlay.height = Math.round(H * dpr);
    }
    const ctx = this._cineCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const p = 1 - Math.max(0, Math.min(1, altM / 25e3)); // 0 = 25 km, 1 = suolo
    const asc = vUp > 0; // ascesa lunare: zoom-out e distacco dal suolo
    const R = sim.astro.moon.radius;
    const ang = Math.atan2(s.y - mo.y, s.x - mo.x);
    const dvx = s.vx - mo.vx, dvy = s.vy - mo.vy;
    const vHor = -dvx * Math.sin(ang) + dvy * Math.cos(ang);

    // --- orizzonte regolite: visuale LATERALE coerente col lander verticale ---
    // Il suolo sale dal basso (e risale in ascesa) fino a toccare i piedi del
    // lander al touchdown; texture schiacciata in prospettiva (scaleY 0.42).
    const bgX = Math.max(-240, Math.min(240, -vHor * 0.8));
    const feetY = H / 2 + 140;
    const ease = p * p * (3 - 2 * p);
    const horizonY = H * 1.25 - (H * 1.25 - feetY) * ease;
    E.bg.style.inset = 'auto';
    E.bg.style.left = '-25%';
    E.bg.style.width = '150%';
    E.bg.style.top = horizonY.toFixed(0) + 'px';
    E.bg.style.height = (H * 1.6).toFixed(0) + 'px';
    E.bg.style.objectFit = 'cover';
    E.bg.style.objectPosition = 'center top';
    E.bg.style.transformOrigin = 'top center';
    E.bg.style.transform = 'translate(' + bgX.toFixed(1) + 'px, 0px) scaleY(0.42) scaleX(1.25)';
    E.bg.style.filter = 'brightness(' + (0.8 + 0.45 * p).toFixed(2) + ') contrast(1.18)';

    // --- sprite lander: fermo al centro, cresce e si illumina ---
    const mid = sim.mission.id === 'SPACEX' ? 'SPACEX' : 'CNSA';
    if (E.lander.dataset.mid !== mid) { E.lander.src = this._cineSprites[mid].src; E.lander.dataset.mid = mid; }
    let rot = -(s.attitude - ang);
    while (rot > Math.PI) rot -= 2 * Math.PI;
    while (rot < -Math.PI) rot += 2 * Math.PI;
    rot = Math.max(-0.14, Math.min(0.14, rot)); // sempre verticale muso-in-alto, come il lancio
    E.lander.style.transform = 'translate(-50%,-50%) rotate(' + rot.toFixed(3) + 'rad) scale(' + (1 + 0.32 * p).toFixed(3) + ')';
    E.lander.style.filter = 'drop-shadow(0 0 ' + (14 + 30 * p).toFixed(0) + 'px rgba(255,160,70,' + (0.25 + 0.35 * p).toFixed(2) + ')) brightness(' + (1 + 0.22 * p).toFixed(2) + ')';

    // --- fiamme dinamiche + polvere lunare sotto i 200 m ---
    const cx = W / 2, cy = H / 2;
    const lScale = 1 + 0.32 * p;
    const thrust = sim.ship.throttle || 0;
    const rdt = Math.min(0.05, ui.dtReal || 1 / 60);
    this._plumeFrame(ctx, W, H, cx, cy + 132 * lScale, thrust, lScale, rdt, sim.t);
    if (altM < 200 && thrust > 0.1) this._dustFrame(ctx, cx, Math.min(horizonY, H - 30), thrust, rdt, asc);
    const rayLen = horizonY < H + 60 ? Math.max(96, horizonY - cy) : H * 0.44;
    if (horizonY < H + 40) {
      const hg = ctx.createLinearGradient(0, horizonY, 0, horizonY + 70);
      hg.addColorStop(0, 'rgba(235, 245, 255, 0.14)');
      hg.addColorStop(1, 'rgba(235, 245, 255, 0)');
      ctx.fillStyle = hg;
      ctx.fillRect(0, horizonY, W, 70);
      ctx.strokeStyle = 'rgba(220, 235, 255, 0.4)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(0, horizonY + 0.5); ctx.lineTo(W, horizonY + 0.5); ctx.stroke();
    }
    const vOk = asc || (Math.abs(vUp) < 12 && Math.abs(vHor) < 15);
    let nSafe = 0;
    for (let i = 0; i <= 14; i++) {
      const a = (-32 + 64 * i / 14) * Math.PI / 180;
      const ta = ang + Math.tan(a) * altM / R;
      const safe = terrainSlope(ta) < 3 && vOk;
      if (safe) nSafe++;
      ctx.strokeStyle = safe ? 'rgba(124,255,178,0.50)' : 'rgba(255,92,92,0.55)';
      ctx.lineWidth = safe ? 1.3 : 2.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(a) * 78, cy + Math.cos(a) * 78);
      ctx.lineTo(cx + Math.sin(a) * rayLen, cy + Math.cos(a) * rayLen);
      ctx.stroke();
      // ground return dot
      ctx.fillStyle = safe ? 'rgba(124,255,178,0.8)' : 'rgba(255,92,92,0.85)';
      ctx.fillRect(cx + Math.sin(a) * rayLen - 1.5, cy + Math.cos(a) * rayLen - 1.5, 3, 3);
    }
    // reticolo di targeting che converge
    const half = 190 - 120 * p;
    ctx.strokeStyle = 'rgba(77,216,255,0.75)';
    ctx.lineWidth = 1.4;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * half, cy + sy * half - sy * 26);
      ctx.lineTo(cx + sx * half, cy + sy * half);
      ctx.lineTo(cx + sx * half - sx * 26, cy + sy * half);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(cx, cy, half * 0.62, 0, 7); ctx.stroke();
    // segnaposto sito (distanza laterale reale)
    if (ui.site) {
      let dA = ui.site.angle - ang;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      while (dA < -Math.PI) dA += 2 * Math.PI;
      const dLat = dA * R;
      const win = Math.max(altM * 2.4, 3500);
      const hx = cx + Math.max(-1, Math.min(1, dLat / win)) * (W * 0.36);
      const hy = Math.min(cy + rayLen + 16, H - 46);
      ctx.strokeStyle = COL.prograde; ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(hx, hy - 9); ctx.lineTo(hx + 9, hy); ctx.lineTo(hx, hy + 9); ctx.lineTo(hx - 9, hy);
      ctx.closePath(); ctx.stroke();
      ctx.font = '12px "Share Tech Mono", monospace';
      ctx.fillStyle = COL.prograde;
      ctx.fillText('SITO ' + ui.site.slope.toFixed(1) + '\u00B0  \u00B7  ' + fmtLen(Math.abs(dLat)), hx + 16, hy + 4);
    }
    // telemetria cinema
    ctx.shadowColor = 'rgba(0, 6, 14, 0.95)';
    ctx.shadowBlur = 8;
    ctx.font = '700 30px "Share Tech Mono", monospace';
    ctx.fillStyle = altM < 120 ? COL.prograde : '#e8f6ff';
    ctx.fillText(fmtLen(altM), 34, 66);
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.fillStyle = '#8a93a6';
    ctx.fillText('QUOTA TERRENO', 34, 84);
    ctx.font = '15px "Share Tech Mono", monospace';
    ctx.fillStyle = vUp < -15 ? COL.flameHot : '#cfe3ff';
    ctx.fillText('V/S  ' + vUp.toFixed(1) + ' m/s', 34, 116);
    ctx.fillStyle = '#cfe3ff';
    ctx.fillText('V OR  ' + Math.abs(vHor).toFixed(1) + ' m/s', 34, 138);
    ctx.fillStyle = '#9fe8ff';
    ctx.fillText('G ' + (sim.gMax || 0).toFixed(2), 34, 160);
    ctx.textAlign = 'right';
    ctx.fillStyle = nSafe === 15 ? COL.prograde : COL.flameHot;
    ctx.fillText('LiDAR ' + nSafe + '/15 ' + (nSafe === 15 ? 'NOMINAL' : 'ZONA INSTABILE'), W - 34, 66);
    ctx.fillStyle = '#8a93a6';
    ctx.fillText((mid === 'SPACEX' ? 'STARSHIP HLS' : 'LANYUE') + ' \u2014 ' + (asc ? 'POWERED ASCENT' : 'POWERED DESCENT'), W - 34, 88);
    ctx.textAlign = 'left';
    ctx.shadowBlur = 0;
    if (!asc && p > 0.985) {
      ctx.font = '700 26px "Share Tech Mono", monospace';
      ctx.fillStyle = COL.prograde;
      ctx.textAlign = 'center';
      ctx.fillText('CONTACT \u2014 TOUCHDOWN IMMINENTE', cx, H - 60);
      ctx.textAlign = 'left';
    }
  }

  /** Forza l'ingresso in modalita superficie (es. touchdown raggiunto via jump). */
  forceSurface() {
    if (!this.cine.els || !this.cine.enabled) return false;
    this.cine.active = true;
    this.cine.els.vp.style.display = 'block';
    this.cine.els.lander.style.display = '';
    this.canvas.classList.add('cine-mini');
    this.cine.touchAge = 0;
    return true;
  }

  /** Surface hold: lander ancorato, panorama, attesa comando di decollo. */
  _surface(sim, mo, altM, ui) {
    const E = this.cine.els;
    const s = sim.ship;
    const rdt = Math.min(0.1, ui.dtReal || 1 / 60);
    this.cine.lastT = sim.t;
    this.cine.touchAge = (this.cine.touchAge || 0) + rdt;
    const age = this.cine.touchAge;
    const dpr = window.devicePixelRatio || 1;
    const W = this.w, H = this.h;
    if (E.overlay.width !== Math.round(W * dpr) || E.overlay.height !== Math.round(H * dpr)) {
      E.overlay.width = Math.round(W * dpr); E.overlay.height = Math.round(H * dpr);
    }
    const ctx = this._cineCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const mid = sim.mission.id === 'SPACEX' ? 'SPACEX' : 'CNSA';
    if (E.lander.dataset.mid !== mid) { E.lander.src = this._cineSprites[mid].src; E.lander.dataset.mid = mid; }
    // orizzonte fermo ai piedi del lander (continuità col touchdown)
    const hy = H / 2 + 140;
    E.bg.style.inset = 'auto';
    E.bg.style.left = '-25%';
    E.bg.style.width = '150%';
    E.bg.style.top = hy + 'px';
    E.bg.style.height = (H * 1.6) + 'px';
    E.bg.style.objectFit = 'cover';
    E.bg.style.objectPosition = 'center top';
    E.bg.style.transformOrigin = 'top center';
    E.bg.style.transform = 'translate(0px, 0px) scaleY(0.42) scaleX(1.25)';
    E.bg.style.filter = 'brightness(1.15) contrast(1.18)';
    ctx.strokeStyle = 'rgba(220, 235, 255, 0.4)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(0, hy + 0.5); ctx.lineTo(W, hy + 0.5); ctx.stroke();
    // assestamento ammortizzatori: decadente oscillante
    const settle = 9 * Math.exp(-2.1 * age) * Math.cos(9.5 * age);
    E.lander.style.transform = 'translate(-50%, calc(-50% + ' + settle.toFixed(1) + 'px)) scale(1.32)';
    const glow = Math.max(0, 1 - age / 1.4);
    E.lander.style.filter = 'drop-shadow(0 0 ' + (14 + 30 * glow).toFixed(0) + 'px rgba(255,160,70,' + (0.25 + 0.35 * glow).toFixed(2) + ')) brightness(1.22)';
    // polvere residua che ricade dolcemente
    this._dustFrame(ctx, W / 2, H / 2 + 140, glow * 0.7, rdt, false);
    // ombra di contatto: spegne il pennacchio impresso nello sprite (motori OFF)
    const sh = Math.min(0.96, age * 1.5);
    const sg = ctx.createRadialGradient(W / 2, H / 2 + 108, 4, W / 2, H / 2 + 108, 70);
    sg.addColorStop(0, 'rgba(8, 8, 12, ' + sh.toFixed(2) + ')');
    sg.addColorStop(0.7, 'rgba(8, 8, 12, ' + (sh * 0.85).toFixed(2) + ')');
    sg.addColorStop(1, 'rgba(8, 8, 12, 0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.ellipse(W / 2, H / 2 + 108, 46, 62, 0, 0, 7); ctx.fill();
    // messaggio principale
    ctx.shadowColor = 'rgba(0, 6, 14, 0.95)';
    ctx.shadowBlur = 10;
    ctx.textAlign = 'center';
    ctx.font = '700 34px "Share Tech Mono", monospace';
    ctx.fillStyle = '#7cffb2';
    ctx.fillText('SUPERFICIE LUNARE RAGGIUNTA', W / 2, H * 0.20);
    ctx.font = '14px "Share Tech Mono", monospace';
    ctx.fillStyle = '#9fe8ff';
    ctx.fillText('SITO STABILE \u00B7 PENDENZA ' + (ui.site ? ui.site.slope.toFixed(1) : '0.0') + '\u00B0 \u00B7 REGOLITE NOMINALE', W / 2, H * 0.20 + 30);
    const blink = 0.55 + 0.45 * Math.sin(age * 3.2);
    ctx.font = '700 20px "Share Tech Mono", monospace';
    ctx.fillStyle = 'rgba(232, 246, 255, ' + blink.toFixed(2) + ')';
    ctx.fillText('PREMI [ SPAZIO ] PER IL DECOLLO', W / 2, H - 84);
    ctx.textAlign = 'left';
    // telemetria da superficie
    ctx.font = '700 30px "Share Tech Mono", monospace';
    ctx.fillStyle = '#e8f6ff';
    ctx.fillText('0 m', 34, 66);
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.fillStyle = '#8a93a6';
    ctx.fillText('QUOTA TERRENO', 34, 84);
    ctx.font = '15px "Share Tech Mono", monospace';
    ctx.fillStyle = '#cfe3ff';
    ctx.fillText('V/S  0.0 m/s', 34, 116);
    ctx.fillStyle = '#7cffb2';
    ctx.fillText('STATUS  TOUCHDOWN \u00B7 SIM IN PAUSA', 34, 138);
    ctx.shadowBlur = 0;
  }

  /** PRNG deterministico: la Luna ha sempre lo stesso aspetto tra i frame. */
  static _rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /** Luna procedurale pre-renderizzata: base sferica + mari + ~50 crateri
   *  con cavità in ombra e orlo illuminato + due sistemi di raggi.
   *  Cache per dimensione (bucket di 3 px) per costo ammortizzato. */
  _moonSprite(mr) {
    if (!this._moonCache) this._moonCache = new Map();
    const R = Math.max(2, Math.round(mr / 3) * 3);
    let c = this._moonCache.get(R);
    if (c) return c;
    if (this._moonCache.size > 14) this._moonCache.clear();
    c = document.createElement('canvas'); c.width = R * 2; c.height = R * 2;
    const x = c.getContext('2d');
    const cx = R, cy = R;
    // base sferica illuminata da alto-sinistra
    const g0 = x.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.15, cx, cy, R);
    g0.addColorStop(0, '#f2efe9'); g0.addColorStop(0.55, '#cfcbc2'); g0.addColorStop(0.85, '#a29e95'); g0.addColorStop(1, '#6f6b64');
    x.fillStyle = g0; x.beginPath(); x.arc(cx, cy, R, 0, 7); x.fill();
    x.save(); x.beginPath(); x.arc(cx, cy, R - 0.5, 0, 7); x.clip();
    const rnd = Cockpit._rng(20300);
    // mari: chiazze scure morbide e irregolari (disposizione del lato vicino)
    const maria = [[-0.38, -0.30, 0.42], [-0.05, -0.18, 0.26], [0.16, -0.05, 0.22], [0.42, -0.28, 0.14], [-0.55, 0.05, 0.30], [0.05, 0.30, 0.20], [-0.25, 0.45, 0.16]];
    for (const [px, py, pr] of maria) {
      const gx = cx + px * R, gy = cy + py * R, gr = pr * R;
      for (let k = 0; k < 4; k++) {
        const ox = gx + (rnd() - 0.5) * gr * 0.9, oy = gy + (rnd() - 0.5) * gr * 0.9, or = gr * (0.55 + rnd() * 0.5);
        const g = x.createRadialGradient(ox, oy, or * 0.1, ox, oy, or);
        g.addColorStop(0, 'rgba(92, 95, 105, 0.38)'); g.addColorStop(1, 'rgba(92, 95, 105, 0)');
        x.fillStyle = g; x.beginPath(); x.arc(ox, oy, or, 0, 7); x.fill();
      }
    }
    // speckles di regolite (densità scala col raggio)
    for (let i = 0, nSpeck = Math.min(2200, 500 + R * 2); i < nSpeck; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R;
      x.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(40,40,48,0.06)';
      x.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 1 + rnd(), 1 + rnd());
    }
    // crateri: cavità in ombra (lato opposto al sole) + orlo illuminato
    const nCr = R > 60 ? Math.min(260, Math.round(R / 1.6)) : R > 24 ? 34 : 14;
    for (let i = 0; i < nCr; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R * 0.94;
      const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
      const cr = (0.006 + rnd() * rnd() * 0.05) * R;
      // alone di eietta sottile
      let g = x.createRadialGradient(px, py, cr * 0.8, px, py, cr * 1.5);
      g.addColorStop(0, 'rgba(216,214,206,0.08)'); g.addColorStop(1, 'rgba(216,214,206,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px, py, cr * 1.5, 0, 7); x.fill();
      // crest dell'orlo: anello chiaro netto
      x.fillStyle = 'rgba(246,242,234,0.28)'; x.beginPath(); x.arc(px, py, cr, 0, 7); x.fill();
      // pavimento: disco scuro dai bordi netti
      x.fillStyle = 'rgba(86,88,96,0.34)'; x.beginPath(); x.arc(px, py, cr * 0.82, 0, 7); x.fill();
      // parete in ombra: sole da alto-sinistra → interno alto-sinistra buio
      g = x.createRadialGradient(px - cr * 0.5, py - cr * 0.5, cr * 0.05, px - cr * 0.3, py - cr * 0.3, cr * 0.9);
      g.addColorStop(0, 'rgba(36,38,46,0.5)'); g.addColorStop(1, 'rgba(36,38,46,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px, py, cr * 0.82, 0, 7); x.fill();
      // bordo interno in ombra (basso-destra, ombra portata dal crest opposto)
      x.strokeStyle = 'rgba(30,32,40,0.25)'; x.lineWidth = Math.max(0.5, Math.min(cr * 0.08, 2));
      x.beginPath(); x.arc(px, py, cr * 0.82, Math.PI * 0.02, Math.PI * 0.98); x.stroke();
      // crest illuminato (lato sole, alto-sinistra)
      x.strokeStyle = 'rgba(255,252,244,0.55)'; x.lineWidth = Math.max(0.6, Math.min(cr * 0.10, 2.4));
      x.beginPath(); x.arc(px, py, cr * 0.97, Math.PI * 1.02, Math.PI * 1.98); x.stroke();
      // picco centrale sui crateri grandi
      if (cr > R * 0.026) { x.fillStyle = 'rgba(232,228,220,0.35)'; x.beginPath(); x.arc(px + cr * 0.12, py + cr * 0.12, cr * 0.13, 0, 7); x.fill(); }
    }
    // due crateri giovani con sistema di raggi (stile Tycho/Copernico)
    if (R > 24) {
      for (const [tx, ty, tr] of [[0.12, 0.42, 0.05], [-0.30, -0.05, 0.04]]) {
        const px = cx + tx * R, py = cy + ty * R;
        x.strokeStyle = 'rgba(240,238,232,0.10)';
        for (let k = 0; k < 22; k++) {
          const a = rnd() * Math.PI * 2, len = tr * R * (3 + rnd() * 7);
          x.lineWidth = Math.max(0.5, tr * R * (0.04 + rnd() * 0.10));
          x.beginPath(); x.moveTo(px + Math.cos(a) * tr * R, py + Math.sin(a) * tr * R);
          x.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); x.stroke();
        }
        x.fillStyle = 'rgba(250,248,242,0.16)'; x.beginPath(); x.arc(px, py, tr * R * 0.7, 0, 7); x.fill();
      }
    }
    x.restore();
    x.strokeStyle = 'rgba(20,22,28,0.5)'; x.lineWidth = 1;
    x.beginPath(); x.arc(cx, cy, R - 0.5, 0, 7); x.stroke();
    this._moonCache.set(R, c);
    return c;
  }

  /** Dust ejecta: polvere lunare sollevata dai getti sotto i 200 m. */
  _dustFrame(ctx, cx, gy, thrust, dt, asc) {
    const D = this._dust || (this._dust = []);
    if (thrust > 0.05) {
      const n = Math.round(thrust * 9);
      for (let i = 0; i < n; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        D.push({
          x: cx + (Math.random() - 0.5) * 46,
          y: gy - Math.random() * 6,
          vx: side * (130 + Math.random() * 300) * (0.5 + thrust * 0.6),
          vy: -(20 + Math.random() * 90) * (asc ? 1.4 : 1),
          age: 0, life: 0.8 + Math.random() * 0.9,
          r: 3 + Math.random() * 7,
        });
      }
      if (D.length > 340) D.splice(0, D.length - 340);
    }
    for (let i = D.length - 1; i >= 0; i--) {
      const d = D[i];
      d.age += dt;
      if (d.age >= d.life) { D.splice(i, 1); continue; }
      d.x += d.vx * dt; d.y += d.vy * dt;
      d.vy += 150 * dt;
      d.vx *= 0.985; d.r += 9 * dt;
      const k = 1 - d.age / d.life;
      const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r * 2);
      g.addColorStop(0, 'rgba(206, 196, 180, ' + (0.34 * k).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(180, 170, 156, 0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r * 2, 0, 7); ctx.fill();
    }
  }

  /* -------- ATTO 0: LANCIO VERTICALE TERRESTRE (cinematica, pre-simulazione) -------- */

  /** Avvia la sequenza di lancio. onEvent(name) per narrazione CapCom. */
  startAct0(mid, onEvent) {
    if (!this.cine.els) return false;
    const E = this.cine.els;
    this.cine.active = true;
    E.vp.style.display = 'block';
    E.vp.classList.add('act0');
    E.exit.style.display = 'none';
    this.canvas.style.display = 'none'; // mappa orbitale spenta fino alla LEO
    E.pad.src = 'assets/img/launch_pad_key.png';
    E.smoke.src = 'assets/img/launch_smoke_key.png';
    this._plume = [];
    this.act0 = { t: 0, dur: 26, scroll: 0, thrust: 0, mid: mid === 'SPACEX' ? 'SPACEX' : 'CNSA', done: false, fired: {}, onEvent: onEvent || (() => {}) };
    return true;
  }

  endAct0() {
    if (!this.cine.els) return;
    const E = this.cine.els;
    this.act0 = null;
    E.pad.style.display = 'none';
    E.smoke.style.display = 'none';
    E.booster.style.display = 'none';
    E.stage2.style.display = 'none';
    this._plume = [];
    E.vp.classList.remove('act0');
    E.exit.style.display = '';
    E.vp.style.display = 'none';
    E.vp.style.background = '';
    E.bg.style.backgroundImage = '';
    E.bg.style.filter = '';
    E.bg.style.inset = ''; E.bg.style.left = ''; E.bg.style.width = '';
    E.bg.style.top = ''; E.bg.style.height = ''; E.bg.style.transform = '';
    E.bg.style.transformOrigin = ''; E.bg.style.objectFit = ''; E.bg.style.objectPosition = '';
    E.lander.style.filter = '';
    E.lander.style.display = ''; // lo staging dell'Atto 0 lo aveva nascosto
    this.canvas.style.display = '';
    this.cine.active = false;
  }

  /** Frame cinematico Atto 0: rampa, countdown, fiamme particellari, staging, ascesa. */
  actFrame(dtReal) {
    const A = this.act0, E = this.cine.els;
    if (!A || !E) return;
    A.t += dtReal;
    const CD = 10, ASC = 16;
    const onPad = A.t < CD;
    const t = onPad ? 0 : Math.min(1, (A.t - CD) / ASC);
    const fire = (key, at) => { if (!A.fired[key] && A.t >= at) { A.fired[key] = 1; A.onEvent(key); } };
    const STG = 0.53; // staging a ~78 km
    fire('PAD_GO', 0.4); fire('T4', CD - 4); fire('IGNITION', CD - 3); fire('LIFTOFF', CD + 0.2);
    fire('MAXQ', CD + 0.34 * ASC);
    fire('MECO', CD + STG * ASC);
    fire('STAGE', CD + (STG + 0.06) * ASC);
    fire('SES', CD + (STG + 0.12) * ASC);
    fire('SECO', CD + 0.985 * ASC);

    // --- modello spinta (0..1): rampa al T-3, MECO, secondo stadio ---
    let thrust = 0;
    if (onPad) { if (A.t >= CD - 3) thrust = Math.min(1, (A.t - (CD - 3)) / 1.2); }
    else if (t < STG) thrust = 1;
    else if (t < STG + 0.04) thrust = 1 - (t - STG) / 0.04;
    else if (t < STG + 0.12) thrust = 0;
    else thrust = Math.min(1, (t - STG - 0.12) / 0.08);
    A.thrust = thrust;
    const staged = t >= STG + 0.06;
    const stageAge = staged ? A.t - (CD + (STG + 0.06) * ASC) : 0;

    const dpr = window.devicePixelRatio || 1;
    const W = this.w, H = this.h;
    if (E.overlay.width !== Math.round(W * dpr) || E.overlay.height !== Math.round(H * dpr)) {
      E.overlay.width = Math.round(W * dpr); E.overlay.height = Math.round(H * dpr);
    }
    const ctx = this._cineCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // --- sfondo atmosfera ---
    A.scroll += onPad ? 6 * dtReal : (60 + 1500 * t * t) * dtReal;
    E.bg.style.backgroundImage = 'url(assets/img/atmo_launch.png)';
    E.bg.style.transform = 'scale(' + (1.05 + (onPad ? 0 : 0.55 * t)).toFixed(3) + ')';
    E.bg.style.filter = 'url(#heat-haze) brightness(' + (1 - (onPad ? 0 : 0.5 * t)).toFixed(2) + ')';
    E.vp.style.background = 'rgba(2, 4, 10, ' + (onPad ? 0.04 : (0.04 + 0.82 * Math.pow(t, 1.7))).toFixed(3) + ')';
    const disp = document.getElementById('heat-disp');
    if (disp) disp.setAttribute('scale', String(onPad ? 6 : Math.max(2, 20 - 18 * t)));

    // --- geometria ---
    const padY = onPad ? 0 : H * 1.25 * Math.pow(t, 0.85);
    const padFade = onPad ? 1 : Math.max(0, 1 - t / 0.28);
    const yOff = onPad ? H * 0.125 : H * (0.125 - 0.19 * Math.pow(t, 1.15));
    const shake = thrust > 0.05 && A.t < CD + 2 ? (Math.random() * 3 - 1.5) * thrust : 0;
    const rScale = onPad ? 1.0 : 1.15 - 0.35 * t;
    const tilt = onPad || t < 0.74 ? 0 : -(t - 0.74) * 0.9;
    const baseY = H / 2 + yOff + 150 * rScale; // ugelli (stack intero)

    // --- rampa ---
    E.pad.style.display = padFade > 0.01 ? 'block' : 'none';
    E.pad.style.opacity = padFade.toFixed(2);
    E.pad.style.transform = 'translateX(-50%) translateY(' + padY.toFixed(0) + 'px)';

    // --- fumo di rampa (T-3) ---
    const smokeOn = A.t >= CD - 3 && !staged;
    if (smokeOn) {
      const gs = Math.min(1, (A.t - (CD - 3)) / 2.2);
      const rise = onPad ? 0 : Math.min(1, t / 0.18);
      E.smoke.style.display = 'block';
      E.smoke.style.left = '50%';
      E.smoke.style.top = (baseY + rise * H * 0.5).toFixed(0) + 'px';
      E.smoke.style.opacity = (0.95 * gs * (onPad ? 1 : Math.max(0, 1 - t / 0.30))).toFixed(2);
      E.smoke.style.transform = 'translate(-50%,-50%) scale(' + (0.25 + 1.5 * gs).toFixed(2) + ', ' + (0.4 + 0.7 * gs).toFixed(2) + ')';
    } else E.smoke.style.display = 'none';

    // --- sprite: stack / booster+stage2 ---
    const key = 'A0' + A.mid;
    if (E.lander.dataset.mid !== key) {
      E.lander.src = this._cineSprites[A.mid === 'SPACEX' ? 'SH' : 'LM10'].src;
      E.lander.dataset.mid = key;
    }
    if (!staged) {
      E.lander.style.display = '';
      E.booster.style.display = 'none';
      E.stage2.style.display = 'none';
      E.lander.style.transform = 'translate(calc(-50% + ' + shake.toFixed(1) + 'px), calc(-50% + ' + yOff.toFixed(0) + 'px)) rotate(' + tilt.toFixed(3) + 'rad) scale(' + rScale.toFixed(3) + ')';
      E.lander.style.filter = 'url(#heat-haze) drop-shadow(0 0 ' + (10 + 40 * thrust).toFixed(0) + 'px rgba(255,170,80,' + (0.15 + 0.55 * thrust).toFixed(2) + '))';
    } else {
      // le due metà sono lo stesso sprite ritagliato: la linea di separazione
      // coincide per costruzione, zero "pop" visivo al distacco
      E.lander.style.display = 'none';
      const split = A.mid === 'SPACEX' ? 0.42 : 0.30; // frazione alta = stadio superiore
      if (E.booster.dataset.mid !== key) { E.booster.src = E.lander.src; E.stage2.src = E.lander.src; E.booster.dataset.mid = key; }
      E.booster.style.clipPath = 'inset(' + (split * 100).toFixed(0) + '% 0 0 0)';
      E.stage2.style.clipPath = 'inset(0 0 ' + ((1 - split) * 100).toFixed(0) + '% 0)';
      const fall = 55 * stageAge + 130 * stageAge * stageAge;
      E.booster.style.display = 'block';
      E.booster.style.opacity = Math.max(0, 1 - stageAge / 2.4).toFixed(2);
      E.booster.style.transform = 'translate(-50%, calc(-50% + ' + (yOff + fall).toFixed(0) + 'px)) rotate(' + (0.3 * stageAge).toFixed(3) + 'rad) scale(' + rScale.toFixed(3) + ')';
      E.stage2.style.display = 'block';
      E.stage2.style.transform = 'translate(calc(-50% + ' + shake.toFixed(1) + 'px), calc(-50% + ' + yOff.toFixed(0) + 'px)) rotate(' + tilt.toFixed(3) + 'rad) scale(' + rScale.toFixed(3) + ')';
      E.stage2.style.filter = 'url(#heat-haze) drop-shadow(0 0 ' + (10 + 40 * thrust).toFixed(0) + 'px rgba(255,170,80,' + (0.15 + 0.55 * thrust).toFixed(2) + '))';
    }

    // --- pennacchio: nucleo fiamma + particelle ---
    const split0 = A.mid === 'SPACEX' ? 0.42 : 0.30;
    const pbY = staged ? H / 2 + yOff + 150 * rScale * (2 * split0 - 1) : baseY;
    this._plumeFrame(ctx, W, H, W / 2 + shake, pbY, thrust, rScale, dtReal, A.t);
    // flash di riaccensione secondo stadio
    const sesAge = A.t - (CD + (STG + 0.12) * ASC);
    if (sesAge > 0 && sesAge < 0.5) {
      const fa = 1 - sesAge / 0.5;
      const fg = ctx.createRadialGradient(W / 2, pbY, 4, W / 2, pbY, 260 * fa + 60);
      fg.addColorStop(0, 'rgba(255, 255, 240, ' + (0.9 * fa).toFixed(2) + ')');
      fg.addColorStop(0.4, 'rgba(255, 200, 120, ' + (0.5 * fa).toFixed(2) + ')');
      fg.addColorStop(1, 'rgba(255, 160, 60, 0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }

    // --- scie di nuvole (ascesa) ---
    const cloudA = onPad ? 0 : Math.max(0, 0.30 - 0.30 * t);
    if (cloudA > 0.01) {
      for (let i = 0; i < 9; i++) {
        const cy = ((A.scroll * (0.5 + 0.12 * i) + i * 431) % (H + 260)) - 130;
        const cx2 = (i * 211 + 60) % W;
        const g = ctx.createRadialGradient(cx2, cy, 4, cx2, cy, 150);
        g.addColorStop(0, 'rgba(235, 245, 255, ' + (cloudA * 0.8).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(235, 245, 255, 0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.ellipse(cx2, cy, 160, 34, 0, 0, 7); ctx.fill();
      }
    }

    // --- testo HUD ---
    ctx.shadowColor = 'rgba(0, 6, 14, 0.95)';
    ctx.shadowBlur = 8;
    if (onPad) {
      const rem = Math.max(0, Math.ceil(CD - A.t));
      ctx.textAlign = 'center';
      ctx.font = '700 84px "Share Tech Mono", monospace';
      ctx.fillStyle = rem <= 3 ? '#ffb347' : '#e8f6ff';
      ctx.fillText('T\u2212 0:' + String(rem).padStart(2, '0'), W / 2, H * 0.155);
      ctx.font = '13px "Share Tech Mono", monospace';
      ctx.fillStyle = '#9fe8ff';
      ctx.fillText(A.mid === 'SPACEX' ? 'STARBASE \u2014 PAD 39-A' : 'TAIYUAN \u2014 PAD 101', W / 2, H * 0.155 + 26);
      ctx.fillStyle = thrust > 0 ? '#7cffb2' : '#67788c';
      ctx.fillText(thrust > 0 ? 'MOTORI \u2014 SPINTA ' + Math.round(thrust * 100) + '\%' : 'SEQUENZA AUTOMATICA IN CORSO', W / 2, H * 0.155 + 50);
      ctx.textAlign = 'left';
    } else {
      const altKm = 246 * Math.pow(t, 1.85);
      const vel = 2.461 * Math.pow(t, 1.45);
      ctx.font = '700 30px "Share Tech Mono", monospace';
      ctx.fillStyle = '#e8f6ff';
      const tt = Math.round(t * ASC * 4);
      ctx.fillText('T+ ' + String(Math.floor(tt / 60)).padStart(2, '0') + ':' + String(tt % 60).padStart(2, '0'), 34, 66);
      ctx.font = '12px "Share Tech Mono", monospace';
      ctx.fillStyle = '#8a93a6';
      ctx.fillText('QUOTA', 34, 84);
      ctx.font = '700 26px "Share Tech Mono", monospace';
      ctx.fillStyle = '#9fe8ff';
      ctx.fillText(altKm < 100 ? altKm.toFixed(1) + ' km' : Math.round(altKm) + ' km', 34, 118);
      ctx.font = '15px "Share Tech Mono", monospace';
      ctx.fillStyle = '#cfe3ff';
      ctx.fillText('V   ' + vel.toFixed(3) + ' km/s', 34, 148);
      ctx.fillText('SPINTA  ' + Math.round(thrust * 100) + ' %', 34, 172);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#8a93a6';
      ctx.fillText((staged ? (A.mid === 'SPACEX' ? 'STARSHIP' : 'MENGZHOU + YF-75') : (A.mid === 'SPACEX' ? 'SUPER HEAVY + STARSHIP' : 'LUNGA MARCIA 10')) + ' \u2014 ATTO 0', W - 34, 66);
      if (t < 0.98) {
        ctx.fillStyle = t > 0.30 && t < 0.42 ? '#ffb347' : '#67788c';
        ctx.fillText(t > 0.30 && t < 0.42 ? 'MAX-Q \u2014 PRESSIONE DINAMICA PICCO'
          : staged ? 'SECONDO STADIO \u2014 INSERZIONE ORBITALE' : 'ASCESA VERTICALE NOMINALE', W - 34, 88);
      }
      if (A.fired.MECO && stageAge < 2.2) {
        ctx.textAlign = 'center';
        ctx.font = '700 22px "Share Tech Mono", monospace';
        ctx.fillStyle = stageAge < 1 ? '#ffb347' : '#7cffb2';
        ctx.fillText(stageAge < 1 ? 'MECO \u2014 MOTORE PRIMO STADIO OFF' : 'SEPARAZIONE CONFERMATA \u2014 SES', W / 2, H - 120);
      }
      ctx.textAlign = 'left';
    }
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.fillStyle = 'rgba(160, 190, 220, 0.55)';
    ctx.textAlign = 'center';
    ctx.fillText('SPAZIO / click per saltare la sequenza', W / 2, H - 26);
    ctx.textAlign = 'left';
    ctx.shadowBlur = 0;
    if (A.t >= CD + ASC) A.done = true;
  }

  /** Pennacchio: nucleo fiamma continuo + particelle (fiamma additiva + fumo). */
  _plumeFrame(ctx, W, H, bx, by, thrust, rScale, dt, seed) {
    const P = this._plume;
    if (thrust > 0.02) {
      const n = Math.round(thrust * 16);
      for (let i = 0; i < n; i++) {
        const smoke = Math.random() < 0.38;
        P.push({
          x: bx + (Math.random() - 0.5) * 30 * rScale,
          y: by + Math.random() * 8,
          vx: (Math.random() - 0.5) * (smoke ? 90 : 55),
          vy: (smoke ? 120 : 300) * (0.6 + 0.6 * thrust) * rScale,
          age: 0, life: smoke ? 1.4 + Math.random() : 0.35 + Math.random() * 0.3,
          r: (smoke ? 10 : 5) * rScale * (0.6 + Math.random() * 0.8),
          smoke: smoke,
        });
      }
      if (P.length > 520) P.splice(0, P.length - 520);
      // nucleo fiamma (teardrop)
      const flick = 1 + 0.14 * Math.sin(seed * 41) + (Math.random() - 0.5) * 0.12;
      const L = (46 + 105 * thrust) * rScale * flick;
      const w = 26 * rScale * (0.65 + 0.35 * thrust);
      const fg = ctx.createLinearGradient(bx, by, bx, by + L);
      fg.addColorStop(0, 'rgba(255, 255, 245, 0.95)');
      fg.addColorStop(0.25, 'rgba(255, 214, 130, 0.9)');
      fg.addColorStop(0.65, 'rgba(255, 120, 30, 0.55)');
      fg.addColorStop(1, 'rgba(255, 60, 0, 0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(bx - w / 2, by);
      ctx.quadraticCurveTo(bx - w * 0.36, by + L * 0.55, bx, by + L);
      ctx.quadraticCurveTo(bx + w * 0.36, by + L * 0.55, bx + w / 2, by);
      ctx.closePath();
      ctx.fill();
      // dischi di Mach
      for (let d = 1; d <= 3; d++) {
        const dy = by + L * (0.22 + 0.18 * d);
        ctx.fillStyle = 'rgba(255, 245, 220, ' + (0.28 - 0.06 * d).toFixed(2) + ')';
        ctx.beginPath();
        ctx.ellipse(bx, dy, w * (0.42 - 0.07 * d), 3.4 * rScale, 0, 0, 7);
        ctx.fill();
      }
    }
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.age += dt;
      if (p.age >= p.life) { P.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.smoke) { p.vy -= 55 * dt; p.vx *= 0.985; p.r += 26 * dt; }
      else p.vy *= 0.99;
      const k = 1 - p.age / p.life;
      if (p.smoke) {
        ctx.fillStyle = 'rgba(205, 208, 216, ' + (0.22 * k).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      } else {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 2.2);
        g.addColorStop(0, 'rgba(255, 235, 190, ' + (0.85 * k).toFixed(3) + ')');
        g.addColorStop(0.5, 'rgba(255, 140, 40, ' + (0.5 * k).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255, 60, 0, 0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 2.2, 0, 7); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  _tactical(sim, mo, altM, ui) {
    const ctx = this.ctx;
    const s = sim.ship;
    const R = sim.astro.moon.radius;
    const W = 340, H = 216;
    const x0 = this.w - W - 16, y0 = this.h - H - 16;
    const ang = Math.atan2(s.y - mo.y, s.x - mo.x);
    const altWin = Math.max(altM * 1.3, 900);
    const distWin = Math.max(altM * 2.4, 3500);
    const mx = (d) => x0 + 10 + (d + distWin) / (2 * distWin) * (W - 20);
    const my = (h) => y0 + H - 30 - Math.max(0, Math.min(1, h / altWin)) * (H - 58);
    ctx.save();
    ctx.fillStyle = 'rgba(4,8,16,0.88)';
    ctx.strokeStyle = 'rgba(77,216,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x0, y0, W, H, 8); ctx.fill(); ctx.stroke();
    // cielo lunare fotorealistissimo dietro il profilo (clippato al pannello)
    if (this._lunarImg.complete && this._lunarImg.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath(); ctx.roundRect(x0, y0, W, H, 8); ctx.clip();
      ctx.globalAlpha = 0.30;
      const iw = this._lunarImg.naturalWidth, ih = this._lunarImg.naturalHeight;
      const sc = Math.max(W / iw, (H * 0.62) / ih);
      ctx.drawImage(this._lunarImg, x0 + (W - iw * sc) / 2, y0 + H * 0.38 - ih * sc * 0.5, iw * sc, ih * sc);
      ctx.restore();
    }
    ctx.font = '10px monospace';
    ctx.fillStyle = COL.pred;
    ctx.fillText('VISTA TATTICA — SUPERFICIE LUNARE', x0 + 10, y0 + 16);
    // griglia quota
    ctx.strokeStyle = 'rgba(120,140,170,0.18)';
    for (let g = 1; g <= 3; g++) {
      const gy = my(altWin * g / 4);
      ctx.beginPath(); ctx.moveTo(x0 + 8, gy); ctx.lineTo(x0 + W - 8, gy); ctx.stroke();
    }
    // profilo del terreno
    ctx.beginPath();
    ctx.moveTo(mx(-distWin), y0 + H - 30);
    const N = 130;
    for (let i = 0; i <= N; i++) {
      const d = -distWin + (2 * distWin) * i / N;
      ctx.lineTo(mx(d), my(terrainHeight(ang + d / R)));
    }
    ctx.lineTo(mx(distWin), y0 + H - 30);
    ctx.closePath();
    ctx.fillStyle = 'rgba(150,155,168,0.30)';
    ctx.strokeStyle = COL.moon;
    ctx.lineWidth = 1.2;
    ctx.fill(); ctx.stroke();
    // cono LiDAR: 15 raggi da nadir ±32° — verde se zona atterrabile
    // (pendio locale < 3° E velocità di discesa entro i limiti), rosso se no
    const shipX = mx(0), shipY = my(altM);
    const dvx0 = s.vx - mo.vx, dvy0 = s.vy - mo.vy;
    const ux0 = Math.cos(ang), uy0 = Math.sin(ang);
    const vUpNow = Math.abs(dvx0 * ux0 + dvy0 * uy0);
    const vOk = vUpNow < 12 && Math.abs(-dvx0 * uy0 + dvy0 * ux0) < 15;
    for (let i = 0; i <= 14; i++) {
      const a = (-32 + 64 * i / 14) * Math.PI / 180;
      let d = Math.tan(a) * altM;
      d = Math.max(-distWin, Math.min(distWin, d));
      const ta = ang + d / R;
      const safe = terrainSlope(ta) < 3 && vOk;
      ctx.strokeStyle = safe ? 'rgba(124,255,178,0.5)' : 'rgba(255,92,92,0.42)';
      ctx.beginPath(); ctx.moveTo(shipX, shipY); ctx.lineTo(mx(d), my(terrainHeight(ta))); ctx.stroke();
    }
    // sito di atterraggio (scelto dal GNC/autopilota)
    if (ui.site) {
      let d = ui.site.angle - ang;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      d *= R;
      if (Math.abs(d) < distWin) {
        const hx = mx(d), hy = my(terrainHeight(ui.site.angle));
        ctx.strokeStyle = COL.prograde; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(hx, hy, 7, 0, 7); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(hx - 13, hy); ctx.lineTo(hx + 13, hy); ctx.stroke();
        ctx.fillStyle = COL.prograde;
        ctx.fillText('SITO ' + ui.site.slope.toFixed(1) + '°', hx - 20, hy - 12);
      }
    }
    // nave + vettori
    ctx.fillStyle = COL.ship;
    ctx.beginPath(); ctx.arc(shipX, shipY, 4, 0, 7); ctx.fill();
    const dvx = s.vx - mo.vx, dvy = s.vy - mo.vy;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const vUp = dvx * ux + dvy * uy;
    const vHor = -dvx * uy + dvy * ux;
    // telemetria
    ctx.font = '11px monospace';
    const row = y0 + H - 14;
    ctx.fillStyle = altM < 100 ? COL.prograde : '#cfe3ff';
    ctx.fillText('ALT ' + fmtLen(altM).padEnd(9), x0 + 10, row);
    ctx.fillStyle = vUp < -15 ? COL.flameHot : '#cfe3ff';
    ctx.fillText('V/S ' + vUp.toFixed(1).padStart(7) + ' m/s', x0 + 118, row);
    ctx.fillStyle = '#8a93a6';
    ctx.fillText('V OR ' + Math.abs(vHor).toFixed(1) + ' m/s', x0 + 248, row);
    ctx.restore();
  }
}

/* ---------------- HUD (aggiornamento DOM) ---------------- */

export class Hud {
  constructor() {
    this.el = {};
    const ids = ['mission', 'met', 'warp', 'status', 'body', 'alt', 'vel', 'ap', 'pe', 'ecc', 'sma',
      'dv-active', 'dv-total', 'prop-pct', 'prop-bar', 'throttle-pct', 'throttle-bar', 'engine',
      'mass', 'moon-dist', 'soi', 'ticker', 'banner', 'node-info', 'help', 'dir-phase', 'dir-text',
      'vs', 'gload', 'terrain', 'fault', 'qheat', 'chute', 'blackout'];
    for (const id of ids) this.el[id] = document.getElementById(id);
  }

  update(sim, el, pred, ui) {
    const E = this.el;
    if (!E.met) return;
    E.mission.textContent = sim.mission.label;
    E.met.textContent = fmtMET(sim.t);
    E.warp.textContent = ui.warp + 'x' + (ui.warpLimited ? ' [LIMITED]' : '');
    E.status.textContent = sim.status;
    const GOOD = ['NOMINAL', 'TOUCHDOWN', 'DOCKED', 'SPLASHDOWN'];
    E.status.className = 'val ' + (sim.status === 'NOMINAL' ? 'ok' : GOOD.includes(sim.status) ? 'good' : 'bad');
    E.body.textContent = el.bodyName + (el.inMoonSOI ? ' (SOI)' : '');
    E.alt.textContent = fmtLen(el.r - el.radius);
    E.vel.textContent = fmtVel(el.v);
    E.ap.textContent = el.escape ? 'FUGA ∞' : fmtLen(el.altAp);
    E.pe.textContent = fmtLen(el.altPe) + (el.altPe < 0 ? ' ⚠' : '');
    E.ecc.textContent = el.e.toFixed(4) + (el.escape ? ' (HIP)' : '');
    E.sma.textContent = el.escape ? '—' : fmtLen(el.a);
    E['dv-active'].textContent = fmtVel(sim.dvActive);
    E['dv-total'].textContent = fmtVel(sim.dvTotal);
    const pp = sim.propellantCapacity > 0 ? sim.propellantTotal / sim.propellantCapacity : 0;
    E['prop-pct'].textContent = (pp * 100).toFixed(1) + ' %';
    E['prop-bar'].style.width = (pp * 100).toFixed(1) + '%';
    E['throttle-pct'].textContent = Math.round(sim.ship.throttle * 100) + ' %';
    E['throttle-bar'].style.width = Math.round(sim.ship.throttle * 100) + '%';
    E.engine.textContent = sim.activeGroup ? sim.activeGroup.name : '—';
    E.mass.textContent = fmtMass(sim.mass);
    E['moon-dist'].textContent = fmtLen(el.distToMoon);
    E.soi.textContent = el.inMoonSOI ? 'DENTRO SOI LUNARE' : 'SPAZIO CISLUNARE';
    E.soi.className = 'val ' + (el.inMoonSOI ? 'good' : '');

    // --- DISCESA / SALITA: quota terreno, V/S, G, quad motori ---
    const mo = moonState(sim.t, sim.astro);
    const altM = Math.hypot(sim.ship.x - mo.x, sim.ship.y - mo.y) - sim.astro.moon.radius;
    const angM = Math.atan2(sim.ship.y - mo.y, sim.ship.x - mo.x);
    const dvx = sim.ship.vx - mo.vx, dvy = sim.ship.vy - mo.vy;
    const vUp = dvx * Math.cos(angM) + dvy * Math.sin(angM);
    if (E.vs) {
      E.vs.textContent = (altM < 60e3 ? vUp.toFixed(1) + ' m/s' : '—');
      E.vs.className = 'val ' + (altM < 60e3 && vUp < -25 ? 'bad' : altM < 60e3 ? 'good' : '');
    }
    if (E.terrain) E.terrain.textContent = altM < 60e3 ? fmtLen(Math.max(0, altM - terrainHeight(angM))) : '—';
    if (E.gload) {
      E.gload.textContent = sim.gLoad.toFixed(2) + ' g (max ' + sim.gMax.toFixed(1) + ')';
      E.gload.className = 'val ' + (sim.gLoad > 4 ? 'bad' : sim.gLoad > 1.5 ? 'hl' : '');
    }
    if (E.fault) {
      const f = sim.thrustFactor < 1;
      E.fault.textContent = f ? '3/4 — FAULT' : '4/4 OK';
      E.fault.className = 'val ' + (f ? 'bad' : 'good');
    }
    // --- pannello RIENTRO: valori REALI (W/m², stadio paracadute, blackout) ---
    const altER = hReal(Math.hypot(sim.ship.x, sim.ship.y) - sim.astro.earth.radius);
    const inRet = altER > 0 && altER < 130e3;
    if (E.qheat) {
      const kw = sim.qHeat / 1000;
      E.qheat.textContent = inRet && sim.qHeat > 0 ? kw.toFixed(1) + ' kW/m²' : '—';
      E.qheat.className = 'val ' + (kw > 10 ? 'bad' : kw > 4 ? 'hl' : kw > 0 ? 'good' : '');
    }
    if (E.chute) {
      E.chute.textContent = sim.chuteStage === 'main' ? 'PRINCIPALI \u00d7 4' : sim.chuteStage === 'drogue' ? 'DROGA' : '—';
      E.chute.className = 'val ' + (sim.chuteStage ? 'good' : '');
    }
    if (E.blackout) {
      E.blackout.textContent = sim.blackout ? 'BLACKOUT PLASMA' : inRet ? 'ATTIVO' : '—';
      E.blackout.className = 'val ' + (sim.blackout ? 'bad' : inRet ? 'good' : '');
    }

    // predizione: esito
    let predTxt = '—';
    if (pred) {
      if (pred.events.impact) predTxt = 'IMPATTO ' + (pred.events.impact.body === 'moon' ? 'LUNA' : 'TERRA') + ' T+' + fmtMET(pred.points[pred.events.impact.i].t - sim.t);
      else if (pred.events.soiEntry) predTxt = 'SOI LUNARE T+' + fmtMET(pred.points[pred.events.soiEntry.i].t - sim.t);
      else predTxt = 'NESSUN INTERCETTAMENTO';
    }
    E['node-info'].textContent = ui.node && ui.node.active
      ? 'NODE: ' + (ui.node.dv >= 0 ? 'PRO ' : 'RETRO ') + Math.abs(ui.node.dv).toFixed(0) + ' m/s @ T+' + fmtMET(Math.max(0, ui.node.time - sim.t)) + ' | ' + predTxt
      : 'PRED: ' + predTxt;

    // ticker eventi (ultimi 4)
    const evs = sim.events.slice(-4).reverse();
    E.ticker.innerHTML = evs.map(e =>
      '<div class="ev ev-' + e.kind + '">[' + fmtMET(e.t) + '] ' + e.text + '</div>').join('');

    // banner centrale
    const BANNER = {
      TOUCHDOWN: ['✔ ALLUNAGGIO — 4/4 YF-36 al suolo (premi 0 per ripetere)', 'good'],
      DOCKED: ['✔ AGGANCIO — Mengzhou catturata, ponte in corso', 'good'],
      SPLASHDOWN: ['✔ AMMARAGGIO — missione completata (0 per ripetere)', 'good'],
    };
    if (sim.status !== 'NOMINAL') {
      const b = BANNER[sim.status] || ['✖ IMPATTO — PREMI 0 PER RIPETERE', 'bad'];
      E.banner.innerHTML = b[0] + (sim.status === 'SPLASHDOWN'
        ? '<div class="banner-credits">by <b>AMXSTUDIO</b> &copy; 2025 &mdash; CISLUNAR 2030</div>' : '');
      E.banner.className = 'banner ' + b[1];
      E.banner.style.display = 'block';
    } else E.banner.style.display = 'none';
  }

  /** Indicatore ON AIR: lampeggio mentre la radio (TTS) sta parlando. */
  onAir(on) {
    const d = document.getElementById('director');
    if (d) d.classList.toggle('onair', !!on);
  }

  /** Pannello "Mission Director Voice": narrazione didattica della fase corrente. */
  director(phase, text) {
    if (!this.el['dir-text']) return;
    this.el['dir-phase'].textContent = phase;
    this.el['dir-text'].textContent = text;
    // ri-triggera l'animazione di ingresso
    this.el['dir-text'].style.animation = 'none';
    void this.el['dir-text'].offsetWidth;
    this.el['dir-text'].style.animation = '';
  }
}