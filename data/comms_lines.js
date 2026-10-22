/**
 * CISLUNAR 2030 — Copione radio del Controllo Missione (data/comms_lines.js)
 * ==========================================================================
 * Fonte unica di verita per la VOCE della radio: ogni voce di LINES e una
 * riga CapCom curata (breve, numeri arrotondati) nelle due lingue, con la
 * regex che la aggancia al messaggio del Mission Director.
 *
 *   - lo SCHERMO continua a mostrare il testo originale del Director (fedele,
 *     con i numeri esatti);
 *   - la RADIO legge questa riga, ripresa offline in un mp3 pre-generato
 *     (tools/tts_bake.mjs -> assets/audio/comms/ + data/comms_manifest.json).
 *
 * `num` (opzionale) apre uno slot numerico: il valore estratto dal testo del
 * Director viene arrotondato al passo e diventa una variante pre-baked
 * (id@valore). Le varianti sono un insieme chiuso: nessuna cucitura di parole.
 *
 * Le funzioni qui sotto sono usate SIA dal bake tool (Node) SIA dal runtime
 * (browser): id e testi devono coincidere per costruzione.
 */

export const VOICES = { it: "it-IT-DiegoNeural", en: "en-US-ChristopherNeural" };

/**
 * `re` lavora sul testo NORMALIZZATO (minuscolo, punteggiatura -> spazio),
 * quindi si scrive senza apostrofi/parentesi. tests/comms.test.mjs verifica
 * che ogni messaggio del Director ne agganci una sola.
 */
