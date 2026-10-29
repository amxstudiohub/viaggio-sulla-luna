---
name: cislunar-2030
description: >
  Lavoro su CISLUNAR 2030 (~/Applicazioni/Viaggio_Sulla_Luna), simulatore di
  viaggio cislunare 2D in HTML5 Canvas + moduli ES6 vanilla (zero dipendenze),
  CNSA Mengzhou+Lanyue vs Starship HLS, CR3BP scalato 1:10. Usare quando si
  tocca main.js, core/physics.js, systems/autopilot.js, systems/descent.js,
  ui/cockpit.js, le cinematiche di atterraggio/decollo, l'autopilota, i jump
  della timeline, il warp, i test in tests/, il packaging Windows, o si deve
  riprendere il lavoro da dove era stato lasciato.
---

# CISLUNAR 2030 — skill operativa del progetto

> Ultima verifica: 22-10-2026 — suite verde (smoke 11/11 · integration · autopilot · phase2 · spacex · comms)
> e flusso CDP completo: Atto 0 → TLI → LOI → discesa cinematica → surface hold → SPAZIO → F8 → rendezvous → TEI → splashdown.
> **Pubblicato su GitHub Pages: <https://amxstudiohub.github.io/viaggio-sulla-luna/>** (repo pubblico, deploy da workflow, `shots/live_github_pages.png` è la prova).
> Tutti i numeri qui sono ricontrollati contro il codice, non tramandati.

