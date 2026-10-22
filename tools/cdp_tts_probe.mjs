/**
 * CISLUNAR 2030 — sonda: chi chiama ancora speechSynthesis? (tools/cdp_tts_probe.mjs)
 * Intercetta speechSynthesis.speak PRIMA di ogni script di pagina e registra
 * testo, voce e stack del chiamante, insieme alla trace della radio.
 * Richiede il server su 127.0.0.1:8137.
 */
import { spawn } from 'child_process';
const MISSION = (process.argv.find((a) => a.startsWith('--mission=')) || '--mission=cnsa').split('=')[1];
const PORT = 9391;
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', '--user-data-dir=/tmp/chrome-prof-ttsprobe',
  '--remote-debugging-port=' + PORT, '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function getJson(url) { for (let i = 0; i < 80; i++) { try { return await (await fetch(url)).json(); } catch { await wait(500); } } throw new Error('chrome down'); }
const ver = await getJson('http://127.0.0.1:' + PORT + '/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); } };
const raw = (o) => new Promise((res) => { o.id = ++id; pend.set(o.id, res); ws.send(JSON.stringify(o)); });
const { result: { targetId } } = await raw({ method: 'Target.createTarget', params: { url: 'about:blank' } });
const { result: { sessionId } } = await raw({ method: 'Target.attachToTarget', params: { targetId, flatten: true } });
const cmd = (method, params = {}) => raw({ method, params, sessionId });
const ev = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result && r.result.result.value; };
const PATCH = [
  "window.__ttsLog = [];",
  "try {",
  "  var ss = window.speechSynthesis;",
  "  var sp = ss.speak.bind(ss);",
  "  ss.speak = function (u) {",
  "    window.__ttsLog.push({ t: Math.round(performance.now()), text: String(u.text).slice(0, 70),",
  "      voice: u.voice ? u.voice.name : '(voce di sistema)', lang: u.lang,",
  "      stack: String(new Error().stack).split('\n').slice(1, 6).join(' <- ').replace(/\s+/g, ' ') });",
  "    return sp(u);",
  "  };",
  "} catch (e) { window.__ttsLog.push({ t: 0, text: 'patch fallita: ' + e.message, stack: '' }); }",
].join('\n');
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
await cmd('Page.navigate', { url: 'http://127.0.0.1:8137/?mission=' + MISSION + '&auto=1' });
await wait(6000);
const STEP = '(function(){try{return __step()}catch(e){return -1}})()';
const seen = new Map();
async function pull() {
  const tr = JSON.parse(await ev('JSON.stringify(__audio.trace)') || '[]');
  for (const t of tr) seen.set((t.phase || '') + '::' + (t.text || ''), t);
  await ev('__audio.trace.length = 0; 1');
}
await pull();
for (let i = 1; i <= 6; i++) {
  const t0 = Date.now(); let lastTry = 0;
  while (Date.now() - t0 < 120000) {
    await wait(1000); await pull();
    const st = await ev('__sim && __sim.status'), step = await ev(STEP);
    if (step >= i || st === 'SPLASHDOWN' || st === 'CRASHED') break;
    if (st === 'TOUCHDOWN') await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); 1');
    if (Date.now() - lastTry > 6000) { lastTry = Date.now(); await ev('__jump(' + i + '); 1'); }
  }
  console.log('  jump ' + i + ' step=' + await ev(STEP) + ' status=' + await ev('__sim && __sim.status') + ' | messaggi: ' + seen.size);
}
const tEnd = Date.now();
while (Date.now() - tEnd < 60000 && await ev('__sim && __sim.status') !== 'SPLASHDOWN') { await wait(1500); await pull(); }
await pull();
const log = JSON.parse(await ev('JSON.stringify(__ttsLog)') || '[]');
const all = [...seen.values()];
const cattivi = all.filter((t) => t.src !== 'baked');
console.log('missione ' + MISSION + ' | messaggi emessi: ' + all.length + ' | NON baked: ' + cattivi.length);
for (const t of cattivi) console.log('   [' + t.src + '] ' + t.id + ' :: ' + String(t.text).slice(0, 70));
console.log('=== speechSynthesis.speak chiamate: ' + log.length + ' ===');
for (const l of log) console.log('  +' + l.t + 'ms [' + l.voice + '] ' + l.text + ' <- ' + l.stack);
chrome.kill();
process.exit(cattivi.length || log.length ? 1 : 0);