export const LINES = [
  /* ---------- sistema ---------- */
  { id: "sys_online", phase: "SISTEMA", re: /gnc online/,
    it: "Autopilota GNC online. Sto valutando la geometria di missione corrente.",
    en: "Guidance autopilot online. Evaluating the current mission geometry." },
  { id: "sys_disengage", phase: "MANUALE", re: /autopilota disengaged/,
    it: "Autopilota disinnestato. Ripristinato il comando manuale.",
    en: "Autopilot disengaged. Manual control restored." },
  { id: "sys_repair", phase: "SISTEMA", re: /manutenzione a terra completata/,
    it: "Manutenzione completata. La coppia diagonale di motori è di nuovo online, riprogrammata dal computer di bordo.",
    en: "Maintenance complete. The diagonal engine pair is back online, reprogrammed by the onboard computer." },

  /* ---------- ATTO 0 — lancio ---------- */
  { id: "at0_pad_go", phase: "ATTO 0 LANCIO", re: /torre aperta/,
    it: "Torre aperta, meteo verde. Sequenza automatica avviata: T meno dieci.",
    en: "Tower open, weather green. Automatic sequence started: T minus ten." },
  { id: "at0_t4", phase: "ATTO 0 LANCIO", re: /quattro tre due uno/,
    it: "Quattro, tre, due, uno.",
    en: "Four, three, two, one." },
  { id: "at0_ignition", phase: "ATTO 0 LANCIO", re: /spinta al cento percento/,
    it: "Accensione. Spinta al cento percento.",
    en: "Ignition. Thrust at one hundred percent." },
  { id: "at0_lift", phase: "ATTO 0 LANCIO", re: /lascia la rampa/,
    it: "Il razzo lascia la rampa. Velocità verticale nominale, torre libera.",
    en: "The vehicle has left the pad. Vertical speed nominal, tower clear." },
  { id: "at0_maxq", phase: "ATTO 0 LANCIO", re: /max q/,
    it: "Max Q. Pressione dinamica al picco, motore all'ottanta percento.",
    en: "Max Q. Peak dynamic pressure, engine at eighty percent." },
  { id: "at0_meco", phase: "ATTO 0 LANCIO", re: /primo stadio meco/,
    it: "Spegnimento motori del primo stadio. Meco.",
    en: "First stage engine cutoff. Meco." },
  { id: "at0_stage", phase: "ATTO 0 LANCIO", re: /il booster si allontana/,
    it: "Separazione confermata. Il booster si allontana.",
    en: "Separation confirmed. The booster is falling away." },
  { id: "at0_ses", phase: "ATTO 0 LANCIO", re: /accensione secondo stadio/,
    it: "Accensione del secondo stadio. Via verso l'orbita.",
    en: "Second stage ignition. On the way to orbit." },
  { id: "at0_seco", phase: "ATTO 0 LANCIO", re: /seconda accensione completata/,
    it: "Seconda accensione completata. Iniezione orbitale raggiunta: benvenuti in LEO.",
    en: "Second burn complete. Orbital insertion achieved: welcome to low Earth orbit." },
  { id: "at1_leo", phase: "ATTO 1 ORBITA", re: /orbita terrestre bassa raggiunta/,
    it: "Orbita terrestre bassa raggiunta. Da qui in poi, la missione.",
    en: "Low Earth orbit achieved. From here on, the mission." },

  /* ---------- F1 pianificazione ---------- */
  { id: "f1_piano", phase: "F1", re: /leo e pianificazione/,
    it: "Fase uno: LEO e pianificazione. Risolvo la finestra di intercetta con la Luna in movimento, simulando l'accensione a burn finito, perdite di gravità incluse.",
    en: "Phase one: low Earth orbit and planning. Solving the intercept window with the Moon in motion, simulating a finite burn with gravity losses included." },
  { id: "f1_calc", phase: "F1", re: /piano calcolato/,
    it: "Piano calcolato: accensione T plus X risolta. Allineamento prograde in corso: i motori puntano lungo il vettore di velocità.",
    en: "Flight plan computed: the T plus X ignition is solved. Prograde alignment in progress: engines point along the velocity vector." },

  /* ---------- F2 TLI ---------- */
  { id: "f2_tli", phase: "F2", re: /fase 2 accensione tli/,
    it: "Fase due: accensione TLI. Motori accesi, spinta nominale. Osserva l'apogeo allungarsi verso la Luna.",
    en: "Phase two: trans-lunar injection ignition. Engines running, thrust nominal. Watch the apogee stretch toward the Moon." },
  { id: "f2_meco", phase: "F2 COMPLETATA", re: /meco motore spento/,
    num: { re: /effettivo (\d+)/i, step: 200, min: 1600, max: 2800 },
    it: "Meco, motore spento. Delta v effettivo {n} metri al secondo, incluse le perdite di gravità. La previsione conferma il trasferimento verso la Luna.",
    en: "Meco, engine cutoff. Actual delta v {n} meters per second, gravity losses included. The prediction confirms the transfer to the Moon." },
  { id: "f2_burn", phase: "F2", re: /tli in corso/,
    num: { re: /(\d+) m\/s bruciati/i, step: 400, min: 400, max: 2800 },
    it: "TLI in corso: delta v bruciato {n} metri al secondo. Continuo finché la previsione non tocca la sfera d'influenza lunare.",
    en: "Trans-lunar injection in progress: delta v burned {n} meters per second. Continuing until the prediction reaches lunar sphere of influence." },

  /* ---------- F3 crociera ---------- */
  { id: "f3_cruise", phase: "F3", re: /crociera cislunare/,
    it: "Fase tre: crociera cislunare. Warp intelligente attivo fino a cinquemila. Ridurrò automaticamente avvicinandoci alla Luna per guidare la frenata.",
    en: "Phase three: cislunar coast. Smart warp active up to five thousand. I will reduce it automatically as we approach the Moon to guide the braking." },
  { id: "f3_warpdown", phase: "F3", re: /riduco il warp/,
    it: "Riduco il warp a cento. Siamo in vista della Luna: serve risoluzione fine per la manovra di inserzione.",
    en: "Reducing warp to one hundred. The Moon is in sight: we need fine resolution for the insertion maneuver." },

  /* ---------- F4 LOI ---------- */
  { id: "f4_soi", phase: "F4", re: /ingresso nella soi/,
    it: "Fase quattro: ingresso nella sfera d'influenza lunare. Passo al frame selenocentrico e mi allineo retrogrado: la traiettoria è iperbolica, senza frenata sfrecceremmo oltre.",
    en: "Phase four: entering the lunar sphere of influence. Switching to the selenocentric frame and aligning retrograde: the trajectory is hyperbolic, without braking we would fly right past." },
  { id: "f4_loi", phase: "F4", re: /accensione loi/,
    num: { re: /sottrarre\D*(\d+)/i, step: 100, min: 300, max: 900 },
    it: "Fase quattro: accensione LOI, motori in retrogrado. Dobbiamo sottrarre circa {n} metri al secondo: quando l'energia specifica diventa negativa, l'orbita si chiude.",
    en: "Phase four: lunar orbit insertion burn, engines retrograde. We must shed about {n} meters per second: when specific energy turns negative, the orbit closes." },
  { id: "f4_done", phase: "F4 COMPLETATA", re: /spegnimento loi/,
    num: { re: /ridotta a (\d+)/i, step: 100, min: 1200, max: 2000 },
    it: "Spegnimento LOI completato: velocità ridotta a {n} metri al secondo. Orbita lunare stabilita, l'energia specifica è negativa: siamo in orbita chiusa.",
    en: "Lunar orbit insertion complete: speed reduced to {n} meters per second. Lunar orbit established, specific energy is negative: we are in a closed orbit." },

  /* ---------- F5 separazione ---------- */
  { id: "f5_stage", phase: "F5", re: /separazione modulo propulsione/,
    it: "Fase cinque: separazione del modulo propulsione. Il lander passa ai quattro motori principali. Il modulo esaurito deorbita e impatterà la Luna in un punto controllato.",
    en: "Phase five: propulsion module separation. The lander switches to the four main engines. The spent module deorbits and will impact the Moon at a controlled point." },
  { id: "f5_impact", phase: "F5", re: /impatto del modulo propulsione/,
    it: "Impatto del modulo propulsione confermato: crash deliberato. Il lander è pronto per la discesa sulla Luna.",
    en: "Propulsion module impact confirmed: deliberate crash. The lander is ready for the descent to the Moon." },

  /* ---------- F6 deorbit / PDIT ---------- */
  { id: "f6_deorbit", phase: "F6", re: /deorbitazione/,
    it: "Fase sei: deorbitazione. Accensione retrograda per abbassare il perilune a venticinque chilometri sopra la superficie.",
    en: "Phase six: deorbit burn. Retrograde firing to lower the perilune to twenty-five kilometers above the surface." },
  { id: "f6_deorbit_done", phase: "F6", re: /deorbit completata/,
    num: { re: /perilune\D*(\d+)/i, step: 5, min: 15, max: 35 },
    it: "Deorbit completata: perilune {n} chilometri. In caduta verso il punto di inserzione: all'ultimo passaggio frenerò per il PDIT.",
    en: "Deorbit complete: perilune {n} kilometers. Falling toward the insertion point: on the last pass I will brake for PDIT." },
  { id: "f6_tactical", phase: "F6", re: /vista tattica attiva/,
    it: "Sotto i venticinque chilometri: vista tattica attiva. Terreno procedurale con crateri e massi, cono LiDAR e zona di atterraggio colorata per pendenza.",
    en: "Below twenty-five kilometers: tactical view active. Procedural terrain with craters and boulders, LiDAR cone and landing zone colored by slope." },
  { id: "f6_pdit", phase: "F6", re: /powered descent initiation/,
    it: "Perilune: PDIT, powered descent initiation. Frenata a centosessanta metri al secondo, poi guida PID al sito.",
    en: "Perilune: PDIT, powered descent initiation. Braking to one hundred sixty meters per second, then PID guidance to the site." },

  /* ---------- F7 discesa / allunaggio ---------- */
  { id: "f7_descent", phase: "F7", re: /discesa potuta/,
    it: "Fase sette: discesa motorizzata. LiDAR completato: sito con pendenza entro i tre gradi. Quattro motori in PID, glide slope e velocità al suolo sotto i tre metri al secondo.",
    en: "Phase seven: powered descent. LiDAR complete: site slope within three degrees. Four engines in PID, glide slope and touchdown speed under three meters per second." },
  { id: "f7_touchdown", phase: "F7 COMPLETATA", re: /touchdown/,
    it: "Touchdown confermato. Velocità verticale sotto i tre metri al secondo e pendenza del sito nei limiti. Allunaggio completato: preparo l'ascesa.",
    en: "Touchdown confirmed. Vertical speed under three meters per second and site slope within limits. Landing complete: preparing the ascent." },
  { id: "f7_surface", phase: "F7 COMPLETATA", re: /superficie lunare raggiunta/,
    it: "Superficie lunare raggiunta. Il lander è stabile sulla regolite. Premi barra spaziatrice quando vuoi decollare.",
    en: "Lunar surface reached. The lander is stable on the regolith. Press the space bar when you want to lift off." },

  /* ---------- fault ---------- */
  { id: "fault_yf36", phase: "ANOMALIA", re: /yf 36 numero 2 offline/,
    it: "Fault: YF trentasei numero due offline. Per logica diagonale si spegne anche l'opposto: spinta al cinquanta percento. Il PID compensa, l'allunaggio prosegue.",
    en: "Fault: YF thirty-six number two offline. By diagonal logic the opposite one shuts down too: fifty percent thrust. The PID compensates, the landing continues." },
  { id: "fault_raptor", phase: "ANOMALIA", re: /raptor numero 2 offline/,
    it: "Fault: Raptor numero due offline: spinta ridotta al cinquanta percento. Il PID compensa l'assetto, l'allunaggio prosegue.",
    en: "Fault: Raptor number two offline: thrust down to fifty percent. The PID compensates the attitude, the landing continues." },

  /* ---------- F8 ascesa ---------- */
  { id: "f8_ascent", phase: "F8", re: /ascesa i 4|fase 8 ascesa/,
    it: "Fase otto: ascesa. I motori accendono dal suolo, salita verticale poi pitch over verso l'orbita di rendezvous. Mengzhou ci attende in orbita bassa lunare.",
    en: "Phase eight: lunar ascent. Engines ignite from the surface, vertical climb then pitch over toward the rendezvous orbit. Mengzhou awaits in low lunar orbit." },
  { id: "f8_lift", phase: "F8", re: /liftoff/,
    it: "Liftoff confermato. Siamo saliti dal suolo: pitch over verso l'orbita di rendezvous.",
    en: "Liftoff confirmed. We are up from the surface: pitch over toward the rendezvous orbit." },

  /* ---------- F9 rendezvous ---------- */
  { id: "f9_rendezvous", phase: "F9", re: /rendezvous con mengzhou/,
    it: "Fase nove: rendezvous con Mengzhou. Prima allineo quota e velocità circolare, poi impulso di fase, deriva di chiusura e controimpulso. Aggancio sotto i due chilometri.",
    en: "Phase nine: rendezvous with Mengzhou. First matching altitude and circular speed, then phase impulse, closing drift and counter burn. Docking under two kilometers." },
  { id: "f9_match", phase: "F9", re: /allineo quota velocita con/,
    it: "Rendezvous: allineo quota e velocità con l'orbita di Mengzhou.",
    en: "Rendezvous: matching altitude and speed with Mengzhou orbit." },
  { id: "f9_impu1", phase: "F9", re: /impulso di fase accensione/,
    it: "Impulso di fase: accensione per creare la deriva di chiusura.",
    en: "Phase impulse: burn to create the closing drift." },
  { id: "f9_coast", phase: "F9", re: /deriva di chiusura aspetto/,
    it: "Deriva di chiusura: aspetto che il gap scenda sotto i dieci chilometri.",
    en: "Closing drift: waiting for the gap to drop under ten kilometers." },
  { id: "f9_impu2", phase: "F9", re: /controimpulso ricircolarizzo/,
    it: "Controimpulso: ricircolarizzo sull'orbita di Mengzhou.",
    en: "Counter burn: recircularizing on Mengzhou orbit." },
  { id: "f9_final", phase: "F9", re: /chiusura finale molla/,
    it: "Chiusura finale: molla di aggancio, velocità relativa sotto il metro al secondo.",
    en: "Final closure: docking spring, relative speed under one meter per second." },
  { id: "f9_docked", phase: "F9 COMPLETATA", re: /docked|aggancio completato/,
    it: "Aggancio completato con Mengzhou: equipaggio trasferito. Il propellente residuo è sufficiente per la trans Earth injection.",
    en: "Docking complete with Mengzhou: crew transferred. Residual propellant is sufficient for trans-Earth injection." },

  /* ---------- F10 TEI ---------- */
  { id: "f10_none", phase: "F10", re: /nessuna finestra tei/,
    it: "Nessuna finestra di trans Earth injection in questa epoca: l'angolo di ingresso sarebbe troppo ripido. Coast in orbita lunare, riscansione tra tre ore.",
    en: "No trans-Earth injection window this epoch: the entry angle would be too steep. Coasting in lunar orbit, rescanning in three hours." },
  { id: "f10_found", phase: "F10", re: /corridoio tei trovato/,
    num: { re: /trovato\D*(\d+)/i, step: 100, min: 400, max: 1000 },
    it: "Corridoio TEI trovato: delta v {n} metri al secondo. Ingresso radente: rimbalzerò sull'atmosfera.",
    en: "Trans-Earth injection corridor found: delta v {n} meters per second. Grazing entry: we will skip off the atmosphere." },
  { id: "f10_burn", phase: "F10", re: /accensione tei/,
    it: "Accensione TEI, prograde. Sfuggiamo alla gravità lunare verso la Terra.",
    en: "Trans-Earth injection burn, prograde. Leaving lunar gravity for Earth." },
  { id: "f10_done", phase: "F10 COMPLETATA", re: /corridoio di rientro agganciato/,
    it: "Corridoio di rientro agganciato: perigeo confermato dopo le correzioni di metà crociera. Buona fortuna.",
    en: "Entry corridor acquired: perigee confirmed after the mid-course corrections. Good luck." },
  { id: "f10_tei_done", phase: "F10", re: /tei completata/,
    it: "TEI completata. Tra tre ore di crociera valuterò la traiettoria reale e correggerò il perigeo con micro impulsi.",
    en: "Trans-Earth injection complete. In three hours of coast I will assess the real trajectory and correct the perigee with micro burns." },
  { id: "f10_midcourse", phase: "F10", re: /correzione a meta crociera/,
    it: "Correzione a metà crociera: perigeo aggiornato con un piccolo impulso di traiettoria.",
    en: "Mid-course correction: perigee updated with a small trajectory impulse." },

  /* ---------- F11 rientro skip ---------- */
  { id: "f11_entry", phase: "F11", re: /interfaccia atmosferica/,
    it: "Interfaccia atmosferica. Bank one: presento lo scudo con portanza, punto a rimbalzare fuori.",
    en: "Entry interface. Bank one: presenting the shield with lift, aiming to skip back out." },
  { id: "f11_skip", phase: "F11", re: /skip riuscito/,
    num: { re: /finora\s*(\d+(?:[.,]\d+)?)/i, step: 0.5, min: 1, max: 6 },
    it: "Skip riuscito. Abbiamo rimbalzato sull'atmosfera: l'apogeo del rimbalzo dissiperà altra energia al prossimo ingresso. Picco attuale {n} g.",
    en: "Skip successful. We bounced off the atmosphere: the skip apogee will bleed more energy on the next entry. Current peak {n} g." },
  { id: "f11_chutes", phase: "F11", re: /paracadute aperti/,
    it: "Paracadute aperti: frenamento finale verso l'ammaraggio.",
    en: "Chutes deployed: final deceleration toward splashdown." },

  /* ---------- fine missione ---------- */
  { id: "mission_complete", phase: "MISSIONE COMPLETATA", re: /ammaraggio la capsula/,
    it: "Ammaraggio. La capsula ha completato il treno di rimbalzi atmosferici e dissipato l'energia di ritorno. Missione completa: dalla LEO alla superficie lunare e ritorno.",
    en: "Splashdown. The capsule completed the skip re-entry and bled off the return energy. Mission complete: from low Earth orbit to the lunar surface and back." },
  { id: "demo_complete", phase: "F11", re: /missione demo completata/,
    it: "Missione demo completata: orbita lunare stabile. Premi V per il comando manuale, oppure zero per ripetere la demo.",
    en: "Demo mission complete: stable lunar orbit. Press V for manual control, or zero to repeat the demo." },
  { id: "crash", phase: "EMERGENZA", re: /impatto la missione e fallita/,
    it: "Impatto: la missione è fallita. Fault di discesa troppo aggressivo o corridoio TEI mancato.",
    en: "Impact: the mission has failed. Descent fault too aggressive, or the trans-Earth injection window was missed." },

  /* ---------- prova radio (tasto L / bottone RADIO) ---------- */
  { id: "check_it", phase: "RADIO", re: /prova radio.*italiano/,
    it: "Prova radio. Il controllo è attivo. Italiano.",
    en: "Radio check. Control is on. Italian." },
  { id: "check_en", phase: "RADIO", re: /radio check.*english/,
    it: "Prova radio. Il controllo è attivo. Inglese.",
    en: "Radio check. Control is on. English." },
];

