/**
 * CISLUNAR 2030 — Audio & Comms (systems/audio_comms.js)
 * ======================================================
 * 1. Voce del Controllo Missione: clip neurali PRE-REGISTRATE (bake:
 *    tools/tts_bake.mjs) prese da data/comms_manifest.json e riprodotte dal
 *    radio bus (HP 120 + LP 3400 + lieve saturazione + flutter): zero
 *    latenza, zero dipendenze, funziona offline anche su Windows.
 *    Il copione/abbinamento sta in data/comms_lines.js. La voce del browser
 *    (Web Speech) è disattivata di default: allowTTS = true solo con ?tts=1,
 *    perché si sovrapponeva alla radio. Senza clip: toni + avviso nel log.
 * 2. Quindar Tones + radio static (Web Audio API pura, zero file):
 *    2525 Hz 250 ms prima del messaggio, 2475 Hz 250 ms dopo, fruscio durante
 *    (durata reale della clip) e ducking di rombo motori/static mentre parla.
 * 3. Audio fisico procedurale: rombo motori (throttle), soffi RCS (variazione
 *    attitudine), ping LiDAR sotto i 25 km, Master Alarm bitonale sul fault.
 *
 * Solo browser: in Node (test) ogni metodo è un no-op sicuro.
 */

import { resolveClip, fill } from '../data/comms_lines.js';
import { ATM } from '../core/physics.js';

const WARP_LEVELS = [1, 10, 100, 1000, 2000, 5000];
const MANIFEST_URL = 'data/comms_manifest.json';
const LRU_MAX = 48;          // buffer mp3 decodificati tenuti in RAM
const QUEUE_MAX = 2;         // messaggi in attesa oltre quello in onda
const WARM = ['sys_online', 'at1_leo', 'f1_piano', 'f2_tli', 'f3_cruise',
  'f4_soi', 'f6_pdit', 'f7_touchdown', 'check_it', 'check_en'];

/** Callout inglesi in stile NASA: fallback quando il copione non copre il testo. */
const ENG_CALLOUTS = [
  [/FAULT|OFFLINE|diagonale/i, "Engine out! Diagonal pair offline, thrust fifty percent. The guidance compensates, landing continues."],
  [/TOUCHDOWN|allunaggio/i, "Touchdown confirmed. The spacecraft is on the lunar surface. Engines safe."],
  [/AMMARAGGIO|SPLASHDOWN|rimbalzi atmosferici/i, "Splashdown! The capsule has completed the skip re-entry. Recovery forces are on station. Mission complete."],
  [/PARACADUTE/i, "Chutes deployed. Final deceleration to splashdown."],
  [/SKIP RIUSCITO|rimbalz/i, "Skip successful. We bounced off the atmosphere, bleeding energy on each pass."],
  [/INTERFACCIA ATMOSFERICA|RIENTRO SKIP/i, "Entry interface. Skip re-entry: lifting out at eight kilometers like a stone skipping on water."],
  [/Corridoio|finestra TEI|TEI/i, "Trans-Earth injection. Re-entry corridor acquired, burning for Earth."],
  [/DOCKED|AGGANCIO|aggancio|RENDEZVOUS/i, "Rendezvous complete. Docking confirmed with the command module, crew transfer."],
  [/ASCESA|decollo|RISALITA|LIFTOFF/i, "Lunar ascent ignition. Climbing to the rendezvous orbit."],
  [/DISCESA|PDIT|Powered Descent|LiDAR/i, "Powered descent. LiDAR complete, PID guiding the four engines to the landing site."],
  [/DEORBIT/i, "Deorbit burn complete. Perilune set for the powered descent."],
  [/SEPARAZIONE|crasher|Propulsione/i, "Propulsion module separation confirmed. Crasher impact nominal."],
  [/LOI|INSERZIONE/i, "Lunar orbit insertion burn. Slowing down at perilune, welcome to lunar orbit."],
  [/SOI/i, "Entering the lunar sphere of influence. Switching to the selenocentric frame, aligning retrograde."],
  [/MECO|CROCIERA|Crociera/i, "MECO confirmed. On the translunar coast. Raising time warp."],
  [/TLI|ACCENSIONE/i, "Ignition. Trans-lunar injection burn, thrust nominal."],
  [/PIANIFICAZIONE|SETUP/i, "Flight plan uplinked. Window open, all stations stand by."],
];