## 0. Regole non negoziabili
- **MAI leggere+riscrivere file grandi per intero**: il cap byte di tools.read (~1130 righe) TRONCA il file e il write lo corrompe (successo 2 volte; recuperato da cache Chrome). Usare SEMPRE `tools.edit` con `old_string` mirati.
- **`node --check` dopo ogni modifica JS** prima di dichiarare finito.
- UI in **italiano**; negli apici singoli JS l'apostrofo va scritto `\u0027`.
- CSS transform: `translate() scale()` (mai scale-then-translate: i px verrebbero moltiplicati).
- Prima dei test browser: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8137` → 200, altrimenti riavviare il server (`python3 -m http.server 8137` in background dal workspace).
- Approval policy "never": mai `sandbox_permissions`.

## 1. Com'è fatto (mappa)
| File | Ruolo |
|------|-------|
| `index.html` | shell HUD: topbar (MET/WARP/STATUS/AUTOPILOT/◀◀/▶▶/RADIO), timeline 9 fasi cliccabile, pannelli, help |
| `main.js` | bootstrap, input tastiera, loop frame (substep DT_PHYS=0.1s), jump timeline (JUMPS/stepIndex/driveJump), surfaceHold, TimeWarp |
| `core/physics.js` | Sim: CR3BP, `gravityAt`, `moonState`, `altitudeAboveNearest`, `progradeUnit`, staging, `activeGroup` (gruppi motore eleggibili solo se reggono il peso locale) |
| `systems/autopilot.js` | macchina a fasi F1→F13 (F11 crociera+sgancio SM, F12 rientro a skip, F13 ammaraggio; PHASE stringhe italiane), PDIT trigger, tdWait, narrazione |
| `systems/descent.js` | DescentGNC/AscentGNC (PID, glide-slope, fault a 3 km) |
| `systems/planner.js` | TimeWarp (scala [1,2,3,10,100,1000,2000,5000]: `set(v)` accetta SOLO valori della scala — 2 e 3 servono alla cinematica di rientro) + ManeuverNode |
| `ui/cockpit.js` | canvas tattico + cinematica: `_cinematic` (discesa/ascesa 25 km→suolo), `_surface` (hold), `_plumeFrame`, `_dustFrame`, `_moonSprite` (Luna procedurale cached), `forceSurface()`, Atto 0 lancio |
| `systems/audio_comms.js` | radio: clip pre-baked su radio bus (HP120→LP3400→saturazione→flutter), Quindar, ducking, coda FIFO, fallback TTS browser |
| `data/comms_lines.js` | COPIONE radio: 57 righe IT/EN + regex di aggancio al messaggio del Director, slot numerici a griglia chiusa, `numToIt`/`numToEn` |
| `data/comms_manifest.json` + `assets/audio/comms/` | ~206 clip mp3 (mono 24 kHz, ~5 MB, 28 min) + manifest `{f, ms, sha, text}` |
| `tools/tts_bake.mjs` | bake copione→mp3 (edge-tts `it-IT-DiegoNeural`/`en-US-ChristopherNeural` + ffmpeg loudnorm/trim) |
| `tools/comms_harvest.mjs` · `comms_check.mjs` · `cdp_comms_verify.mjs` | corpus reale dal browser · verifica copertura · verifica playback headless (`--base=` per provare il sito pubblico) |
| `.github/workflows/pages.yml` | deploy GitHub Pages: copia in `_site` SOLO il runtime (index, main.js, core, systems, ui, styles, data, assets) e usa `actions/deploy-pages`. Il resto del repo (shots, test, tool, docx) non viene pubblicato. |
| `ui/hud.js`, `styles/` | HUD testuale, CSS |
| `assets/`, `assets/img/` | cover, texture regolite/lunar_tactical, sprite lander/rocket/pad/fumo (con varianti _key per chroma) |
| `tests/` | smoke.mjs · integration.mjs · autopilot.test.mjs · phase2.test.mjs · spacex.test.mjs |
| `shots/` | screenshot regressivi UI_01…UI_19 (confronto visivo) |
| `Avvio_Windows.bat` + `server_node.cjs` + `LEGGIMI_WINDOWS.txt` | packaging Windows |

## 2. Fisica (scala 1:10)
GM_T=3.98e12 · GM_L=4.884e10 · R_T=657.1 km (637.1) · R_L=173.7 km · a=38.440 km · SOI≈6.580 km.
PHASE: "F7 DISCESA TATTICA", "F8 RISALITA LUNARE", ecc. sim.status: NOMINAL/TOUCHDOWN/DOCKED/SPLASHDOWN/CRASHED.
Missioni: CNSA (Lanyue ~6 t, YF-36) e SPACEX HLS (~683 t a DISCESA, RAPTOR6 14.358 MN + RCS 240 kN maxAlt 100 m).
Tempistiche: TOUCHDOWN ~21.5 h, LIFTOFF 21.6 h, DOCKED ~23 h, SPLASHDOWN ~39.5 h (CNSA, con skip).

**Rientro — scala da ricordare** (`core/physics.js`): lunghezze ÷10 e tempo reale ⇒ `v_reale = v_sim·√10`,
`h_reale = h_sim·10`, **accelerazioni già reali**. Ne segue `CdA_sim = 10·CdA_reale` (capsula 210),
densità dalla tabella US Standard `RHO_TABLE` (un'esponenziale single-H sbagliava di ~20× sopra i 40 km,
12-13 g e niente skip), `ATM.top = 10e3` sim = 100 km reali. Paracadute con `k = G0/vT²`: il rilassamento
lineare verso la velocità terminale non bilancia la gravità (impatto a 25 m/s invece di 8,5).
Corridoio TEI: perigeo 57-58 km reali ⇒ UN solo rimbalzo; sotto 56 km non skipa, sopra 60 non rientra più
(watchdog `_richiamo()`). Scena terminale ≈ 122 s reali (warp 3 in atmosfera, 100 sul rimbalzo, 2 coi paracadute).

## 3. Flusso jump/autopilota (dopo il fix anti-crash 21-10)
- `jumpTo(i)`: solo in avanti (`stepIndex() > i` ⇒ "già superata"); un click nuovo **ritargetta** il salto (non va rifiutato). Abort solo su **mancanza di progressi** della sim (15 s) o cap duro 8 min — il vecchio budget "25 s + 24 s per fase" mollava a metà transizione (era il «si blocca» del 29-10).
- `jumpNext()` (SPAZIO/N) = `stepIndex()+1`.
- `driveJump`: warp cappato a 10 nelle fasi critiche LOI/STAGE/DESAT/DISCESA/ASCESA/**TEI** (mai saltare finestre PDIT **né la finestra TEI**: a warp 5000 il corridoio va in mancamento, verificato a 260 milioni di km). Fuori dalle critiche il warp minimo è 10, non 1.
- Surface hold: a TOUCHDOWN con cine attivo → `surfaceHold=true` (sim congelata), `endJump` se attivo, `tdWait=Infinity`; SPAZIO → `surfaceDone=true; tdWait=sim.t-1` → F8 seamless. `surfaceDone` one-shot, reset in startMission.
- Warp manuale SEMPRE attivo: PagSu/PagGiù + pulsanti ◀◀/▶▶ (bypassano il guard autopilota di , .).
- Attenzione: `endAct0` deve ripristinare `E.lander.style.display` (lo staging lo nasconde) — bug "manca l'astronave" già corretto.

## 4. Run & debug browser
- Server: `python3 -m http.server 8137` dal workspace (job in background). GUI DSH su 3080.
- URL utili: `?mission=cnsa|spacex&auto=1` (skip menu), `&act0=1` (lancio cinematico).
- Handle debug globali: `window.__sim`, `__ap` (autopilot), `__cockpit`, `__jump(i)`.
- `__jump(3)` arriva a TOUCHDOWN in ~40 s; il fast-forward brucia la finestra cinematica → serve `forceSurface()`.
- Test CDP headless (server su 8137, poi `node tools/<script>`): `tools/cdp_surface_hold.mjs` (discesa→hold→SPAZIO→F8 + shot ui_15/16), `tools/cdp_jump_warp_verify.mjs` (Pag±, pulsanti, SPACE spam anti-regressione), `tools/cdp_moon_shots.mjs` (shot Luna medio/grande). Pattern: google-chrome --headless=new --remote-debugging-port + WebSocket Node 22, Runtime.evaluate returnByValue; rAF limitato → pollare `__sim.status`, mai attese passive; `window.dispatchEvent(new KeyboardEvent('keydown',{key:' '}))` funziona.
- Cache-busting: il server non invia no-cache; per JS appena modificato usare profilo Chrome nuovo o Page.reload{ignoreCache}.

## 5. Test
```
node tests/smoke.mjs          # 11 test fisica/planetaria
node tests/integration.mjs    # missione CNSA completa headless
node tests/autopilot.test.mjs # demo autopilota
node tests/phase2.test.mjs    # 58 messaggi director, fino a splashdown
node tests/spacex.test.mjs    # HLS: atterraggio ~2.1 g max
node tests/comms.test.mjs       # copione radio + numeri a parole + matching sorgenti + manifest
node tools/comms_check.mjs      # copertura: ogni messaggio detto ha la sua clip (IT e EN)
node tools/tts_bake.mjs         # ribake idempotente (solo le righe il cui testo è cambiato)
node tools/comms_harvest.mjs    # rigenera data/comms_corpus.json (serve server 8137 + chrome)
node tools/cdp_splash_verify.mjs     # scena F11-F13 completa nel browser: 18 check, ~2 min
node tools/cdp_chips.mjs             # click dei chip 4→6→7→8→9 partendo dalla Luna
node tools/cdp_full_mission.mjs play|jumps [sec]   # missione giocata: rileva loop morto / sim ferma
node tools/cdp_comms_verify.mjs # browser: clip in onda, stop, ENG, zero speechSynthesis
node tools/cdp_tts_probe.mjs    # missione intera headless: 0 messaggi non baked, 0 speak()
node tools/cdp_comms_verify.mjs --base=https://amxstudiohub.github.io/viaggio-sulla-luna  # prova il sito live
```
Dopo modifiche a physics/autopilot/descent lanciare TUTTA la suite; per UI/cockpit basta CDP + node --check.

## 6. Trappole conosciute (già pagate)
- `activeGroup`: un gruppo sotto-peso (RCS HLS) NON deve sostituire i Raptor → filtro su T/W>1.05·g locale.
- PDIT: trigger anche con `moonVT() > 300` (HLS arriva a 25 km con vT~700 m/s, la finestra vUp>-40 non basta).
- **`frame()` deve avere try/catch**: senza, una sola eccezione ammazza il loop rAF e il gioco «si blocca» per sempre. Ora logga `window.__frameError` + contatori `__frames`/`__frameMs`/`__prof` (upd/phys/rend) per i test.
- `cine.ret` della cinematica rientro va creato con **lazy-init**: se la vista cinema è già attiva (superficie lunare) il ramo `if (!R.active)` non gira e `rt.age` va in eccezione.
- **Chip 7/8/9**: se non si è già in crociera di ritorno inseriscono la traiettoria calibrata con `__rientro(periKm, altKm, fase)` (600 km per il 7, 120 km per 8/9). Il fast-forward non può far calcolare la finestra TEI all'autopilota.
- Tasto `0` = reset missione: ora pretende **SHIFT+0** (un dito sul 0 cancellava tutto: «riparte male»).
- LiDAR cinematica: verde anche in ascesa (`vOk = asc || ...`).
- Ombra di contatto a touchdown: spegne il pennacchio impresso nello sprite (ellisse +108 px, non +150).
- Orizzonte laterale cinematica: feetY = H/2+140 (piedi sprite), fascia regolite scaleY 0.42.
- Luna procedurale: cache offscreen per bucket 3 px, PRNG seedato (niente flicker).
- Moduli ES6 da file:// bloccati: serve sempre un server locale (vedi §7); il packaging Windows non esiste più.
- Voce radio: lo schermo mostra il testo del Director, la radio legge il copione (`data/comms_lines.js`): sono DUE testi diversi. Cambiare una riga del copione senza `node tools/tts_bake.mjs` lascia la clip vecchia (`comms_check` lo segnala come "testo cambiato").
- Token fine-grained per i push: servono **Contents**, **Administration**, **Pages** e **Workflows** (Read and write). Senza Workflows il push di un file sotto `.github/workflows/` viene rifiutato con 403 anche se i contenuti sono scrivibili. Cambiare una riga del copione senza `node tools/tts_bake.mjs` lascia la clip vecchia (`comms_check` lo segnala come "testo cambiato").
- **`TimeWarp.set(v)` è muto se `v` non è nella scala**: `set(4)`/`set(200)` non fanno nulla, in silenzio. La scala ora include 2 e 3 (volo in atmosfera).
- Nei tool di calibrazione `ap.active` deve essere `true`, altrimenti `hold()` esce subito e la portanza è azzerata: risultati identici per ogni ClA.
- HUD e cinematica del rientro mostrano solo numeri REALI (`hReal`/`vReal`): mai esporre unità sim all'utente.
- **`speechSynthesis` è disattivata di default** (`AudioComms.allowTTS=false`): il fallback sulla voce del browser era il modo più sicuro di sentire una seconda voce sovrapposta alla radio. Si riaccende solo per diagnostica con `index.html?tts=1`. Un messaggio senza clip fa sentire i soli toni + `sim.log('RADIO: ...','warn')`. Verifica con `node tools/cdp_tts_probe.mjs` (0 chiamate a speak, 0 messaggi non baked).
- Le `re` del copione girano sul testo NORMALIZZATO (minuscolo, accenti spogliati, punteggiatura→spazio): niente apostrofi né parentesi nelle regex, e vanno tenute non ambigue (test 4 di comms.test). Il testo `it:`/`en:` del copione invece va scritto in italiano CORRETTO (accenti e apostrofi veri: "l'orbita", "velocità", "è", mai "spegnuto" → "spento"): edge-tts pronuncia meglio e il manifest è l'unico testo verificabile.
- Slot numerici = griglia chiusa min/max/step: il valore viene arrotondato e cappato, quindi la clip esiste sempre; se il regex dello slot non matcha, la riga viene letta senza numero.
- Recovery file corrotto: cache disco Chrome in /tmp/chrome-prof-*/Default/Cache/Cache_Data (grep firma, slice tra 'import {' e ultimo '}' prima di \u0000).

## 7. Distribuzione (packaging Windows rimosso il 29-10)
Il gioco è pubblico su GitHub Pages (<https://amxstudiohub.github.io/viaggio-sulla-luna/>):
`Avvio_Windows.bat`, `server_node.cjs` e `LEGGIMI_WINDOWS.txt` sono eliminati e non vanno reintrodotti.
In locale usare `node tools/nocache_server.mjs`: `python -m http.server` non invia `Cache-Control`,
Chrome serve JS vecchi dalla cache e i test CDP diventano falsi verdi.
Copione cambiato → `node tools/tts_bake.mjs && node tools/comms_harvest.mjs && node tools/comms_check.mjs`.

## 8. Stato e idee pendenti
FATTO: Fasi 0-2, audio CapCom i18n, **voce radio a clip neurali pre-registrate (bake offline, IT+EN, 206 clip)**, timeline cliccabile, warp smart, attitude alignment, allunaggio/ascesa cinematici (fiamme, LiDAR, polvere, orizzonte laterale), surface hold, Atto 0 lancio con staging, fix jump anti-crash, Pag±/pulsanti warp, Luna procedurale, zip Windows.
IDEA: rotazione longitudinale Luna, polvere anche su HLS, audio dedicato al comando decollo, orbit track proiettato sulla Luna, save/load stato missione.