/* ==================== helper (condivisi bake/runtime) ==================== */

/** minuscolo, niente punteggiatura: la forma su cui lavorano le `re`. */
export function normalize(s) {
  return String(s == null ? "" : s)
    .replace(/[\u2018\u2019\u0060]/g, "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const IT_UNITS = ["zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove",
  "dieci", "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette",
  "diciotto", "diciannove"];
const IT_TENS = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta",
  "ottanta", "novanta"];
const IT_HUND = ["", "cento", "duecento", "trecento", "quattrocento", "cinquecento", "seicento",
  "settecento", "ottocento", "novecento"];
const EN_UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function itBelow1000(n) {
  if (n < 20) return IT_UNITS[n];
  if (n < 100) {
    const t = IT_TENS[Math.floor(n / 10)], u = n % 10;
    if (!u) return t;
    if (u === 1 || u === 8) return t.slice(0, -1) + IT_UNITS[u];
    return t + IT_UNITS[u];
  }
  const h = Math.floor(n / 100), r = n % 100;
  if (h === 1) return r ? "cento" + itBelow1000(r) : "cento";
  return IT_HUND[h] + (r ? itBelow1000(r) : "");
}

/** 2461 -> "duemilaquattrocentosessantuno" ; 2.5 -> "due virgola cinque" */
export function numToIt(n) {
  const neg = n < 0 ? "meno " : "";
  const x = Math.abs(n);
  const dec = Math.round((x - Math.floor(x)) * 10);
  let out;
  if (x < 1000) out = itBelow1000(Math.floor(x));
  else if (x < 1e6) {
    const th = Math.floor(x / 1000), r = Math.floor(x) % 1000;
    out = (th === 1 ? "mille" : itBelow1000(th) + "mila") + (r ? itBelow1000(r) : "");
  } else {
    const mi = Math.floor(x / 1e6), r = Math.floor(x) % 1e6;
    out = (mi === 1 ? "un milione" : itBelow1000(mi) + " milioni") + (r ? " " + numToIt(r) : "");
  }
  if (dec) out += " virgola " + IT_UNITS[dec];
  return neg + out;
}

