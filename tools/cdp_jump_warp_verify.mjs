import { spawn } from 'child_process';
const PORT = 9382;
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--user-data-dir=/tmp/chrome-prof-vf', '--remote-debugging-port=' + PORT,
  '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
async function getJson(url) { for (let i = 0; i < 80; i++) { try { return await (await fetch(url)).json(); } catch { await new Promise(r => setTimeout(r, 500)); } } throw new Error('no chrome'); }
const ver = await getJson('http://127.0.0.1:' + PORT + '/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); } };
const raw = (o) => new Promise((res) => { o.id = ++id; pend.set(o.id, res); ws.send(JSON.stringify(o)); });
const { result: { targetId } } = await raw({ method: 'Target.createTarget', params: { url: 'http://127.0.0.1:8137/?mission=cnsa&auto=1' } });
const sid = (await raw({ method: 'Target.attachToTarget', params: { targetId, flatten: true } })).result.sessionId;
const cmd = (method, params = {}) => raw({ method, params, sessionId: sid });
const ev = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.result && r.result.exceptionDetails) console.log('PAGE-ERR', String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description).slice(0, 200)); return r.result && r.result.result && r.result.result.value; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const key = (kk) => ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "' + kk + '" })), "k"');
await wait(2500);
console.log('== 1) PageUp/PageDown in autopilota ==');
const w0 = await ev('__ap.warp.current');
await key('PageUp'); await key('PageUp');
const w1 = await ev('__ap.warp.current');
await key('PageDown');
const w2 = await ev('__ap.warp.current');
console.log(' warp', w0, '->', w1, '->', w2, w1 > w0 && w2 < w1 ? 'OK' : 'FAIL');
console.log('== 2) bottone warp-up ==');
await ev('document.getElementById("warp-up-btn").click(), "c"');
const w3 = await ev('__ap.warp.current');
console.log(' dopo click:', w3, w3 > w2 ? 'OK' : 'FAIL');
console.log('== 3) SPACE ripetuto (era il bug) ==');
let crash = false, last = '';
for (let i = 0; i < 26; i++) {
  await key(' ');
  await wait(1300);
  const s = await ev('__sim.status + "|" + __ap.phase + "|w" + __ap.warp.current');
  if (s !== last) { console.log('  ' + i + ': ' + s); last = s; }
  if (await ev('__sim.status') === 'CRASHED') { crash = true; break; }
}
console.log(' crash:', crash ? 'FAIL' : 'nessuno OK', '| stato finale:', await ev('__sim.status + " | " + __ap.phase'));
chrome.kill(); process.exit(0);