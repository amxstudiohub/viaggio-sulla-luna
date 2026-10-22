/**
 * CISLUNAR 2030 — Autopilota GNC (systems/autopilot.js)
 * ======================================================
 * Macchina a stati che pilota DA SOLA l'intera missione:
 *   F1 SETUP      -> finestra TLI (scan burn-finito), node, allineamento
 *   F2 TLI        -> accensione prograde, MECO a Δv
 *   F3 CRUISE     -> warp dinamico, decelerazione near-SOI
 *   F4 SOI+LOI    -> frame lunare, retrograde al periapside -> orbita chiusa
 *   F5 STAGE      -> separazione PM (crasher) con deorbit
 *   F6 DESAT      -> deorbitazione: perilune ~16 km + frenata al periapside
 *   F7 DISCESA    -> LiDAR + DescentGNC (PID) -> TOUCHDOWN; fault diagonale YF-36
 *   F8 ASCESA     -> AscentGNC dal suolo -> orbita a 20 km
 *   F9 RENDEZVOUS -> MATCH, impulsi di fase, deriva, molla CW -> DOCKED
 *   F10 TEI       -> scan corridoio, burn, impulsi di correzione a meta' crociera
 *   F11 RIENTRO   -> skip re-entry con portanza, paracadute -> SPLASHDOWN
 *   DONE          -> ammaraggio completato (o demo F1-F5 se demoEnd)
 *
 * Modulo PURO (no DOM): comanda sim/warp/node iniettati, narra via callback.
 * Testabile in node: tests/autopilot.test.mjs + tests/phase2.test.mjs.
 */

import { G0 } from '../data/spacecraft_specs.js';
import { orbitalElements } from './planner.js';
import { predictTrajectory, moonState, progradeUnit, ATM } from '../core/physics.js';
import { DescentGNC, AscentGNC } from './descent.js';
import { findFlatSite } from './terrain.js';

export const PHASE = {
  IDLE: "IDLE", SETUP: "F1 PIANIFICAZIONE", TLI: "F2 ACCENSIONE TLI",
  CRUISE: "F3 CROCIERA", SOI: "F4 SOI LUNARE", LOI: "F4 INSERZIONE LUNARE",
  STAGE: "F5 SEPARAZIONE PM", DESAT: "F6 DEORBITAZIONE",
  DISCESA: "F7 DISCESA TATTICA", ASCESA: "F8 RISALITA LUNARE",
  RENDEZVOUS: "F9 RENDEZVOUS", TEI: "F10 INIEZIONE TERRA",
  RIENTRO: "F11 RIENTRO SKIP", DONE: "MISSIONE COMPLETATA",
};

const fmtH = s => (s / 3600).toFixed(1) + " h";
const fmtKm = m => (m / 1e3).toFixed(0) + " km";

export class Autopilot {
  constructor(sim, { warp, node, narrate = () => {}, demoEnd = false }) {
    this.sim = sim; this.warp = warp; this.node = node; this.narrate = narrate;
    this.active = false; this.phase = PHASE.IDLE;
    this.plan = null; this.burn = null; this.flags = {};
    this.demoEnd = demoEnd;
    this.gnc = null; this.rz = null; this.tei = null;
  }

  /* ---------------- API pubblica ---------------- */

  engage() {
    if (this.active) return;
    this.active = true; this.flags = {}; this.plan = null; this.burn = null;
    this.gnc = null; this.rz = null; this.tei = null;
    const el = orbitalElements(this.sim.ship, this.sim.t);
    this.narrate("AUTOPILOTA GNC ONLINE. Valuto la geometria di missione corrente...", "SISTEMA");
    if (el.inMoonSOI) this.enter(PHASE.SOI);
    else if (!el.escape && el.apoapsis > this.sim.astro.distance * 0.6) this.enter(PHASE.CRUISE);
    else this.enter(PHASE.SETUP);
  }

  disengage(reason = "comando utente") {
    if (!this.active) return;
    this.active = false; this.phase = PHASE.IDLE;
    this.sim.setThrottle(0); this.node.clear();
    this.narrate("AUTOPILOTA DISENGAGED (" + reason + "): ripristinato il comando manuale.", "MANUALE");
  }

  enter(p) { this.phase = p; this.onEnter(p); }

  /* ---------------- F1: finestra TLI ---------------- */

  /**
   * Scan della finestra TLI col modello BURN FINITO (thrust/isp/massa ->
   * consumo massa, MECO a Δv): il piano così trovato è eseguibile punto-a-punto
   * dall'autopilota, perdite di gravità incluse (un piano impulsivo sbaglierebbe
   * di ~250 m/s e ruoterebbe l'apolune fuori finestra).
   */
  findWindow() {
    const sim = this.sim;
    const r = Math.hypot(sim.ship.x, sim.ship.y);
    const T = 2 * Math.PI * Math.sqrt(r ** 3 / sim.astro.earth.GM); // periodo LEO
    const grp = sim.activeGroup;
    for (const dv of [1050, 1150, 1250, 1350, 950, 1450]) {
      for (let t0 = 40; t0 <= T; t0 += 50) {
        const pred = predictTrajectory(sim, {
          steps: 2600,
          burn: { tStart: sim.t + t0, dv, thrust: grp.thrust, isp: grp.isp, mass: sim.mass },
        });
        if (pred.events.soiEntry && !pred.events.impact) {
          // perilune abbastanza profondo da dare un'orbita di cattura stabile
          // (non troppo vicino al bordo SOI, dove la marea terrestre perturba)
          let minD = Infinity;
          for (const pt of pred.points) {
            const mo = moonState(pt.t, sim.astro);
            const d = Math.hypot(mo.x - pt.x, mo.y - pt.y);
            if (d < minD) minD = d;
          }
          if (minD <= 2500e3) return { tStart: sim.t + t0, dv, burnEst: dv * sim.mass / grp.thrust };
        }
      }
    }
    return { tStart: sim.t + 60, dv: 1200, burnEst: 1200 * sim.mass / grp.thrust }; // fallback
  }