function enBelow1000(n) {
  if (n < 20) return EN_UNITS[n];
  if (n < 100) {
    const t = EN_TENS[Math.floor(n / 10)], u = n % 10;
    return u ? t + "-" + EN_UNITS[u] : t;
  }
  const h = Math.floor(n / 100), r = n % 100;
  return EN_UNITS[h] + " hundred" + (r ? " and " + enBelow1000(r) : "");
}

/** 2461 -> "two thousand four hundred sixty-one" */
export function numToEn(n) {
  const neg = n < 0 ? "minus " : "";
  const x = Math.abs(n);
  const dec = Math.round((x - Math.floor(x)) * 10);
  let out;
  if (x < 1000) out = enBelow1000(Math.floor(x));
  else if (x < 1e6) {
    const th = Math.floor(x / 1000), r = Math.floor(x) % 1000;
    out = enBelow1000(th) + " thousand" + (r ? " " + enBelow1000(r) : "");
  } else {
    const mi = Math.floor(x / 1e6), r = Math.floor(x) % 1e6;
    out = enBelow1000(mi) + " million" + (r ? " " + numToEn(r) : "");
  }
  if (dec) out += " point " + EN_UNITS[dec];
  return neg + out;
}

const decimalsOf = (step) => (String(step).split(".")[1] || "").length;

