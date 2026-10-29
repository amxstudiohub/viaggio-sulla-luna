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


/**
 * Missione completa giocata nel browser, come un utente.
 *   node tools/cdp_full_mission.mjs play    -> autopilota ON, guarda fino all'ammaraggio
 *   node tools/cdp_full_mission.mjs jumps   -> preme «fase successiva» a raffica
 * Segnala: loop morto (frames fermi), sim ferma (t fermo), errori di frame.
 */
const MODE = process.argv[2] || 'play';
const LIMIT = Number(process.argv[3] || 780) * 1000;
const EXPR = `JSON.stringify({f:window.__frames||0,t:Math.round(__sim.t),ph:__ap.phase,st:__sim.status,` +
  `w:__ap.warp.current,j:0,jerr:(window.__frameError||'').slice(0,200),` +
  `js:window.__jumpStats?Math.round(window.__jumpStats.worstMs):-1,` +
  `ev:(__sim.events.length?__sim.events[__sim.events.length-1].text:'')})`;
await wait(4000);
console.log('== modalita: ' + MODE + ' ==');
let prev = null, frozen = 0, dead = 0, t0 = Date.now(), lastJump = 0, lastSpace = 0;
let worstErr = '', maxT = 0;
while (Date.now() - t0 < LIMIT) {
  const s = await ev(EXPR);
  let j = {};
  try { j = JSON.parse(s); } catch (e) { console.log('  evaluate fallito: ' + String(s).slice(0, 80)); await wait(1500); continue; }
  if (j.jerr) worstErr = j.jerr;
  if (prev && j.f === prev.f) dead++; else dead = 0;
  if (prev && j.t === prev.t) frozen++; else frozen = 0;
  if (j.t > maxT) { maxT = j.t; console.log('  +' + ((Date.now() - t0) / 1000).toFixed(0) + 's  t=' + j.t + 's  ' + j.ph + '  warp ' + j.w + '  fps~' + Math.round(1000 / Math.max(1, j.js)) + '  | ' + j.ev.slice(0, 62)); }
  if (j.st === 'SPLASHDOWN' || j.st === 'DONE') { console.log('  ARRIVATO ALL\u0027AMMARAGGIO'); break; }
  if (j.st === 'CRASHED') { console.log  ('  CRASH: ' + j.ev); break; }
  if (MODE === 'jumps' && Date.now() - lastJump > 9000) { lastJump = Date.now(); await ev('__jumpNext()'); }
  if (frozen > 12) { frozen = 0; await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })), "k"'); }
  prev = j;
  await wait(1500);
}
const dur = ((Date.now() - t0) / 1000).toFixed(0);
const fin = await ev('JSON.stringify({st:__sim.status,ph:__ap.phase,step:__step(),f:window.__frames})');
console.log('  esito: ' + fin + ' dopo ' + dur + ' s');
if (worstErr) console.log('  ERRORE FRAME VISTO:\n   ' + worstErr);
const loopDead = dead > 8;
console.log(loopDead ? 'FULL FAIL: loop dei frame fermo' : (worstErr ? 'FULL FAIL: eccezione nel loop' : 'FULL OK (nessun blocco del loop)'));
chrome.kill();
process.exit(loopDead || worstErr ? 1 : 0);