  onEnter(p) {
    const sim = this.sim;
    if (p === PHASE.SETUP) {
      this.narrate("FASE 1 — LEO e pianificazione: risolvo la finestra di intercetta con la Luna IN MOVIMENTO simulando il BURN FINITO (perdite di gravità incluse). Un'accelerazione PROGRADE allunga l'apogeo fino alla Sfera d'Influenza lunare: è un'orbita di trasferimento di Hohmann scalata.", p);
      this.plan = this.findWindow();
      const grp = sim.activeGroup;
      this.node.set(this.plan.tStart + this.plan.burnEst / 2, this.plan.dv); // solo display
      this.narrate("Piano calcolato: accensione T+X tra " + fmtH(this.plan.tStart - sim.t) +
        ", Δv " + this.plan.dv + " m/s prograde (burn ~" + this.plan.burnEst.toFixed(0) +
        " s). Allineamento prograde in corso: i motori " + grp.name + " puntano lungo il vettore velocità.", p);
      this.warp.set(10);
    }
    if (p === PHASE.TLI) {
      const grp = sim.activeGroup;
      // Guida a ciclo chiuso: si spegne quando la COAST-PREDICTION dallo stato
      // corrente mostra ingresso SOI (i burn finiti soffrono perdite di gravità,
      // quindi il Δv impulsivo del piano è solo un punto di partenza).
      this.burn = { m0: sim.mass, target: this.plan.dv, cap: this.plan.dv * 1.5, ve: grp.isp * G0, mark: 0.25, lastPred: -1 };
      sim.setThrottle(1);
      this.warp.set(10);
      this.narrate("FASE 2 — ACCENSIONE TLI: " + grp.name + ", spinta " + (grp.thrust / 1e3).toFixed(1) +
        " kN, Isp " + grp.isp + " s. Consumo ~" + (grp.thrust / (grp.isp * G0)).toFixed(1) +
        " kg/s secondo l'equazione di Tsiolkovsky. Osserva l'apogeo allungarsi verso la Luna.", p);
    }
    if (p === PHASE.CRUISE) {
      const consumed = this.burn ? (this.burn.m0 - sim.mass) : 0;
      const dvReal = this.burn ? this.burn.ve * Math.log(this.burn.m0 / sim.mass) : 0;
      if (this.burn) {
        this.narrate("MECO — motore spento: Δv effettivo " + dvReal.toFixed(0) + " m/s (piano impulsivo " + this.burn.target + " + perdite di gravità) consumando " +
          (consumed / 1e3).toFixed(1) + " t di propellente (massa ora " + (sim.mass / 1e3).toFixed(1) +
          " t). La previsione tratteggiata conferma il trasferimento Terra→Luna.", "F2 COMPLETATA");
      }
      this.burn = null; this.node.clear();
      this.warp.set(1000);
      this.narrate("FASE 3 — Crociera cislunare: SMART WARP attivo, salgo fino a 5000x (1 s reale = 83 min simulati) " +
        "così l'attraversamento dura ~6 secondi reali. Ridurrò automaticamente il warp avvicinandoci alla Luna per guidare la frenata.", p);
    }
    if (p === PHASE.SOI) {
      const el = orbitalElements(sim.ship, sim.t);
      this.loiPeri = Math.max(el.periapsis, sim.astro.moon.radius * 1.5);
      this.warp.set(1000);
      this.narrate("FASE 4 — INGRESSO NELLA SOI LUNARE (raggio " + fmtKm(sim.astro.soiMoon) +
        "): da qui il campo gravitazionale SELENOCENTRICO domina la traiettoria e passo al frame lunare. " +
        "Mi allineo RETROGRADO: la traiettoria è iperbolica (e=" + el.e.toFixed(2) +
        "), senza frenata sfrecceremmo oltre. La frenata avverrà al periapside: è il punto più efficiente per il costo in Δv (effetto Oberth).", p);
    }
    if (p === PHASE.LOI) {
      const el = orbitalElements(sim.ship, sim.t);
      const grp = sim.activeGroup;
      this.burn = { target: el.v - Math.sqrt(el.GM / el.r), ve: grp.isp * G0, m0: sim.mass, mark: 0.5 };
      sim.setThrottle(1);
      this.warp.set(10);
      this.narrate("FASE 4 — ACCENSIONE LOI (Lunar Orbit Insertion): " + grp.name +
        " in retrogrado. Dobbiamo sottrarre ~" + this.burn.target.toFixed(0) +
        " m/s di velocità selenocentrica: quando l'energia specifica diventa negativa, l'orbita si chiude.", p);
    }
    if (p === PHASE.STAGE) {
      this.narrate("FASE 5 — Separazione Modulo Propulsione (crasher): il LM passa ai 4× YF-36 (Δv residuo " +
        (sim.dvActive / 1e3).toFixed(1) + " km/s). Il PM esaurito esegue la deorbit e impatterà la Luna in " +
        "punto controllato — firma dell'architettura CNSA. Warp 1000x per l'impatto.", p);
      if (sim.stages.length > sim.stageIndex + 1) {
        sim.stage();
        const d = sim.debris[sim.debris.length - 1];
        const mo = moonState(sim.t, sim.astro);
        d.vx = mo.vx; d.vy = mo.vy; // deorbit: zero velocità relativa -> caduta libera
      }
      this.stageDeadline = sim.t + 60000;
      this.warp.set(1000);
    }
    if (p === PHASE.DESAT) {
      this.desat = { burned: false, braked: false };
      this.warp.set(1000);
      this.narrate("FASE 6 — Deorbitazione: accensione RETROGRADA per abbassare il perilune a ~25 km sopra la superficie. " +
        "Sceglierò il sito di atterraggio con lo scanner LiDAR quando scenderemo sotto i 25 km (VISTA TATTICA).", p);
    }
    if (p === PHASE.DISCESA) {
      const mo = moonState(sim.t, sim.astro);
      const ang = Math.atan2(sim.ship.y - mo.y, sim.ship.x - mo.x);
      // il sito va a valle DEL MOTO (l'orbita lunare è retrograda rispetto al
      // verso trigonometrico: vT < 0), altrimenti la guida inverte 700 m/s di Δv
      const ahead = this.moonVT() >= 0 ? 1 : -1;
      const site = findFlatSite(ang + ahead * 30e3 / sim.astro.moon.radius, 0.1, 0.004);
      this.site = site;
      this.gnc = new DescentGNC(sim, site.angle);
      this.faultShown = false;
      this.warp.set(10);
      this.narrate("FASE 7 — DISCESA POTUTA (Powered Descent Guidance): LiDAR completato — sito a pendenza " +
        (site.slope * 57.3).toFixed(1) + "° (< 3° richiesto) a " + fmtKm(site.angle * sim.astro.moon.radius) +
        " di selenongsitudine. I 4× YF-36 in PID: pendio di discesa ~20°, velocità al suolo < 3 m/s. Sotto i 25 km la Vista Tattica mostra crateri, massi e la zona verde di atterraggio.", p);
    }
    if (p === PHASE.ASCESA) {
      if (sim.thrustFactor < 1) {
        sim.faultEngine(); // riparazione a terra della coppia diagonale
        this.narrate("Manutenzione a terra completata: la coppia diagonale " + (sim.mission.id === 'CNSA' ? 'YF-36' : 'Raptor') + " è di nuovo ONLINE (riprogrammata dal computer di bordo).", "SISTEMA");
      }
      this.gnc = new AscentGNC(sim, 20e3);
      this.warp.set(10);
      this.narrate("FASE 8 — ASCESA: i 4× YF-36 accendono dal suolo: spinta/gravità ~2.5, salita verticale poi pitch-over verso l'orbita a 20 km. " +
        "Mengzhou ci attende in orbita bassa lunare.", p);
    }
    if (p === PHASE.RENDEZVOUS) {
      this.rz = { st: 'MATCH', impDv: null, impM0: 0 };
      this.warp.set(100);
      this.narrate("FASE 9 — RENDEZVOUS con Mengzhou: prima allineo quota e velocità circolare (MATCH), poi impulso di FASE ORBITALE " +
        "(±10 m/s: alzo l'orbita se sono avanti, l'abbasso se sono indietro — la deriva chiude il gap), controimpulso e chiusura finale " +
        "con molla d'aggancio (legge di Hill/Clohessy-Wiltshire). Aggancio sotto i 2 km e 30 m/s di velocità relativa.", p);
    }
    if (p === PHASE.TEI) {
      this.tei = { stage: 'WAIT', i: 0, j: 0, best: null, nextEval: 0, pulses: 0 };
      this.warp.set(1);
      this.narrate("FASE 10 — Trans-Earth Injection: sgancio l'orbiter e risolvo il corridoio di rientro. " +
        "Un ingresso troppo ripido (-25°) ci farò impattare nell'oceano a 11 km/s: il corridoio dolce (|γ| < 7°) è largo pochi km — " +
        "lo cerco con una griglia di burn finiti, poi lo rifinirò con impulsi di correzione a metà crociera (come le missioni vere).", p);
    }
    if (p === PHASE.RIENTRO) {
      this.rientro = { atmWas: false, interfaces: 0, skipped: false, chuteWas: false };
      this.warp.set(100);
      this.narrate("FASE 11 — RIENTRO SKIP: all'interfaccia atmosferica (100 km reali = 10 km scalati) orienterò la capsula con " +
        "portanza verso l'alto (bank 1) sotto gli 8 km: la capsula SBANDERÀ sull'atmosfera come un sasso piatto, dissipando energia " +
        "a ogni rimbalzo senza superare i 6 g d'equipaggio. Poi paracadute e ammaraggio.", p);
    }
    if (p === PHASE.DONE) {
      this.warp.set(1);
      if (sim.status === "SPLASHDOWN") {
        this.narrate("AMMARAGGIO ✔ La capsula ha completato il treno di rimbalzi atmosferici, dissipato l'energia di ritorno " +
          "(picco " + sim.gMax.toFixed(1) + " g, limite 6 g) e ammarinato in sicurezza. Missione completa: dalla LEO alla superficie lunare e ritorno. " +
          "Premi V per il comando manuale, 0 per ripetere la demo.", "MISSIONE COMPLETATA");
      } else {
        const el = orbitalElements(sim.ship, sim.t);
        this.narrate("MISSIONE DEMO COMPLETATA ✔ Orbita lunare stabile: Ap " + fmtKm(el.altAp) +
          ", Pe " + fmtKm(el.altPe) + ", e=" + el.e.toFixed(3) + ". Mengzhou attende in orbita bassa lunare (marker verde). " +
          "Premi V per riprendere il comando manuale, oppure 0 per ripetere la demo.", p);
      }
    }
  }

