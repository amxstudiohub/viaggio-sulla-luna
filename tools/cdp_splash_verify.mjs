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

await wait(3500);
console.log('== 1) capsula posta all’interfaccia di rientro ==');
console.log('  ' + await ev('__rientro(57.6)'));
await wait(1200);
const t0 = Date.now();
let sawCine = false, sawPlasma = false, sawDrogue = false, sawMain = false, blackout = false, qPeak = 0, hudQ = '—';
while (Date.now() - t0 < 240000) {
  const s = await ev('JSON.stringify({st:__sim.status,ch:__sim.chuteStage,q:__sim.qHeat,bo:__sim.blackout,cine:getComputedStyle(document.getElementById("cinematic-viewport")).display,cap:document.getElementById("cine-capsule").src,qh:document.getElementById("qheat").textContent})');
  const j = JSON.parse(s);
  if (j.q > 0 && j.qh && j.qh !== '—') hudQ = j.qh;
  qPeak = Math.max(qPeak, j.q);
  if (j.cine !== 'none') sawCine = true;
  if (j.q > 1000) sawPlasma = true;
  if (j.bo) blackout = true;
  if (j.ch === 'drogue') sawDrogue = true;
  if (j.ch === 'main') sawMain = true;
  if (j.st === 'SPLASHDOWN' || j.st === 'CRASHED') break;
  await wait(1200);
}
const dtScene = (Date.now() - t0) / 1000;
console.log('== 2) esito fisico ==');
const st = await ev('__sim.status');
chk('ammaraggio (non crash)', st === 'SPLASHDOWN', 'stato ' + st + ' dopo ' + dtScene.toFixed(0) + ' s reali');
chk('cinematica attiva durante il rientro', sawCine);
chk('plasma visto (qHeat)', sawPlasma, 'picco ' + (qPeak / 1000).toFixed(0) + ' kW/m²');
chk('blackout di plasma', blackout);
chk('droga vista', sawDrogue);
chk('principali visti', sawMain);
chk('sprite capsula caricato', await ev('document.getElementById("cine-capsule").naturalWidth > 0'));
chk('scena <= 240 s reali', dtScene <= 240, dtScene.toFixed(0) + ' s');

console.log('== 3) recupero in mare (beat a tempo reale) ==');
const seen = [];
for (let i = 0; i < 55; i++) {
  const d = await ev('document.getElementById("dir-text").textContent');
  if (d && !seen.includes(d)) seen.push(d);
  if (seen.some(x => /portello aperto/i.test(x))) break;
  await wait(1000);
}
chk('beat nave di recupero', seen.some(x => /nave di recupero/i.test(x)));
chk('beat elicottero', seen.some(x => /elicottero/i.test(x)));
chk('beat portello aperto', seen.some(x => /portello aperto/i.test(x)));
chk('nave in scena', await ev('document.getElementById("cine-ship").style.display !== "none"'));
chk('elicottero in scena', await ev('document.getElementById("cine-heli").style.display !== "none"'));
for (let i = 0; i < 40 && (await ev('__cockpit.cine.ret ? __cockpit.cine.ret.beat : -9')) < 3; i++) await wait(1000);
chk('scheda missione disegnata', (await ev('__cockpit.cine.ret ? __cockpit.cine.ret.beat : -9')) >= 3);

console.log('== 4) radio e salute pagina ==');
chk('voce browser mai attivata', await ev('speechSynthesis.speaking === false && speechSynthesis.pending === false'));
chk('copione agganciato alle narrazioni', /baked|tones/.test(await ev('__audio.lastSource')) && (await ev('__audio.lastId')) !== '', 'sorgente ' + await ev('__audio.lastSource') + ' id ' + await ev('__audio.lastId'));
chk('HUD flusso termico', hudQ !== '—', hudQ);
chk('HUD paracadute', /PRINCIPALI|DROGA/.test(await ev('document.getElementById("chute").textContent') || ''), await ev('document.getElementById("chute").textContent'));
console.log('  righe director viste: ' + seen.length);
chk('zero errori di pagina', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(fail === 0 ? '\nSPLASH OK' : '\nSPLASH FAIL (' + fail + ')');
chrome.kill(); process.exit(fail === 0 ? 0 : 1);
