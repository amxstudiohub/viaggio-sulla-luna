/**
 * CISLUNAR 2030 — Profili missione e costanti astrofisiche
 * =========================================================
 * FASE 0: dati reali raccolti via web research (Mar 2026 / Giu 2026).
 *
 * SCALING 1:10 PER GIOCABILITA'
 * -----------------------------
 * - Lunghezze (raggi, distanze) divise per 10.
 * - Gravita' superficiale MANTENUTA: 1 G Terra / 0.165 G Luna.
 * - Le GM vengono DERIVATE dalla condizione al contorno:  GM = g_sup * R_scalato^2
 *   (in questo modo il vincolo "g superficiale invariata" e' rispettato esattamente).
 * - Conseguenze fisiche (documentate, non bug):
 *     * il periodo orbitale lunare risulta ~8.63 giorni (invece di 27.32)
 *     * tutte le velocita' orbitale scalano per 1/sqrt(10) ~ 0.316
 *     * i fabbisogni di delta-v della missione scalano ~ x0.316 (TLI ~990 m/s)
 *       mentre i veicoli mantengono le capacita' delta-v REALI -> margini ampi,
 *       scelta voluta per la giocabilita'.
 */

export const SCALE = 10;
export const G = 6.6743e-11;        // costante gravitazionale (invariata) [m^3 kg^-1 s^-2]
export const G0 = 9.80665;          // gravita' standard per Isp [m/s^2]

// ---- Valori reali (non scalati) ----
const R_EARTH_REAL = 6.371e6;       // m
const R_MOON_REAL  = 1.7374e6;      // m
const DIST_REAL    = 3.844e8;       // m, distanza media Terra-Luna

// ---- Mondo scalato ----
export const ASTRO = {
  scale: SCALE,
  G, G0,
  earth: { name: 'Terra', radius: R_EARTH_REAL / SCALE, g: 9.80665 },
  moon:  { name: 'Luna',  radius: R_MOON_REAL  / SCALE, g: 0.165 * 9.80665 },
  distance: DIST_REAL / SCALE,
};
// GM derivati: g_sup = GM / R^2  =>  GM = g_sup * R^2
ASTRO.earth.GM = ASTRO.earth.g * ASTRO.earth.radius ** 2;   // ~3.9805e12 m^3/s^2
ASTRO.moon.GM  = ASTRO.moon.g  * ASTRO.moon.radius  ** 2;   // ~4.8843e10 m^3/s^2

// Orbita lunare (circolare) nel mondo scalato
const muTot = ASTRO.earth.GM + ASTRO.moon.GM;
const moonOmega = Math.sqrt(muTot / ASTRO.distance ** 3);
ASTRO.moonOrbit = {
  radius: ASTRO.distance,
  omega: moonOmega,                       // ~8.42e-6 rad/s
  period: 2 * Math.PI / moonOmega,        // ~7.46e5 s ~ 8.63 giorni
  startAngle: 2.46,                       // ~141 deg: TLI nominale (+1.0 km/s a t=0) entra in SOI con miss ~3000 km a T+19h
};

// Sfera di influenza (SOI) lunare nel mondo scalato
ASTRO.soiMoon = ASTRO.distance * (ASTRO.moon.GM / muTot) ** (2 / 5); // ~6.59e6 m

// Orbita di parcheggio "LEO" scalata (200 km reali -> 20 km)
ASTRO.leo = {
  altitude: 200e3 / SCALE,
  get radius() { return ASTRO.earth.radius + this.altitude; },
  get v() { return Math.sqrt(ASTRO.earth.GM / this.radius); }, // ~2461 m/s
};

/* =======================================================================
 * DATI REALI HARVESTED (Fase 0) — con fonti e bandiera "STIMA"
 * ======================================================================= */