  /* ---------------- loop di guida ---------------- */

  update() {
    if (!this.active) return;
    const sim = this.sim;
    if (sim.status === "CRASHED") {
      this.narrate("IMPATTO — la missione è fallita. " + (this.demoEnd ? "" : " (fault di discesa troppo aggressivo o corridoio TEI mancato)"), "EMERGENZA");
      this.disengage("schianto");
      return;
    }
    if (sim.status === "SPLASHDOWN" && this.phase !== PHASE.DONE) { this.enter(PHASE.DONE); return; }
    if (sim.status !== "NOMINAL" && sim.status !== "TOUCHDOWN" && sim.status !== "DOCKED") return;
    const el = orbitalElements(sim.ship, sim.t);

    if (this.phase === PHASE.SETUP) {
      this.snapPrograde(1);
      this.warpFor(Math.max(0, this.plan.tStart - sim.t)); // smart: attesa breve, 10x nell'ultimo minuto (trigger precisi)
      if (sim.t >= this.plan.tStart) this.enter(PHASE.TLI);
    }
    else if (this.phase === PHASE.TLI) {
      this.snapPrograde(1);
      const dv = this.burn.ve * Math.log(this.burn.m0 / sim.mass);
      if (dv >= this.burn.cap * this.burn.mark) {
        this.narrate("TLI in corso: Δv " + dv.toFixed(0) + " m/s bruciati, propellente " +
          (sim.propellantTotal / sim.propellantCapacity * 100).toFixed(0) +
          "%. Le perdite di gravità del burn finito richiedono più del Δv impulsivo pianificato: continuo finché la previsione non mostra la SOI.", "F2");
        this.burn.mark += 0.25;
      }
      // Il piano è stato calcolato col modello burn-finito: si esegue fedelmente.
      // (Un cutoff anticipato via previsione troncherebbe il burn e alzerebbe il perilune.)
      if (dv >= this.burn.target || dv >= this.burn.cap || sim.activeStage.propellant <= 0) {
        sim.setThrottle(0); this.enter(PHASE.CRUISE);
      }
    }
    else if (this.phase === PHASE.CRUISE) {
      if (!this.flags.soiSlow) { // smart warp: la traversata Terra->Luna dura ~6 s reali
        const v = Math.max(300, Math.abs(this.moonVUp()));
        this.warpFor((el.distToMoon - sim.astro.soiMoon) / v);
      }
      if (!this.flags.soiSlow && el.distToMoon < 1.2 * sim.astro.soiMoon) {
        this.flags.soiSlow = true; this.warp.set(100);
        this.narrate("Riduco il warp a 100x: siamo a " + fmtKm(el.distToMoon) +
          " dalla Luna, serve risoluzione fine per la manovra di inserzione.", "F3");
      }
      if (el.inMoonSOI) this.enter(PHASE.SOI);
    }
    else if (this.phase === PHASE.SOI) {
      this.snapPrograde(-1); // retrograde hold
      if (el.r <= this.loiPeri * 1.6) this.warp.set(100);
      if (el.r <= this.loiPeri * 1.15) this.warp.set(10); // frame fini per il trigger
      if (el.r <= this.loiPeri * 1.05) this.enter(PHASE.LOI);
    }
    else if (this.phase === PHASE.LOI) {
      this.snapPrograde(-1);
      const vc = Math.sqrt(el.GM / el.r);
      const danger = el.altPe < sim.astro.moon.radius * 0.5; // periapsis sotto pericolo: taglia subito
      if (el.e < 0.10 || (el.v <= vc * 1.02 && el.r <= this.loiPeri * 1.12) || danger || sim.activeStage.propellant <= 0) {
        sim.setThrottle(0);
        const el2 = orbitalElements(sim.ship, sim.t);
        this.narrate("Spegnimento LOI: velocità ridotta a " + el2.v.toFixed(0) +
          " m/s (circolare a questa quota: " + vc.toFixed(0) + " m/s). Orbita LUNARE STABILITA — Ap " +
          fmtKm(el2.altAp) + ", Pe " + fmtKm(el2.altPe) + ", e=" + el2.e.toFixed(3) +
          ". L'energia specifica è ora negativa: siamo in orbita chiusa.", "F4 COMPLETATA");
        if (this.sim.mission.id === "CNSA") this.enter(PHASE.STAGE); else this.enter(this.demoEnd ? PHASE.DONE : PHASE.DESAT);
      }
    }
    else if (this.phase === PHASE.STAGE) {
      const d = sim.debris[sim.debris.length - 1];
      if (d && d.dead) {
        this.narrate("Impatto del Modulo Propulsione confermato (crash deliberato ✓). " +
          (this.demoEnd ? "Il LM in orbita lunare è pronto per le fasi di discesa — la demo Fase 1 termina qui."
            : "Il LM (10.8 t di propellente, Δv " + (sim.dvActive / 1e3).toFixed(1) + " km/s) è pronto per la discesa sulla Luna."), "F5");
        this.enter(this.demoEnd ? PHASE.DONE : PHASE.DESAT);
      } else if (sim.t > this.stageDeadline) this.enter(this.demoEnd ? PHASE.DONE : PHASE.DESAT);
    }
    else if (this.phase === PHASE.DESAT) {
      const alt = el.r - sim.astro.moon.radius;
      if (!this.desat.burned) {
        const rAp = sim.astro.moon.radius + el.altAp;
        if (el.r < rAp * 0.97) {
          sim.setThrottle(0); // coast verso l'apoapside (warp 1000)
        } else {
          this.warp.set(1); // 1 frame = 0.1 s sim: overshoot perilune < 10 km
          this.snapPrograde(-1);
          sim.setThrottle(Math.max(0.15, Math.min(1, (el.altPe - 17e3) / 40e3)));
          if (el.altPe <= 17e3 || sim.activeStage.propellant <= 0) {
            sim.setThrottle(0); this.desat.burned = true;
            this.warp.set(1000);
            this.narrate("Deorbit completata: perilune " + fmtKm(el.altPe) +
              ". In caduta verso il punto di inserzione: all'ultimo passaggio a ~16 km frenerò a 250 m/s (PDIT).", "F6");
          }
        }
      } else if (!this.desat.braked) {
        if (alt < 25e3 && !this.flags.tac) {
          this.flags.tac = true;
          this.narrate("Sotto i 25 km: VISTA TATTICA attiva — terreno procedurale (crateri, massi), cono LiDAR e zona di atterraggio colorata per pendenza.", "F6");
        }
        // PDIT esattamente al perilune: il transito si riconosce dal segno di vUp
        // (negativo -> positivo). Warp 100 sotto i 60 km per non saltarlo: la
        // marea terrestre farebbe decadere il perilune sotto zero nelle ore di attesa.
        const vUp = this.moonVUp();
        if (alt < 60e3 && this.warp.current > 100) this.warp.set(100);
        if (!this.desat.pdit && alt < 30e3 && vUp < 0 && (vUp > -40 || this.moonVT() > 300)) {
          this.desat.pdit = true; this.warp.set(10);
          this.narrate("Perilune: PDIT — Powered Descent Initiation, frenata a 160 m/s poi guida PID al sito.", "F6");
        }
        if (this.desat.pdit) {
          const vT = this.moonVT();
          if (Math.abs(vT) > 160 && sim.activeStage.propellant > 0) {
            this.snapPrograde(-1); sim.setThrottle(1);
          } else {
            sim.setThrottle(0); this.desat.braked = true;
            this.enter(PHASE.DISCESA); // ~15 km / 260 m/s / vUp ~ 0: stato validato
          }
        }
        this.desat.prevVUp = vUp;
      }
    }
    else if (this.phase === PHASE.DISCESA) {
      const alt = el.r - sim.astro.moon.radius;
      if (sim.status === "TOUCHDOWN") {
        if (!this.flags.td) {
          this.flags.td = true; this.gnc = null;
          this.narrate("TOUCHDOWN ✔ Velocità verticale sotto i 3 m/s, pendenza del sito entro i 3°. Allunaggio completato: " +
            "propellente LM residuo " + (sim.activeStage.propellant / 1e3).toFixed(2) + " t. Preparo l'ascesa.", "F7 COMPLETATA");
          this.tdWait = sim.t + 40;
          this.warp.set(1);
        }
        if (sim.t > this.tdWait) this.enter(PHASE.ASCESA);
      } else if (!this.faultShown && alt < 3e3) {
        this.faultShown = true;
        sim.faultEngine();
        if (sim.mission.id === 'CNSA') this.narrate("FAULT: YF-36 numero 2 OFFLINE — logica diagonale: si spegne anche il diagonale opposto (spinta 50%). " +
          "Il PID compensa: la frenata principale è già completata, la spinta residua basta per l'approdo finale. L'allunaggio prosegue.", "ANOMALIA");
        else this.narrate("FAULT: Raptor numero 2 OFFLINE — spinta ridotta del 50%. " +
          "Il PID compensa l'assetto: la frenata principale è già completata, l'allunaggio prosegue.", "ANOMALIA");
      }
    }
    else if (this.phase === PHASE.ASCESA) {
      if (sim.status === "NOMINAL" && !this.flags.liftoff && this.gnc && this.gnc.phase === 'PITCH') {
        this.flags.liftoff = true;
        this.narrate("LIFTOFF ✔ Siamo saliti dal suolo: pitch-over verso l'orbita di rendezvous (20 km).", "F8");
      }
    }
    else if (this.phase === PHASE.RENDEZVOUS) {
      if (sim.status === "DOCKED") {
        if (!this.flags.dock) {
          this.flags.dock = true; this.rz = null;
          this.dockWait = sim.t + 60;
          this.warp.set(1);
          this.narrate("DOCKED ✔ AGGANCIO COMPLETATO con Mengzhou: equipaggio trasferito. " +
            "Propellente LM residuo " + (sim.activeStage.propellant / 1e3).toFixed(2) + " t — sufficiente per la TEI.", "F9 COMPLETATA");
        }
        if (sim.t > this.dockWait) this.enter(PHASE.TEI);
      } else if (this.rz && this.rz.st !== this.rz.last) {
        this.rz.last = this.rz.st;
        const msg = { MATCH: "Rendezvous: allineo quota/velocità con l'orbita di Mengzhou...", IMPU1: "Impulso di fase: accensione per creare la deriva di chiusura...", COAST: "Deriva di chiusura: aspetto che il gap si riduca sotto i 10 km...", IMPU2: "Controimpulso: ricircolarizzo sull'orbita di Mengzhou...", FINAL: "Chiusura finale: molla CW, velocità relativa < 1 m/s..." }[this.rz.st];
        if (msg) this.narrate(msg, "F9");
      }
    }
    else if (this.phase === PHASE.TEI) {
      this.teiUpdate();
    }
    else if (this.phase === PHASE.RIENTRO) {
      const altE = Math.hypot(sim.ship.x, sim.ship.y) - sim.astro.earth.radius;
      if (altE > 200e3) { // smart warp: la crociera di ritorno Luna->Terra in ~6 s reali
        const v = Math.max(500, Math.hypot(sim.ship.vx, sim.ship.vy));
        this.warpFor((altE - 200e3) / v);
      } else if (this.warp.current > 100) this.warp.set(100);
      if (altE < ATM.top) {
        if (this.warp.current > 10) this.warp.set(10);
        if (!this.rientro.atmWas && !this.flags.if1) {
          this.flags.if1 = true; this.rientro.interfaces++;
          this.narrate("INTERFACCIA ATMOSFERICA: v = " + Math.hypot(sim.ship.vx, sim.ship.vy).toFixed(0) +
            " m/s. Bank 1: presento lo scudo con portanza — punto a RIMBALZARE fuori (skip).", "F11");
        }
      }
      if (this.rientro.atmWas && altE > ATM.top && !this.rientro.skipped) {
        this.rientro.skipped = true;
        this.narrate("SKIP RIUSCITO ✔ Abbiamo rimbalzato sull'atmosfera: l'apogeo del rimbalzo dissiperà altra energia al prossimo ingresso. G max finora " + sim.gMax.toFixed(1) + ".", "F11");
      }
      this.rientro.atmWas = altE < ATM.top;
      if (sim.chutes && !this.rientro.chuteWas) {
        this.rientro.chuteWas = true;
        this.narrate("PARACADUTE aperti: frenamento finale verso l'ammaraggio.", "F11");
      }
    }
  }

