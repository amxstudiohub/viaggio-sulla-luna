/**
 * Verifica headless della scena terminale: F11/F12/F13 + ammaraggio + recupero.
 * Richiede il server su :8137. Uso: node tools/cdp_splash_verify.mjs
 */
import { spawn } from 'child_process';
const PORT = 9391;
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--user-data-dir=/tmp/chrome-prof-sp', '--remote-debugging-port=' + PORT,
  '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
async function getJson(url) { for (let i = 0; i < 80; i++) { try { return await (await fetch(url)).json(); } catch { await new Promise(r => setTimeout(r, 250)); } } throw new Error('chrome giù'); }
const ver = await getJson('http://127.0.0.1:' + PORT + '/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); }
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('console: ' + (m.params.args[0]?.value || ''));
};
const raw = (o) => new Promise((res) => { o.id = ++id; pend.set(o.id, res); ws.send(JSON.stringify(o)); });
const { result: { targetId } } = await raw({ method: 'Target.createTarget', params: { url: 'http://127.0.0.1:8137/?mission=CNSA&auto=1' } });
const sid = (await raw({ method: 'Target.attachToTarget', params: { targetId, flatten: true } })).result.sessionId;
const cmd = (method, params = {}) => raw({ method, params, sessionId: sid });
await cmd('Runtime.enable');
const ev = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.error) throw new Error(JSON.stringify(r.error).slice(0, 200)); return r.result?.result?.value; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ok = (b) => b ? 'OK' : 'FAIL';
let fail = 0;
const chk = (name, cond, extra = '') => { if (!cond) fail++; console.log('  [' + ok(cond) + '] ' + name + (extra ? ' — ' + extra : '')); };


/** Click sui chip della timeline partendo dalla superficie lunare (caso segnalato). */
const ST = `JSON.stringify({ph:__ap.phase,st:__sim.status,step:__step(),t:Math.round(__sim.t),` +
  `altE:Math.round(Math.hypot(__sim.ship.x,__sim.ship.y)-__sim.astro.earth.radius),` +
  `ev:(__sim.events.length?__sim.events[__sim.events.length-1].text:'').slice(0,70)})`;
const show = async (tag) => { const s = JSON.parse(await ev(ST)); console.log('  ' + tag + ' :: ' + s.ph + ' | ' + s.st + ' | step ' + s.step + ' | t=' + s.t + ' | ' + s.ev); return s; };
await wait(4000);
console.log('== chip 4 (Touchdown & Ascent): atterraggio ==');
await ev('__jump(3)');
for (let k = 0; k < 120; k++) { const s = JSON.parse(await ev(ST)); if (s.step >= 3) break; await wait(1000); }
await show('dopo chip 4');
for (const i of [5, 6, 7, 8]) {
  console.log('== chip ' + (i + 1) + ' premuto dalla Luna ==');
  await ev('__jump(' + i + ')');
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < 420000) {
    last = JSON.parse(await ev(ST));
    if (last.step >= i) break;
    await wait(2000);
  }
  console.log('  esito dopo ' + ((Date.now() - t0) / 1000).toFixed(0) + 's :: ' + last.ph + ' | ' + last.st +
    ' | step ' + last.step + ' | quota Terra ' + Math.round(last.altE / 100) + ' km reali | ' + last.ev);
  if (last.st === 'SPLASHDOWN') break;
}
const ferr = await ev('window.__frameError||""');
console.log(ferr ? '  ERRORE DI FRAME: ' + ferr : '  nessun errore di frame');
chrome.kill();
process.exit(ferr ? 1 : 0);
