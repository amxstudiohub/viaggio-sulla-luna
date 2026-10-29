/**
 * Screenshot della scena terminale (plasma → paracadute → ammaraggio → recupero).
 * Richiede il server su :8137. Uso: node tools/cdp_splash_shots.mjs
 */
import { spawn } from 'child_process';
import fs from 'node:fs';
const PORT = 9393;
const OUT = 'shots';
fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--user-data-dir=/tmp/chrome-prof-shot', '--remote-debugging-port=' + PORT,
  '--window-size=1600,900', 'about:blank'], { stdio: 'ignore' });
async function getJson(url) { for (let i = 0; i < 80; i++) { try { return await (await fetch(url)).json(); } catch { await new Promise(r => setTimeout(r, 250)); } } throw new Error('chrome giù'); }
const ver = await getJson('http://127.0.0.1:' + PORT + '/json/version');
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); } };
const raw = (o) => new Promise((res) => { o.id = ++id; pend.set(o.id, res); ws.send(JSON.stringify(o)); });
const { result: { targetId } } = await raw({ method: 'Target.createTarget', params: { url: 'http://127.0.0.1:8137/?mission=CNSA&auto=1' } });
const sid = (await raw({ method: 'Target.attachToTarget', params: { targetId, flatten: true } })).result.sessionId;
const cmd = (method, params = {}) => raw({ method, params, sessionId: sid });
const ev = async (expr) => { const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result?.result?.value; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (name) => {
  const r = await cmd('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '/' + name + '.png', Buffer.from(r.result.data, 'base64'));
  console.log('  📸 ' + name + '.png');
};
await cmd('Page.enable');
await wait(3500);
console.log('rientro: ' + await ev('__rientro(57.6)'));
let done = { plasma: false, drogue: false, main: false, splash: false, rec: false };
const t0 = Date.now();
while (Date.now() - t0 < 420000) {
  const j = JSON.parse(await ev('JSON.stringify({st:__sim.status,ch:__sim.chuteStage,q:__sim.qHeat,beat:(__cockpit.cine&&__cockpit.cine.ret)?__cockpit.cine.ret.beat:-9})'));
  if (!done.plasma && j.q > 6000) { await shot('rientro_plasma'); done.plasma = true; }
  else if (!done.drogue && j.ch === 'drogue') { await shot('rientro_drogue'); done.drogue = true; }
  else if (!done.main && j.ch === 'main') { await shot('rientro_principali'); done.main = true; }
  else if (!done.splash && j.st === 'SPLASHDOWN') { await shot('ammaraggio'); done.splash = true; }
  else if (!done.rec && j.beat >= 2) { await shot('recupero'); done.rec = true; break; }
  await wait(900);
}
console.log('scatti:', Object.entries(done).map(([k, v]) => k + '=' + v).join(' '));
chrome.kill(); process.exit(0);