  /** Smart warp: copre tRemain secondi di simulazione in ~6-8 s reali (zero tempi morti). */
  warpFor(tRemain) {
    for (const w of [10, 100, 1000, 2000, 5000]) if (w >= tRemain / 8) { this.warp.set(w); return w; }
    this.warp.set(5000); return 5000;
  }

  /** Velocità radiale (up) selenocentrica corrente. */
  moonVUp() {
    const sim = this.sim, mo = moonState(sim.t, sim.astro);
    const dx = sim.ship.x - mo.x, dy = sim.ship.y - mo.y, r = Math.hypot(dx, dy) || 1;
    return (sim.ship.vx - mo.vx) * dx / r + (sim.ship.vy - mo.vy) * dy / r;
  }

  /** Velocità tangenziale selenocentrica corrente. */
  moonVT() {
    const sim = this.sim, mo = moonState(sim.t, sim.astro);
    const dx = sim.ship.x - mo.x, dy = sim.ship.y - mo.y, r = Math.hypot(dx, dy) || 1;
    const ux = dx / r, uy = dy / r;
    return (sim.ship.vx - mo.vx) * -uy + (sim.ship.vy - mo.vy) * ux;
  }

  /* ---------------- F10: TEI (scan incrementale + burn + pulse) ---------------- */