const strip = (s) => String(s).replace(/[\u2714\u2716\u23ED\u{1F50A}\u26A0\u221E\u2014\u00B0]/gu, ' ').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AudioComms {
  constructor() {
    this.lang = 'ita';           // 'ita' | 'eng' | 'mute'
    this.muted = false;          // sospensione temporanea (jump)
    this.speaking = false;       // true mentre la radio è in onda (ON AIR)
    this.ctx = null;
    this._att = undefined; this._puff = 0; this._ping = 0; this._alarm = false;
    this._voices = null;
    /* --- libreria clip --- */
    this.manifest = null;
    this.libraryReady = false;
    this._manPromise = null;
    this._buf = new Map();       // LRU url -> AudioBuffer
    this._queue = [];            // { id, lang, fb }
    this._busy = false;
    this._gen = 0;               // generazione: stop() la incrementa e interrompe
    this._cur = null;
    this.crackle = true;         // micro-dropout del collegamento
    this.onMiss = null;          // callback(messaggio) quando la radio ripiega (log HUD)
    // La voce del browser NON si usa più: le clip coprono tutto il copione e,
    // passando da un percorso separato, si sovrapponevano alla radio.
    // Si riattiva solo per diagnostica: index.html?tts=1
    this.allowTTS = typeof window !== 'undefined' && /[?&]tts=1/.test(window.location.search);
    this.lastSource = 'none';    // baked | tts | tones | missing | error
    this.lastId = '';
    this.trace = [];             // [{id, src}] per i test headless
  }

  /* ---------------- ciclo lingua / toggle ---------------- */

  cycle() {
    this.lang = this.lang === 'ita' ? 'eng' : this.lang === 'eng' ? 'mute' : 'ita';
    if (this.lang === 'mute') this.stop();
    return this.label();
  }
  label() { return this.lang === 'ita' ? 'ITA' : this.lang === 'eng' ? 'ENG' : 'MUTE'; }

  /** Costruisce l'AudioContext (serve un gesto utente). Idempotente. */
  ensure() {
    if (typeof window === 'undefined') return false;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this._build();
        this._loadManifest();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this._ensureVoices();
      return true;
    } catch (e) { return false; }
  }

  /** Le voci TTS arrivano async su Chrome: cache alla prima disponibilità. */
  _ensureVoices() {
    const ss = window.speechSynthesis;
    if (!ss || this._voices) return;
    const grab = () => { const vs = ss.getVoices(); if (vs && vs.length) this._voices = vs; };
    grab();
    try { ss.onvoiceschanged = grab; } catch (e) { /* ok */ }
  }

  _build() {
    const ctx = this.ctx;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    // bus di ducking: rombo + static passano di qui, si abbassano mentre parla il Controllo
    this.duck = ctx.createGain(); this.duck.gain.value = 1; this.duck.connect(this.master);
    // --- rombo motori: brown noise -> lowpass -> gain ---
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 90; lp.Q.value = 1.2;
    const eng = ctx.createBufferSource(); eng.buffer = this._noise(true); eng.loop = true;
    eng.connect(lp); lp.connect(this.engGain); this.engGain.connect(this.duck); eng.start();
    // --- static radio: white noise -> bandpass -> gain ---
    this.staticGain = ctx.createGain(); this.staticGain.gain.value = 0;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.6;
    const st = ctx.createBufferSource(); st.buffer = this._noise(false); st.loop = true;
    st.connect(bp); bp.connect(this.staticGain); this.staticGain.connect(this.duck); st.start();
    // --- radio bus della voce: passa-banda + lieve saturazione + flutter ---
    this.voiceIn = ctx.createGain(); this.voiceIn.gain.value = 1;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 3400;
    const ws = ctx.createWaveShaper();
    const n = 257, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / (n - 1) - 1; curve[i] = Math.tanh(x * 1.7) / Math.tanh(1.7); }
    ws.curve = curve; ws.oversample = '2x';
    this.voiceGain = ctx.createGain(); this.voiceGain.gain.value = 0.95;
    this.voiceIn.connect(hp); hp.connect(lpf); lpf.connect(ws); ws.connect(this.voiceGain);
    this.voiceGain.connect(this.master);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.7;
    const lfoAmp = ctx.createGain(); lfoAmp.gain.value = 0.02;
    lfo.connect(lfoAmp); lfoAmp.connect(this.voiceGain.gain); lfo.start();
  }

  _noise(brown) {
    const ctx = this.ctx, len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w * 0.6;
    }
    return buf;
  }

  /* ---------------- libreria clip ---------------- */

  _loadManifest() {
    if (this._manPromise || typeof window === 'undefined' || typeof fetch !== 'function') return this._manPromise;
    this._manPromise = fetch(MANIFEST_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (m && m.clips && Object.keys(m.clips).length) {
          this.manifest = m; this.libraryReady = true;
          this.warm();
        }
        return m;
      })
      .catch(() => null);
    return this._manPromise;
  }

  /** Prefetch delle prime righe (boot + prova radio) per azzerare la latenza. */
  warm() {
    if (!this.libraryReady) return;
    for (const id of WARM) {
      for (const lang of ['it', 'en']) {
        const c = this.manifest.clips[lang + '.' + id];
        if (c) this._bufferFor(c.f).catch(() => {});
      }
    }
  }

  async _bufferFor(url) {
    if (this._buf.has(url)) {           // LRU: tocca e riordina
      const b = this._buf.get(url); this._buf.delete(url); this._buf.set(url, b);
      return b;
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status + ' su ' + url);
    const ab = await r.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(ab);
    this._buf.set(url, buf);
    while (this._buf.size > LRU_MAX) this._buf.delete(this._buf.keys().next().value);
    return buf;
  }

  /** Attesa interrompibile: stop() la sveglia subito, così la coda riparte subito. */
  _wait(ms) {
    return new Promise((res) => {
      this._wake = res;
      this._timer = setTimeout(() => { this._wake = null; res(); }, ms);
    });
  }

  /** Ferma tutto ciò che è in onda e svuota la coda (jump, mute, restart). */
  stop() {
    this._gen++;
    this._queue.length = 0;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
    if (this._cur) { try { this._cur.stop(); } catch (e) { /* già fermo */ } this._cur = null; }
    this.speaking = false;
    this._duck(false);
    if (typeof window !== 'undefined' && window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* ok */ } }
  }

  _duck(on) {
    if (!this.ctx) return;
    this.duck.gain.setTargetAtTime(on ? 0.45 : 1, this.ctx.currentTime, 0.06);
  }

  /* ---------------- tono + parlato ---------------- */

  _tone(freq, dur, delay = 0, vol = 0.11) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.setValueAtTime(vol, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _static(dur) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.staticGain.gain.cancelScheduledValues(t);
    this.staticGain.gain.setValueAtTime(0.028, t);
    this.staticGain.gain.setValueAtTime(0.028, t + dur);
    this.staticGain.gain.linearRampToValueAtTime(0, t + dur + 0.25);
  }

  /** Traduzione callout per la modalità ENG (fallback: testo non nel copione). */
  _eng(text, phase) {
    const hay = (phase || '') + ' ' + text;
    for (const [re, line] of ENG_CALLOUTS) if (re.test(hay)) return line;
    return 'Mission Control: ' + (phase || 'update') + '.';
  }

  /**
   * Chiama il messaggio: Quindar di apertura -> voce -> Quindar di chiusura.
   * Ritorna il testo da mostrare a schermo (invariato in ITA: i numeri esatti
   * restano nell'HUD; in ENG la riga curata del copione).
   */
  say(text, phase) {
    if (typeof window === 'undefined') return text;
    const hit = resolveClip(text, phase);
    let shown = text;
    if (this.lang === 'eng') shown = hit ? fill(hit.entry, 'en', hit.slot, false) : this._eng(text, phase);
    this._note(hit ? hit.id : '(browser)', hit ? 'baked' : (this.allowTTS ? 'tts' : 'tones'), text, phase);
    if (this.lang === 'mute' || this.muted) return shown;
    if (!this.ensure()) return shown;
    if (hit) {
      if (this._queue.length >= QUEUE_MAX) this._queue.shift();   // il più vecchio salta
      this._queue.push({ id: hit.id, lang: this.lang === 'eng' ? 'en' : 'it', fb: strip(shown) });
      this._pump();
    } else {
      this._fallback('messaggio non nel copione: ' + strip(text).slice(0, 70), strip(text));
    }
    return shown;
  }

  /** Ripiega in modo udibile ma mai sovrapposto: tono + avviso in log (voce solo se ?tts=1). */
  _fallback(why, clean) {
    if (this.onMiss) { try { this.onMiss(why); } catch (e) { /* ok */ } }
    if (this.allowTTS && clean) this.speakLine(clean);
    else { this._tone(2525, 0.25); this._static(1.2); this._tone(2475, 0.25, 1.3); this.lastSource = 'tones'; }
  }

  /** Coda di trasmissione: un messaggio in onda, gli altri in attesa. */
  async _pump() {
    if (this._busy || this.muted || this.lang === 'mute') return;
    const item = this._queue.shift();
    if (!item) return;
    this._busy = true;
    const gen = this._gen;
    try {
      if (!this.libraryReady) await this._loadManifest();
      const clip = this.manifest ? this.manifest.clips[item.lang + '.' + item.id] : null;
      if (!clip) {
        this.lastSource = 'missing';
        this._fallback('clip mancante nel manifest: ' + item.id, this.allowTTS ? item.fb : null);
        return;
      }
      const buf = await this._bufferFor(clip.f);
      if (gen !== this._gen || this.muted || this.lang === 'mute') return;
      this._tone(2525, 0.25);                        // GO tone
      await this._wait(170);
      if (gen !== this._gen || this.muted) return;
      const dur = buf.duration;
      this._static(dur + 0.5);
      this._duck(true);
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.connect(this.voiceIn); this._cur = src;
      if (this.crackle && Math.random() < 0.35) {    // micro-dropout del collegamento
        const off = 0.4 + Math.random() * Math.max(0.5, dur - 0.8);
        this.voiceGain.gain.setValueAtTime(0.25, this.ctx.currentTime + off);
        this.voiceGain.gain.setValueAtTime(0.95, this.ctx.currentTime + off + 0.008);
      }
      this.speaking = true; this.lastSource = 'baked'; this.lastId = item.lang + '.' + item.id;
      src.start();
      await this._wait(dur * 1000 + 120);
      try { src.stop(); } catch (e) { /* già fermo */ }
      if (gen !== this._gen) return;
      this._cur = null; this.speaking = false; this._duck(false);
      this._tone(2475, 0.25);                        // NOGO tone
      this._static(0.6);
    } catch (e) {
      this.lastSource = 'error';
      this._cur = null; this.speaking = false; this._duck(false);
      this._fallback('clip non riproducibile: ' + item.id, this.allowTTS ? item.fb : null);
    } finally {
      this._busy = false;
      if (this._queue.length && !this.muted && this.lang !== 'mute') this._pump();
    }
  }

  _note(id, src, text, phase) {
    this.trace.push({ id: id, src: src, phase: phase || '', text: text || '', t: Date.now() });
    if (this.trace.length > 400) this.trace.shift();
  }

  /** Ultimo recurso: la voce del browser (lenta su Windows, ma sempre presente). */
  speakLine(clean) {
    if (!this.allowTTS) return;
    if (this.speaking) {                       // una clip è già in onda: non si sovrappone
      this._ttsRetry = (this._ttsRetry || 0) + 1;
      if (this._ttsRetry < 40) { setTimeout(() => { this.speakLine(clean); }, 250); return; }
      this._ttsRetry = 0;
    }
    const ss = window.speechSynthesis;
    this._tone(2525, 0.25);                       // GO tone
    if (!ss) { this.lastSource = 'tones'; this._static(1.6); this._tone(2475, 0.25, 1.8); return; }
    if (ss.speaking && ss.pending > 3) return;    // coda satura: skip
    const u = new SpeechSynthesisUtterance(clean);
    const want = this.lang === 'eng' ? 'en' : 'it';
    u.lang = this.lang === 'eng' ? 'en-US' : 'it-IT';
    u.rate = 1.06; u.pitch = 0.95;
    const vs = this._voices || (ss.getVoices ? ss.getVoices() : []);
    const nat = vs.filter((x) => /\(natural\)|neural|natural|online|premium/i.test(x.name));
    const v = nat.find((x) => x.lang.toLowerCase().startsWith(want))
      || vs.find((x) => x.lang.toLowerCase() === want + '-' + want.toUpperCase())
      || vs.find((x) => x.lang.toLowerCase().startsWith(want));
    if (v) u.voice = v;
    const t0 = performance.now();
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(wd);
      this.speaking = false;
      this._tone(2475, 0.25);                     // NOGO tone
      this._static(Math.max(0.6, (performance.now() - t0) / 1000));
    };
    const wd = setTimeout(finish, 16000);         // watchdog: engine muto
    u.onend = finish;
    u.onerror = (e) => {
      if (e && e.error === 'not-allowed' && !u.__retry) {
        u.__retry = 1; setTimeout(() => { try { ss.speak(u); } catch (x) { finish(); } }, 350);
        return;
      }
      finish();
    };
    this._static(2.5);
    this.speaking = true;
    this.lastSource = 'tts';
    try { ss.speak(u); } catch (e) { finish(); }
  }

  /** Feedback immediato al click/tasto: "prova radio" parlata. */
  confirm() {
    if (!this.ensure()) return;
    if (this.lang === 'mute') { this._tone(1250, 0.1); this._tone(900, 0.12, 0.13); return; }
    const t = this.lang === 'eng'
      ? 'Radio check. Control is on. English.'
      : 'Prova radio. Il controllo è attivo. Italiano.';
    const hit = resolveClip(t, 'RADIO');
    if (hit && this.libraryReady) {
      this._queue.length = 0;
      this._queue.push({ id: hit.id, lang: this.lang === 'eng' ? 'en' : 'it', fb: t });
      this._pump();
      return;
    }
    this._fallback('prova radio senza libreria clip', t);
  }

  /* ---------------- audio procedurale per-frame ---------------- */

  /* ---------------- FX del RIENTRO (plasma, sparo paracadute, mare) ---------------- */

  /** Bus dedicati: rombo del plasma e sciabordio. Creati al primo uso. */
  _buildRientro() {
    const ctx = this.ctx;
    this.plasmaGain = ctx.createGain(); this.plasmaGain.gain.value = 0;
    this.plasmaBp = ctx.createBiquadFilter(); this.plasmaBp.type = 'bandpass';
    this.plasmaBp.frequency.value = 260; this.plasmaBp.Q.value = 0.6;
    const pb = ctx.createBufferSource(); pb.buffer = this._noise(true); pb.loop = true;
    pb.connect(this.plasmaBp); this.plasmaBp.connect(this.plasmaGain);
    this.plasmaGain.connect(this.master); pb.start();
    this.seaGain = ctx.createGain(); this.seaGain.gain.value = 0;
    const slp = ctx.createBiquadFilter(); slp.type = 'lowpass'; slp.frequency.value = 380;
    const sb = ctx.createBufferSource(); sb.buffer = this._noise(true); sb.loop = true;
    sb.playbackRate.value = 0.55;
    sb.connect(slp); slp.connect(this.seaGain); this.seaGain.connect(this.master); sb.start();
    this._retStage = null; this._beacon = 0;
  }

  /** Sparo di un paracadute: colpo grave di noise + click. */
  _pop(vol = 0.5, f = 150) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this._noise(false);
    src.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.34);
    src.connect(lp); lp.connect(g); g.connect(this.master); src.start(t); src.stop(t + 0.4);
    this._tone(f * 0.6, 0.12, 0, vol * 0.25);
  }

  /** Ammaraggio: chiuffo (sweep verso il basso) + spray. */
  _splashFx() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this._noise(false);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(2400, t); bp.frequency.exponentialRampToValueAtTime(180, t + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 1.3);
    src.connect(bp); bp.connect(g); g.connect(this.master); src.start(t); src.stop(t + 1.4);
  }

  /** Rotore dell'elicottero di recupero: lambo grave ripetuto. */
  _heliFx() {
    for (let i = 0; i < 26; i++) this._tone(58 + (i % 3) * 6, 0.07, i * 0.115, 0.075);
  }

  /** Aggiorna gli FX del rientro leggendo lo stato reale della simulazione. */
  rientroTick(sim) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (!this.plasmaGain) this._buildRientro();
    const now = this.ctx.currentTime;
    const altE = Math.hypot(sim.ship.x, sim.ship.y) - sim.astro.earth.radius;
    const q = Math.max(0, Math.min(1, sim.qHeat / ATM.qRef));
    const inAtm = altE > 0 && altE < ATM.top;
    this.plasmaGain.gain.setTargetAtTime(inAtm && q > 0 ? 0.02 + 0.26 * q : 0, now, 0.25);
    this.plasmaBp.frequency.setTargetAtTime(200 + 1600 * q + (sim.blackout ? 900 : 0), now, 0.3);
    const sea = sim.status === 'SPLASHDOWN';
    this.seaGain.gain.setTargetAtTime(sea ? 0.045 : 0, now, 1.5);
    const stage = sea ? 'splash' : sim.chuteStage === 'main' ? 'main'
      : sim.chuteStage === 'drogue' ? 'drogue' : 'plasma';
    if (stage !== this._retStage) {
      this._retStage = stage;
      if (stage === 'drogue') this._pop(0.5, 170);
      if (stage === 'main') { this._pop(0.7, 120); this._pop(0.45, 95); }
      if (stage === 'splash') { this._splashFx(); this._beacon = now + 2; }
    }
    if (sea && now > this._beacon) { this._beacon = now + 1.7; this._tone(1180, 0.08, 0, 0.045); }
  }

  tick(sim, altM) {
    if (!this.ctx || this.ctx.state !== 'running' || this.lang === 'mute') return;
    const now = this.ctx.currentTime;
    // rombo motori
    const th = sim.status === 'NOMINAL' && sim.ship.throttle > 0.02 ? sim.ship.throttle : 0;
    this.engGain.gain.setTargetAtTime(th > 0 ? 0.05 + 0.24 * th : 0, now, 0.08);
    // soffi RCS: variazione di attitudine
    const att = sim.ship.attitude;
    if (this._att !== undefined && Math.abs(att - this._att) > 0.004 && now - this._puff > 0.18) {
      this._puff = now; this._rcs();
    }
    this._att = att;
    // ping LiDAR sotto i 25 km (più fitto vicino al suolo)
    if (altM > 0 && altM < 25e3 && sim.status === 'NOMINAL') {
      const iv = 0.12 + (altM / 25e3) * 1.3;
      if (now - this._ping > iv) { this._ping = now; this._pingTone(altM); }
    }
    // Master Alarm bitonale sul fault
    if (sim.thrustFactor < 1 && !this._alarm) { this._alarm = true; this._alarmSeq(now); }
    if (sim.thrustFactor >= 1) this._alarm = false;
    this.rientroTick(sim);
  }

  _rcs() {
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this._noise(false);
    src.playbackRate.value = 1.6;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2100; bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.09, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.13);
  }

  _pingTone(altM) {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    const f = 900 + (1 - altM / 25e3) * 900;   // più vicino = più acuto
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.7, t + 0.09);
    g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.12);
  }

  _alarmSeq(t0) {
    for (let i = 0; i < 8; i++) {
      this._tone(880, 0.22, i * 0.5, 0.16);
      this._tone(620, 0.22, i * 0.5 + 0.25, 0.16);
    }
  }
}
