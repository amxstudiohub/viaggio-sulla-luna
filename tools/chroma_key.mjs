/**
 * Chroma-key PNG (green screen -> alpha), zero dipendenze: decode/encode PNG via zlib.
 * Uso: node tools/chroma_key.mjs input.png output.png [soglia]
 */
import fs from 'fs';
import zlib from 'zlib';

const [inp, outp, thrArg] = process.argv.slice(2);
if (!inp || !outp) { console.error('uso: chroma_key.mjs in.png out.png [soglia]'); process.exit(2); }
const THR = thrArg ? +thrArg : 70;

// ---------- decode PNG ----------
const buf = fs.readFileSync(inp);
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('non è PNG');
let pos = 8, w = 0, h = 0, depth = 0, ctype = 0;
const idat = [];
let palette = null, trns = null;
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
  else if (type === 'PLTE') palette = data;
  else if (type === 'tRNS') trns = data;
  else if (type === 'IDAT') idat.push(data);
  pos += 12 + len;
}
if (depth !== 8) throw new Error('bit depth ' + depth + ' non supportato');
const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 0 ? 1 : ctype === 4 ? 2 : (() => { throw new Error('ctype ' + ctype); })();
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = w * ch;
const px = Buffer.alloc(h * stride);
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
let rp = 0;
for (let y = 0; y < h; y++) {
  const ft = raw[rp++];
  for (let x = 0; x < stride; x++) {
    const v = raw[rp++];
    const a = x >= ch ? px[y * stride + x - ch] : 0;
    const b = y > 0 ? px[(y - 1) * stride + x] : 0;
    const c = x >= ch && y > 0 ? px[(y - 1) * stride + x - ch] : 0;
    let val;
    if (ft === 0) val = v;
    else if (ft === 1) val = v + a;
    else if (ft === 2) val = v + b;
    else if (ft === 3) val = v + ((a + b) >> 1);
    else val = v + paeth(a, b, c);
    px[y * stride + x] = val & 0xff;
  }
}
// RGBA working buffer
const rgba = Buffer.alloc(w * h * 4);
for (let i = 0; i < w * h; i++) {
  const s = i * ch;
  let r, g, b, a = 255;
  if (ch === 3 || ch === 4) { r = px[s]; g = px[s + 1]; b = px[s + 2]; if (ch === 4) a = px[s + 3]; }
  else if (ch === 1 || ch === 2) { r = g = b = px[s]; if (ch === 2) a = px[s + 1]; }
  if (palette) { const p = r * 3; r = palette[p]; g = palette[p + 1]; b = palette[p + 2]; if (trns && r === trns[0] && g === trns[1] && b === trns[2]) a = 0; }
  rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
}

// ---------- chroma key: verde -> alpha ----------
for (let i = 0; i < w * h; i++) {
  const o = i * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
  const dom = g - Math.max(r, b);
  if (dom > THR && g > 90) rgba[o + 3] = 0;
  else if (dom > THR * 0.4 && g > 70) {
    rgba[o + 3] = Math.max(0, 255 - Math.round((dom - THR * 0.4) / (THR * 0.6) * 255));
    rgba[o + 1] = Math.min(r, b) + Math.round((g - Math.min(r, b)) * 0.25); // despill
  }
}

// ---------- encode PNG (RGBA, filter 0) ----------
const rawOut = Buffer.alloc(h * (stride + 1));
for (let y = 0; y < h; y++) {
  rawOut[y * (stride + 1)] = 0;
  rgba.copy(rawOut, y * (stride + 1) + 1, y * stride, y * stride + stride);
}
const crcTable = [];
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(rawOut, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(outp, png);
let transparent = 0;
for (let i = 3; i < png.length; i++) { /* noop */ }
console.log('OK', inp, '->', outp, (png.length / 1024).toFixed(0) + ' KB', w + 'x' + h);