export const REAL_DATA = {
  astro: {
    earth: { radius_m: 6.371e6, GM_m3s2: 3.986004418e14, g_ms2: 9.80665 },
    moon:  { radius_m: 1.7374e6, GM_m3s2: 4.9049e12, g_ms2: 1.62, soi_km: 66100, period_days: 27.32 },
    meanDistance_km: 384400,
  },
  cnsa: {
    lanyue: {
      totalMass_kg: 26000,               // LM + modulo propulsione (CMSA/Xinhua)
      combinedDv_mps: 5100,              // J. CSST 46.2 (2026), paper 0019
      lmEngines: '4x YF-36 (spinta variabile)',
      lmEngineThrust_N: 7500,            // ~764 kgf ciascuno
      lmEngineThrustDeviation_N: 100,    // deviazione max tra i 4 motori
      lmPropellant_kg: 10800,            // MMH/N2O4, tank common-bulkhead, He
      pmEngine: 'YF-58-1',
      pmEngineThrust_N: 78453,           // ~8 tf (China in Space, footnote 4)
      propellants: 'MMH / N2O4 (Ipergolici)',
      isp_s_ESTIMATE: 315,               // STIMA: non pubblicato, tipico MMH/NTO
      engineOutLogic: 'guasto 1 YF-36 -> spegnimento motore DIAGONALE opposto -> abort-to-orbit / atterraggio ritardato / ascesa allungata',
      pmFate: 'TLI + LOI + orbita di discesa, poi separazione e IMPATTO CONTROLLATO (crasher)',
      gnc: 'IMU + star tracker + radar microonde + LiDAR; accuracy <100 m; avoidance autonoma ostacoli',
    },
    mengzhou: {
      massLunarConfig_kg: 21600, massLeoConfig_kg: 14000, massMax_kg: 23000,
      reentry: 'SKIP re-entry (manovra a rimbalzo aerodinamico), v > 9 km/s',
      crew: '3 + 500 kg (config lunare), 6-7 (LEO)',
      capsuleDiameter_m: 4.5, crewVolume_m3: 13, designLife_days: 21,
      returnEngines: "4 motori principali (2 in fallback per ritorno d'emergenza)",
      landing: '3 paracadute + 6 airbag (6000 kg su airbag)',
    },
  },
  spacex: {
    hls: {
      height_m: 52.3, diameter_m: 9, pressurizedVolume_m3: 614,
      engines: '6x Raptor (3 sea-level + 3 Raptor Vacuum) + RCS methalox',
      raptor: {
        r2_seaLevel: { thrust_N: 2.256e6, isp_s: 327 },
        r2_vacuum:   { thrust_N: 2.530e6, isp_s: 380 },
        r3_seaLevel: { thrust_N: 2.452e6, isp_s: 350 },
        r3_vacuum:   { thrust_N: 2.697e6 },
        throttleRange: '40-100%',
      },
      propellant: 'CH4 / LOX (metano/ossigeno liquidi)',
      tankCapacity_kg: 1.2e6,            // ~1200 t (Musk, ago 2021)
      tankerFlights: '4-8 voli tanker per refill in LEO',
      payloadToSurface_kg: 1.0e5,
      loiter_days: 100,
      orbit: 'NRHO (near-rectilinear halo orbit), rendezvous con Orion',
      midBodyThrusters: {
        count_ESTIMATE: 24,              // STIMA da render leak (4 pod x 6); non ufficiale
        type: 'RCS gassosi methalox alta spinta (gO2/gCH4)',
        role: 'descente terminale e touchdown negli ULTIMI ~100 m, per evitare plume-erosion del regolite',
        thrustPerThruster_N_ESTIMATE: 1.0e4,
        isp_s_ESTIMATE: 250,
      },
      boilOff: 'criogenico gestito con tile isolanti in-space; valore di simulazione STIMATO 1%/giorno',
    },
  },
  sources: [
    'https://en.wikipedia.org/wiki/Lanyue',
    'https://en.wikipedia.org/wiki/Mengzhou_(spacecraft)',
    'https://en.wikipedia.org/wiki/Starship_HLS',
    'https://en.wikipedia.org/wiki/SpaceX_Raptor',
    'https://en.wikipedia.org/wiki/SpaceX_rocket_engines (Methox thruster)',
    'https://www.china-in-space.com/p/mengzhou-abort-plans-lanyue-lander',
    'https://space.skyrocket.de/doc_sdat/starship-hls.htm',
    'doi:10.16708/j.cnki.1000-758X.2026.0028 (J. Chinese Space Science & Tech 46.2, 2026)',
  ],
};

