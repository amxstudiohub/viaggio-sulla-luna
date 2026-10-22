// server_node.cjs — mini server statico di riserva (usato solo se non c'è Python)
const http = require('http'), fs = require('fs'), path = require('path');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.cjs': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.wav': 'audio/wav', '.wasm': 'application/wasm' };
const port = 8137;
http.createServer((q, s) => {
  let f = path.join(process.cwd(), decodeURIComponent(q.url.split('?')[0]));
  if (f.endsWith(path.sep)) f += 'index.html';
  fs.readFile(f, (e, d) => {
    if (e) { s.writeHead(404); s.end('404'); return; }
    s.writeHead(200, { 'Content-Type': mime[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    s.end(d);
  });
}).listen(port, () => console.log('Cislunar 2030 → http://localhost:' + port));