  teiUpdate() {
    const sim = this.sim, tei = this.tei, grp = sim.activeGroup;
    if (tei.stage === 'WAIT') {
      if (sim.status === "DOCKED") { sim.undock(); tei.t0ref = sim.t + 30; }
      else tei.stage = 'SCAN';
      return;
    }
    if (tei.stage === 'SCAN') {
      // Algoritmo provato (_dbg_tei): per ogni fase t0 (passo 30 s) una scala di
      // dv cerca la transizione no-ingresso/ingresso; il perigeo NON è monotono
      // nel dv (finestra), quindi la bisezione va fatta nel bracket della transizione.
      // Sul confine il gamma è radente (-> ~0°): si risale con eps finché |γ| < 7°.
      const rr = sim.orbiter ? sim.orbiter.r : sim.astro.moon.radius + 20e3;
      const T = 2 * Math.PI * Math.sqrt(rr ** 3 / sim.astro.moon.GM);
      const dvs = [300, 330, 360, 390, 420, 450, 480, 510, 540, 570, 600, 630];
      if (tei.sub === undefined) tei.sub = 0;
      if (tei.t0 === undefined) tei.t0 = 30;
      if (tei.k === undefined) tei.k = 0;
      if (!tei.ladder) tei.ladder = [];
      const tStart = sim.t + tei.t0 + 30;
      const ev = (dv) => {
        const pr = predictTrajectory(sim, { steps: 62000, dt: 1, burn: { tStart, dv, thrust: grp.thrust, isp: grp.isp, mass: sim.mass } });
        return { entry: pr.events.atmEntry, impact: pr.events.impact };
      };
      const nextT0 = () => { tei.t0 += 30; tei.sub = 0; tei.k = 0; tei.ladder = []; };
      if (tei.retryUntil) {
        if (sim.t < tei.retryUntil) { this.warpFor(tei.retryUntil - sim.t); return; } // coast smart: la geometria cambia
        tei.retryUntil = null; this.warp.set(1);
      }
      if (tei.t0 > T) {
        // griglia esaurita senza finestra. La geometria Terra-Luna è periodica
        // (mese sidereo TM): la finestra di ingresso dolce (~±10 h) si ripete a
        // t ≈ 0 mod TM. Il primo fallimento salta direttamente alla prossima.
        tei.t0 = 30; tei.sub = 0; tei.k = 0; tei.ladder = [];
        const TM = 2 * Math.PI / sim.astro.moon.omega;
        tei.retryUntil = tei.retryUntil
          ? tei.retryUntil + 6 * 3600
          : (Math.floor(sim.t / TM) + 1) * TM - 2 * 3600;
        this.narrate("Nessuna finestra TEI in questa epoca (l'angolo di ingresso sarebbe troppo ripido). " +
          "Coast in orbita lunare: riscansione tra 3 ore, la geometria Terra-Luna è periodica.", "F10");
        return;
      }
      if (tei.sub === 0) {
        if (tei.k < dvs.length) {
          const r = ev(dvs[tei.k]);
          tei.ladder.push(!!(r.entry && (!r.impact || r.impact.body === 'earth')));
          tei.k++;
        } else {
          let lo = null, hi = null;
          for (let k = 0; k < dvs.length - 1; k++) {
            if (tei.ladder[k] !== tei.ladder[k + 1]) {
              if (tei.ladder[k]) { lo = dvs[k + 1]; hi = dvs[k]; } else { lo = dvs[k]; hi = dvs[k + 1]; }
              break;
            }
          }
          if (lo === null) nextT0();
          else { tei.lo = lo; tei.hi = hi; tei.sub = 1; tei.iter = 0; }
        }
        return;
      }
      if (tei.sub === 1) {
        const mid = (tei.lo + tei.hi) / 2;
        if (ev(mid).entry) tei.hi = mid; else tei.lo = mid;
        tei.iter++;
        if (tei.iter >= 10) { tei.sub = 2; tei.k = 0; }
        return;
      }
      if (tei.sub === 2) {
        const eps = [0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 3.0, 4.0, 6.0, 8.0];
        if (tei.k < eps.length) {
          const cand = tei.hi + Math.sign(tei.hi - tei.lo) * eps[tei.k];
          tei.k++;
          const r = ev(cand);
          if (r.entry && r.entry.gammaDeg <= -6 && r.entry.gammaDeg >= -7.5 && (!r.impact || r.impact.body === 'earth')) {
            tei.best = { dv: Math.round(cand * 100) / 100, tStart, gamma: r.entry.gammaDeg };
            tei.stage = 'COAST2BURN';
            this.warp.set(100);
            this.narrate("Corridoio TEI trovato: Δv " + tei.best.dv + " m/s tra " + fmtH(tei.best.tStart - sim.t) +
              ", ingresso a γ " + tei.best.gamma.toFixed(1) + "° (finestra radente: rimbalzerò sull'atmosfera).", "F10");
            return;
          }
        } else nextT0();
        return;
      }
      return;
    }
    if (tei.stage === 'COAST2BURN') {
      if (sim.t >= tei.best.tStart) {
        tei.stage = 'BURN'; tei.m0 = sim.mass;
        sim.setThrottle(1); this.warp.set(10);
        this.narrate("ACCENSIONE TEI: " + grp.name + " prograde — sfuggiamo alla gravità lunare verso la Terra.", "F10");
      }
      return;
    }
    if (tei.stage === 'BURN') {
      const ve = grp.isp * G0;
      if (ve * Math.log(tei.m0 / sim.mass) >= tei.best.dv || sim.activeStage.propellant <= 0) {
        sim.setThrottle(0);
        tei.stage = 'MID'; tei.nextEval = sim.t + 10800; // prima valutazione: fuori dalla SOI lunare, prograde = terra-centrico
        this.warp.set(100);
        this.narrate("TEI completata. Tra 3 ore di crociera valuterò la traiettoria coll'imbarcazione reale e correggerò il perigeo con micro-impulsi.", "F10");
      }
      return;
    }
    if (tei.stage === 'MID') {
      if (sim.t < tei.nextEval) return;
      tei.nextEval = sim.t + 240;
      const pr = predictTrajectory(sim, { steps: 62000, dt: 1 });
      let m = Infinity;
      for (const p of pr.points) { const d = Math.hypot(p.x, p.y) - sim.astro.earth.radius; if (d < m) m = d; }
      if ((m < 8e3 && m > 1e3) || tei.pulses >= 10) { // perigeo 1-8 km: banda provata (G contenuta)
        this.narrate("Corridoio di rientro agganciato: perigeo " + fmtKm(m) + " dopo " + tei.pulses +
          " impulsi di correzione. Buena suerte.", "F10 COMPLETATA");
        this.enter(PHASE.RIENTRO);
        return;
      }
      if (sim.activeStage.propellant < 3e2) { this.enter(PHASE.RIENTRO); return; }
      // dentro la SOI lunare il prograde è luna-centrico e il pulse è inefficace:
      // rimanda la valutazione finché la nave non è a > 10.000 km dalla Luna
      const mo = moonState(sim.t, sim.astro);
      if (Math.hypot(sim.ship.x - mo.x, sim.ship.y - mo.y) < 10e3 * 1e3) { tei.nextEval = sim.t + 600; return; }
      const cdv = Math.max(-40, Math.min(40, -(m - 4e3) / 14e3));
      if (Math.abs(cdv) < 0.05) { this.enter(PHASE.RIENTRO); return; }
      tei.pulses++; tei.pending = cdv; tei.m0 = sim.mass; tei.stage = 'PULSE';
      this.warp.set(1);
      this.narrate("Correzione a metà crociera n." + tei.pulses + ": perigeo " + fmtKm(m) +
        " -> impulso di " + cdv.toFixed(2) + " m/s " + (cdv > 0 ? "prograde" : "retrograde") + ".", "F10");
      return;
    }
    if (tei.stage === 'PULSE') {
      const ve = grp.isp * G0;
      const sgn = tei.pending >= 0 ? 1 : -1;
      const p = progradeUnit(sim.ship.x, sim.ship.y, sim.ship.vx, sim.ship.vy, sim.t, sim.astro);
      sim.ship.attitude = Math.atan2(sgn * p.y, sgn * p.x);
      sim.setThrottle(0.12);
      if (ve * Math.log(tei.m0 / sim.mass) >= Math.abs(tei.pending) || sim.activeStage.propellant <= 0) {
        sim.setThrottle(0); tei.stage = 'MID'; tei.nextEval = sim.t + 240; this.warp.set(100);
      }
    }
  }

