import fs from 'fs';
import { spawn } from 'child_process';
const PORT = 9390;
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--user-data-dir=/tmp/chrome-prof-moon7', '--remote-debugging-port=' + PORT,
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
await cmd('Network.enable'); await cmd('Page.reload', { ignoreCache: true }); await wait(3500);
await ev('__jump(2); "j"');
await wait(1500);
await ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" })), "cam"');
await ev('__cockpit.zoomBy(-600); __cockpit.zoomBy(-600); __cockpit.zoomBy(-600); "z"');
await wait(400);
const rA = await cmd('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shots/ui_19_luna.png', Buffer.from(rA.result.data, 'base64'));
await ev('__cockpit.zoomBy(-600); __cockpit.zoomBy(-600); __cockpit.zoomBy(-600); "z2"');
await wait(600);
const r2 = await cmd('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shots/ui_19b_luna_zoom.png', Buffer.from(r2.result.data, 'base64'));
console.log('shot ok');
chrome.kill(); process.exit(0);