/* =======================================================================
 * PROFILI MISSONE (mondo scalato) — usati dal motore
 * Split di massa PM/LM e dry mass HLS = STIME INGEGNERISTICHE ancorate
 * ai totali pubblicati (26 t; 6 t prop. LM; 5.1 km/s combinati).
 * ======================================================================= */
export const MISSIONS = {
  CNSA: {
    id: 'CNSA',
    label: 'CNSA — Mengzhou + Lanyue',
    agency: 'China Manned Space Agency',
    vehicle: 'Lanyue (LM + Modulo Propulsione YF-58-1)',
    accent: '#ff5c5c',
    description: 'Architettura orbitale: il modulo propulsione (crasher) esegue TLI, LOI e orbita di discesa, poi si separa e impatta la Luna. Il LM con 4x YF-36 atterra. Mengzhou attende in orbita lunare.',
    craft: {
      name: 'Lanyue stack',
      height_m: 10, diameter_m: 4.2,
      stages: [
        {
          // Split tarato per riprodurre il Δv COMBINATO pubblicato di 5.100 m/s
          name: 'Modulo Propulsione',
          dryMass: 1000, propellant: 15000,
          groups: [{ id: 'PM_YF58', name: 'YF-58-1', thrust: 78453, isp: 315, minThrottle: 0 }],
        },
        {
          name: 'Lunar Module',
          dryMass: 4000, propellant: 10800,
          groups: [{ id: 'LM_YF36', name: '4x YF-36', thrust: 40000, isp: 315, minThrottle: 0 }],
        },
      ],
    },
    boilOffRate: 0,
    chutes: true, // paracadute impliciti per il rientro del complesso Mengzhou
    // Capsula di rientro Mengzhou (modulo di ritorno): 5,6 t a secco. Dopo lo
    // sgancio del modulo di servizio è lei che attraversa l'atmosfera e ammarra.
    returnModule: { name: 'Capsula Mengzhou', mass: 5600, CdA: 210, splash: 'Mar Cinese Meridionale' },
    orbiterMarker: { name: 'Mengzhou', body: 'moon', altitude: 200e3 / SCALE, color: '#7cffb2' }, // 20 km scalati = 200 km reali
    initialOrbit: { body: 'earth', altitude: ASTRO.leo.altitude },
    stagingHint: 'X = getta Modulo Propulsione (crasher)',
  },

  SPACEX: {
    id: 'SPACEX',
    label: 'SpaceX — Starship HLS',
    agency: 'SpaceX / NASA Artemis',
    vehicle: 'Starship HLS (rifurnita in LEO)',
    accent: '#4dd8ff',
    description: 'Veicolo monostadio: refill tanker in LEO (1200 t prop. CH4/LOX), 6x Raptor per TLI/LOI/discesa; 24 thruster methalox mid-body per i metri finali (anti-plume). Boil-off criogenico attivo.',
    craft: {
      name: 'Starship HLS',
      height_m: 52.3, diameter_m: 9,
      stages: [
        {
          name: 'Starship HLS',
          dryMass: 150000, propellant: 1.2e6,   // STIMA dry; prop = capacita' tank (Musk)
          groups: [
            { id: 'METHOX_RCS24', name: '24x RCS methalox (mid-body)', thrust: 240000, isp: 250, minThrottle: 0, maxAltitude: 100 },
            { id: 'RAPTOR6', name: '6x Raptor (3 SL + 3 RVac)', thrust: 14.358e6, isp: 355, minThrottle: 0 },
          ],
        },
      ],
    },
    boilOffRate: (0.01 * 1.2e6) / 86400,        // 1%/giorno (STIMA gameplay) [kg/s]
    orbiterMarker: null,
    initialOrbit: { body: 'earth', altitude: ASTRO.leo.altitude },
    stagingHint: 'RCS mid-body automatici sotto 100 m',
  },
};