  /**
   * Da chiamare a OGNI substep fisico (0.1 s): durante i burn warp-dipendenti
   * l'attitudine deve inseguire la velocità con passo fine, altrimenti al warp 10
   * il vettore di spinta resta fermo per ~1.7 s di tempo simulato (errore di
   * decine di gradi che degrada il piano di volo). Le GNC di discesa/risalita/
   * rendezvous vivono qui: sono PID a passo fisso.
   */
  hold() {
    if (!this.active) return;
    // ENTRY GUIDANCE skip: portanza (bank 1) solo in penetrazione sotto gli 8 km;
    // muso su in uscita. È la legge che genera il "treno di rimbalzi" provato.
    if (this.phase === PHASE.RIENTRO) {
      const rE = Math.hypot(this.sim.ship.x, this.sim.ship.y);
      const altE = rE - this.sim.astro.earth.radius;
      this.sim.bank = altE < 8e3 ? 1 : 0;
    }
    if (this.phase === PHASE.SETUP || this.phase === PHASE.TLI) this.snapPrograde(1);
    else if (this.phase === PHASE.CRUISE) {
      // Crociera: il muso segue la curvatura del moto (retrograde vicino alla SOI: prep LOI)
      this._alignTo(this._flowAngle(this.flags.soiSlow ? -1 : 1));
    }
    else if (this.phase === PHASE.SOI || this.phase === PHASE.LOI || this.phase === PHASE.DESAT) this.snapPrograde(-1);
    else if (this.phase === PHASE.DISCESA && this.gnc) this.gnc.update(0.1);
    else if (this.phase === PHASE.ASCESA && this.gnc) {
      if (this.gnc.update(0.1) === 'ORBIT') { this.gnc = null; this.enter(PHASE.RENDEZVOUS); }
    }
    else if (this.phase === PHASE.RENDEZVOUS && this.rz) this.rendezvousHold();
    else if (this.phase === PHASE.TEI && this.tei) {
      if (this.tei.stage === 'BURN') this.snapPrograde(1);
      else if (this.tei.stage === 'PULSE') this.snapPrograde(this.tei.pending >= 0 ? 1 : -1);
      else this._alignTo(this._flowAngle(1)); // WAIT/SCAN: in orbita lunare muso prograde
    }
    else if (this.phase === PHASE.RIENTRO) {
      // Crociera di ritorno: muso lungo la velocità finché fuori atmosfera
      const altE = Math.hypot(this.sim.ship.x, this.sim.ship.y) - this.sim.astro.earth.radius;
      if (altE > 200e3) this._alignTo(this._flowAngle(1));
    }
  }

