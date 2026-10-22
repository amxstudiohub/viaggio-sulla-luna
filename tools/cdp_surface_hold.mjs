import fs from 'fs';
import { spawn } from 'child_process';
const PORT = 9361;
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--user-data-dir=/tmp/chrome-prof-surf', '--remote-debugging-port=' + PORT,
  '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
async function getJson(url) { for (let i = 0; i < 80; i++) { try { return await (await fetch(url)).json(); } catch { await new Promise(r => setTimeout(r, 500)); } } throw new Promise((_, rj) => rj(new Error('no chrome'))); }
const ver = await getJson('http://127.0.0.1:' + PORT + '/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); } };
const raw = (o) => new Promise((res) => { o.id = ++id; pend.set(o.id, res); ws.send(JSON.stringify(o)); });
const { result: { targetId } } = await raw({ method: 'Target.createTarget', params: { url: 'http://127.0.0.1:8137/?mission=cnsa&auto=1' } });
const { result: { sessionId } } = await raw({ method: 'Target.attachToTarget', params: { targetId, flatten: true } });
const cmd = (method, params = {}) => raw({ method, params, sessionId });
const ev = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.result && r.result.exceptionDetails) console.log('PAGE-ERR', String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description).slice(0, 200)); return r.result && r.result.result && r.result.result.value; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (f) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); };
await wait(3000);
await ev('__jump(3); "ok"');
let t0 = Date.now();
while (Date.now() - t0 < 150000 && await ev('__sim.status') !== 'TOUCHDOWN') await wait(1500);
console.log('status:', await ev('__sim.status'), '| cine attivo:', await ev('__cockpit.cine.active'), '| phase:', await ev('__ap.phase'));
await wait(2500);
const tA = await ev('__sim.t');
await wait(1800);
const tB = await ev('__sim.t');
console.log('PAUSA:', tA === tB ? 'sim congelata OK' : 'NON in pausa! ' + (tB - tA) + 's');
await shot('shots/ui_15_surface_hold.png');
await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: " " })); "spazio"');
t0 = Date.now();
while (Date.now() - t0 < 60000 && await ev('__ap.phase') !== 'F8 RISALITA LUNARE') await wait(1000);
console.log('dopo SPAZIO — phase:', await ev('__ap.phase'), '| status:', await ev('__sim.status'), '| cine:', await ev('__cockpit.cine.active'));
const tC = await ev('__sim.t');
await wait(1500);
console.log('sim riparte:', Number(await ev('__sim.t')) > tC ? 'SÌ' : 'NO');
await shot('shots/ui_16_liftoff_seamless.png');
chrome.kill(); process.exit(0);