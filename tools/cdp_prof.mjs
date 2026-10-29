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

await wait(4000);
const prof = async (label) => {
  const s = await ev(`JSON.stringify({p:window.__prof,f:window.__frames,w:__ap.warp.current,ph:__ap.phase,t:Math.round(__sim.t),err:window.__frameError||''})`);
  console.log('  ' + label + ' :: ' + s);
};
console.log('== 60 s di gioco normale (autopilota ON) ==');
await prof('inizio');
await wait(30000);
await prof('dopo 30 s');
await wait(30000);
await prof('dopo 60 s');
console.log('== jumpNext: transizione di fase ==');
await ev('__jumpNext()');
await wait(20000);
await prof('durante il salto');
await wait(20000);
await prof('20 s dopo');
chrome.kill(); process.exit(0);
