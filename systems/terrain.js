/**
 * CISLUNAR 2030 — Terreno lunare procedurale (systems/terrain.js)
 * ==============================================================
 * Profilo di superficie 1D lungo l'angolo selenico: crateri (ciotola + orlo),
 * collinette a bassa frequenza e massi ad alta frequenza. Deterministico:
 * hash intero -> PRNG, nessuna dipendenza da Math.random, così la scena è
 * identica a ogni reload e da qualsiasi zoom.
 *
 * Quote in metri (mondo scalato 1:10 → 1 m scalato = 10 m reali).
 */

/* PRNG hash-based (mulberry32 su seed intero) */
function hash(n) {
  n = n | 0;
  let t = (n * 1664525 + 1013904223) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const N_CRATERS = 48;
const craters = [];
(function gen() {
  for (let i = 0; i < N_CRATERS; i++) {
    const center = hash(i * 7 + 1) * Math.PI * 2;
    const radius = (1.5e3 + hash(i * 7 + 2) * 6e3) / 173700; // raggio ANGOLARE (1.5–7.5 km scalati)
    const depth = 150 + hash(i * 7 + 3) * 500;          // 150–650 m scalati
    craters.push({ center, radius, depth, rim: 0.25 * depth });
  }
})();

/** Altezza del terreno [m] sopra la sfera di riferimento, all'angolo dato. */
export function terrainHeight(angle) {
  // normalizza in [0, 2π)
  let a = angle % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  // collinette a bassa frequenza
  let h = 120 * Math.sin(a * 13 + 1.7) * Math.sin(a * 7 + 0.3) + 60 * Math.sin(a * 31 + 2.9);
  // crateri
  for (const c of craters) {
    let d = a - c.center;
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    const x = Math.abs(d) / c.radius;
    if (x < 1) h -= c.depth * (1 - x * x);                       // ciotola
    if (x > 0.8 && x < 1.6) h += c.rim * Math.exp(-((x - 1.05) ** 2) / 0.02); // orlo
  }
  // massi ad alta frequenza (solo sopra il livello medio)
  const b = hash(Math.floor(a * 4000)) ;
  if (b > 0.995) h += 15 + b * 30;
  return h;
}

/** Pendenza locale [gradi] con differenza centrata di base 2Δ. */
export function terrainSlope(angle, d = 60) {
  const dh = terrainHeight(angle + d / 173700) - terrainHeight(angle - d / 173700);
  return Math.abs(Math.atan2(dh, 2 * d)) * 180 / Math.PI;
}

/**
 * Cerca il sito piatto più vicino all'angolo dato: finestra ±range,
 * passo step; ritorna {angle, slope}. Criterio: pendenza minima.
 */
export function findFlatSite(nearAngle, range = 0.25, step = 0.004) {
  let best = { angle: nearAngle, slope: Infinity };
  for (let d = -range; d <= range; d += step) {
    const a = nearAngle + d;
    const s = Math.max(terrainSlope(a), terrainSlope(a + 0.002), terrainSlope(a - 0.002));
    if (s < best.slope) best = { angle: a, slope: s };
  }
  return best;
}
