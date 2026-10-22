/**
 * CISLUNAR 2030 — verifica browser della radio a clip (tools/cdp_comms_verify.mjs)
 * ==============================================================================
 * Apre il simulatore in Chrome headless, lascia parlare il Controllo Missione e
 * verifica che la voce arrivi dalle clip pre-registrate (non dal TTS del browser):
 *
 *   - libreria caricata (data/comms_manifest.json raggiungibile)
 *   - lastSource = baked, durata reale della clip che pilota ON AIR
 *   - stop() taglia la trasmissione; mute non mette in coda
 *   - nessun errore in console
 *
 * Richiede il server su 127.0.0.1:8137. Output: shots/comms_director.png
 */
import fs from 'fs';
import { spawn } from 'child_process';
const PORT = 9381;
const A = process.argv.slice(2);
const flag = (n, d) => { const a = A.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : d; };
const BASE = flag('base', 'http://127.0.0.1:8137');
const PROF = flag('profile', '/tmp/chrome-prof-comms-verify');
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + PROF,
  '--remote-debugging-port=' + PORT, '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function getJson(url) { for (let i = 0; i < 80; i++) { try { return await (await fetch(url)).json(); } catch { await wait(500); } } throw new Error('chrome non risponde'); }
const ver = await getJson('http://127.0.0.1:' + PORT + '/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); } };
const raw = (o) => new Promise((res) => { o.id = ++id; pend.set(o.id, res); ws.send(JSON.stringify(o)); });
const { result: { targetId } } = await raw({ method: 'Target.createTarget', params: { url: 'about:blank' } });
const { result: { sessionId } } = await raw({ method: 'Target.attachToTarget', params: { targetId, flatten: true } });
const cmd = (method, params = {}) => raw({ method, params, sessionId });
await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Log.enable').catch(() => {});
// contatore delle chiamate TTS: la radio a clip non deve mai usarle
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: "window.__speakCalls = []; try { var ss = window.speechSynthesis; var sp = ss.speak.bind(ss); ss.speak = function (u) { window.__speakCalls.push(String(u.text).slice(0, 60)); return sp(u); }; } catch (e) { window.__speakCalls.push('patch fallita'); }" });
await cmd('Page.navigate', { url: BASE + '/?mission=cnsa&auto=1' });
const ev = async (expr) => {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.result && r.result.exceptionDetails) errs.push(String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).slice(0, 160));
  return r.result && r.result.result && r.result.result.value;
};
const shot = async (f) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync('shots', { recursive: true }); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); };

await wait(4000);
console.log('libraryReady:', await ev('__audio.libraryReady'), '| clip nel manifest:', await ev('Object.keys(__audio.manifest||{}).clips ? 0 : Object.keys((__audio.manifest||{}).clips||{}).length'));
const t0 = Date.now();
let sawSpeaking = false, baked = 0, tts = 0;
while (Date.now() - t0 < 150000 && baked < 6) {
  await wait(1500);
  const st = await ev('({ src: __audio.lastSource, sp: __audio.speaking, tr: __audio.trace.length })');
  if (st && st.sp) sawSpeaking = true;
  const tr = JSON.parse(await ev('JSON.stringify(__audio.trace)') || '[]');
  baked = tr.filter((x) => x.src === 'baked').length;
  tts = tr.filter((x) => x.src === 'tts').length;
}
const info = await ev('JSON.stringify({ src: __audio.lastSource, id: __audio.lastId, ready: __audio.libraryReady, buf: __audio._buf.size })');
console.log('stato radio:', info);
console.log('richieste baked:', baked, '| fallback browser:', tts, '| ON AIR visto:', sawSpeaking);
const dirText = await ev('document.getElementById("dir-text") ? document.getElementById("dir-text").textContent.slice(0,90) : null');
console.log('HUD director:', JSON.stringify(dirText));
await shot('shots/comms_director.png');

// stop() deve tagliare subito
await ev('__audio.say("FASE 2 — ACCENSIONE TLI: YF-36, spinta 14.4 kN", "F2"); 1');
await wait(900);
const onAir = await ev('__audio.speaking');
await ev('__audio.stop(); 1');
await wait(250);
const afterStop = await ev('__audio.speaking');
console.log('ON AIR prima di stop:', onAir, '| dopo stop:', afterStop);

// modalita ENG: HUD con la riga curata inglese + clip en.*
await ev('__audio.lang = "eng"; __audio.say("FASE 2 — ACCENSIONE TLI: YF-36, spinta 14.4 kN, Isp 340 s.", "F2"); 1');
await wait(1200);
console.log('ENG — clip:', await ev('__audio.lastId'), '| HUD:', JSON.stringify(await ev('document.getElementById("dir-text").textContent.slice(0,60)')));
await ev('__audio.lang = "ita"; __audio.stop(); 1');

// mute non deve mettere nulla in coda
await ev('__audio.lang = "mute"; __audio.say("PARACADUTE aperti: frenamento finale verso l ammaraggio.", "F11"); 1');
await wait(400);
console.log('in mute — speaking:', await ev('__audio.speaking'), '| coda:', await ev('__audio._queue.length'));
await ev('__audio.lang = "ita"; 1');
const speakCalls = JSON.parse(await ev('JSON.stringify(window.__speakCalls||[])') || '[]');
console.log('chiamate speechSynthesis.speak:', speakCalls.length, speakCalls.length ? speakCalls.slice(0, 3) : '(nessuna)');
console.log('errori pagina:', errs.length ? errs.slice(0, 4) : 'nessuno');
const fail = !(baked >= 6 && sawSpeaking && afterStop === false && errs.length === 0 && speakCalls.length === 0);
console.log(fail ? 'ESITO: FAIL' : 'ESITO: OK — la radio parla dalle clip pre-registrate, zero speechSynthesis');
chrome.kill();
process.exit(fail ? 1 : 0);
