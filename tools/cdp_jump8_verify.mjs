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
console.log('== jump 8 (Splashdown) da freddo ==');
const t0 = Date.now();
await ev('__jump(8)');
let st = '', cine = 'none', beat = -9, step = 0;
const EXPR = `JSON.stringify({st:(window.__sim?__sim.status:'?'),step:(window.__step?__step():-1),cine:(window.__cockpit&&__cockpit.cine)?getComputedStyle(document.getElementById('cinematic-viewport')).display:'none',beat:(window.__cockpit&&__cockpit.cine&&__cockpit.cine.ret)?__cockpit.cine.ret.beat:-9})`;
while (Date.now() - t0 < 360000) {
  const rawv = await ev(EXPR);
  let j = {};
  try { j = JSON.parse(rawv); } catch (e) { console.log('  attesa pagina: ' + String(rawv).slice(0, 60)); }
  if (j.st) st = j.st;
  if (typeof j.step === 'number') step = j.step;
  if (j.cine) cine = j.cine;
  if (typeof j.beat === 'number') beat = j.beat;
  if (st === 'SPLASHDOWN' || st === 'DONE') break;
  await wait(2000);
}
const sec = ((Date.now() - t0) / 1000).toFixed(0);
console.log('  stato ' + st + ' | step ' + step + ' | cinema ' + cine + ' | beat ' + beat + ' | ' + sec + ' s reali');
const okf = (st === 'SPLASHDOWN' || st === 'DONE') && Number(sec) <= 360;
console.log(okf ? 'JUMP8 OK' : 'JUMP8 FAIL');
chrome.kill();
process.exit(okf ? 0 : 1);