  /** Guida rendezvous a stati: MATCH -> IMPU1 -> COAST -> IMPU2 -> FINAL. */
  rendezvousHold() {
    const sim = this.sim, rz = this.rz, ASTRO = sim.astro;
    const mm = moonState(sim.t, ASTRO);
    const dx = sim.ship.x - mm.x, dy = sim.ship.y - mm.y;
    const rr = Math.hypot(dx, dy);
    const ux = dx / rr, uy = dy / rr, tx = -uy, ty = ux;
    const vT = (sim.ship.vx - mm.vx) * tx + (sim.ship.vy - mm.vy) * ty;
    const vUp = (sim.ship.vx - mm.vx) * ux + (sim.ship.vy - mm.vy) * uy;
    const vcNow = Math.sqrt(ASTRO.moon.GM / rr);
    let dA = Math.atan2(dy, dx) - sim.orbiter.angle;
    while (dA > Math.PI) dA -= 2 * Math.PI;
    while (dA < -Math.PI) dA += 2 * Math.PI;
    const gap = Math.abs(dA) * sim.orbiter.r;
    const dvImp = 10;
    let ax = 0, ay = 0;
    if (rz.st === 'MATCH') {
      const raise = Math.max(-6, Math.min(6, (sim.orbiter.r - rr) * 0.002));
      const err = (vcNow + raise) - vT;
      if (Math.abs(err) < 4 && Math.abs(rr - sim.orbiter.r) < 2000 && Math.abs(vUp) < 3) rz.st = 'IMPU1';
      else { ax = err * 0.15 * tx; ay = err * 0.15 * ty; }
    } else if (rz.st === 'IMPU1' || rz.st === 'IMPU2') {
      const want = rz.st === 'IMPU1' ? (dA > 0 ? dvImp : -dvImp) : (dA > 0 ? -dvImp : dvImp);
      if (rz.impDv === null) { rz.impDv = 0; rz.impM0 = sim.mass; }
      const ve = sim.activeGroup.isp * G0;
      rz.impDv = ve * Math.log(rz.impM0 / sim.mass);
      if (Math.abs(rz.impDv) >= Math.abs(want)) { rz.st = rz.st === 'IMPU1' ? 'COAST' : 'FINAL'; rz.impDv = null; }
      else { const sgn = Math.sign(want); ax = sgn * tx * 2; ay = sgn * ty * 2; }
    } else if (rz.st === 'COAST') {
      if (gap < 10e3) rz.st = 'IMPU2';
    } else { // FINAL: molla di Clohessy-Wiltshire sull'orbiter
      const op = sim.orbiterPos();
      const rx = sim.ship.x - op.x, ry = sim.ship.y - op.y;
      const rvx = sim.ship.vx - op.vx, rvy = sim.ship.vy - op.vy;
      const wT = sim.orbiter.omega;
      ax = 3 * wT * wT * rx + 2 * wT * rvy - 2e-4 * rx - 0.06 * rvx;
      ay = -4 * wT * rvx - 2e-4 * ry - 0.06 * rvy;
      const aM = Math.hypot(ax, ay);
      if (aM > 0.15) { ax *= 0.15 / aM; ay *= 0.15 / aM; }
    }
    const aMag = Math.hypot(ax, ay);
    if (aMag > 0.01) {
      sim.ship.attitude = Math.atan2(ay, ax);
      sim.setThrottle(Math.min(1, aMag * sim.mass / (sim.activeGroup.thrust * sim.thrustFactor)));
    } else sim.setThrottle(0);
  }

  /** Angolo del vettore velocità (prograde sign=+1 / retrograde -1) nel frame dominante. */
  _flowAngle(sign) {
    const s = this.sim.ship;
    const p = progradeUnit(s.x, s.y, s.vx, s.vy, this.sim.t);
    return Math.atan2(p.y * sign, p.x * sign);
  }

  /** Allineamento graduale stile RCS: ruota l'attitudine verso target a velocità limitata. */
  _alignTo(target, rate = 0.08) {
    const s = this.sim.ship;
    let d = target - s.attitude;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const step = rate * 0.1; // substep da 0.1 s -> 0.08 rad/s
    s.attitude += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }

  /** Allinea l'attitudine al moto (sign=+1 prograde, -1 retrograde). */
  snapPrograde(sign) {
    const p = progradeUnit(this.sim.ship.x, this.sim.ship.y, this.sim.ship.vx, this.sim.ship.vy, this.sim.t);
    this.sim.ship.attitude = Math.atan2(p.y * sign, p.x * sign);
  }
}