/** Valore dello slot: estrae dal testo del Director, arrotonda e cappà. */
export function slotValue(entry, text) {
  if (!entry.num) return null;
  const m = String(text).match(entry.num.re);
  if (!m) return null;
  const raw = parseFloat(String(m[1]).replace(",", "."));
  if (!isFinite(raw)) return null;
  const step = entry.num.step, d = decimalsOf(step);
  const v = Math.min(entry.num.max ?? Infinity, Math.max(entry.num.min ?? -Infinity, Math.round(raw / step) * step));
  return { value: v, key: v.toFixed(d).replace(".", "_") };
}

/** Griglia chiusa dei valori di uno slot (quelli pre-baked).
 *  slotValue cappa e arrotonda sempre dentro questa griglia.
 *  @param {object} entry
 *  @returns {{value:number,key:string}[]} */
export function slotGrid(entry) {
  if (!entry || !entry.num) return [];
  const { step, min = 0, max = 0 } = entry.num;
  const d = decimalsOf(step);
  const out = [];
  for (let v = min; v <= max + 1e-9; v += step) {
    const r = Number(v.toFixed(d));
    out.push({ value: r, key: r.toFixed(d).replace(".", "_") });
  }
  return out;
}

/** id della clip: base, oppure base@valore per gli slot numerici. */
export function clipId(entry, slot) {
  return slot ? entry.id + "@" + slot.key : entry.id;
}

/** Riga con lo slot riempito (`words`: numeri a parole, per il bake). */
export function fill(entry, lang, slot, words) {
  const src = entry[lang] || entry.it;
  if (!slot || src.indexOf("{n}") < 0) return src;
  const txt = words ? (lang === "en" ? numToEn(slot.value) : numToIt(slot.value)) : String(slot.value);
  return src.replace("{n}", txt);
}

/** Prima riga che aggancia il messaggio (fase + testo normalizzati). */
export function matchLine(text, phase) {
  const hay = normalize(phase) + " " + normalize(text);
  for (const e of LINES) if (e.re.test(hay)) return e;
  return null;
}

/** Quante righe agganciano lo stesso messaggio (>1 = ambiguita). */
export function matchAll(text, phase) {
  const hay = normalize(phase) + " " + normalize(text);
  return LINES.filter((e) => e.re.test(hay));
}

/** Risoluzione completa: { entry, id, slot } oppure null (nessuna clip). */
export function resolveClip(text, phase) {
  const entry = matchLine(text, phase);
  if (!entry) return null;
  const slot = slotValue(entry, text);
  return { entry, id: clipId(entry, slot), slot };
}
