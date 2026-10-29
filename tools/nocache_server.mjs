/**
 * Server static locale SENZA cache: python -m http.server non invia Cache-Control
 * e Chrome serve JS vecchi dalla cache disco (falso verde nei test CDP).
 * Uso: node tools/nocache_server.mjs [porta]   (default 8137)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const PORT = +(process.argv[2] || 8137);
const ROOT = process.cwd();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
    res.writeHead(404); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store, must-revalidate', 'Content-Length': fs.statSync(f).size });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('nocache server su :' + PORT));
