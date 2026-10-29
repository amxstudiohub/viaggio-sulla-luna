/**
 * Sfondo verde -> alpha (PNG RGBA). Uso: node tools/make_key.mjs in.png out.png [0x00ff00]
 * Richiede ffmpeg. Il verde e' il chroma chiesto nei prompt di comfy_gen.mjs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const [src, dst, col = '0x00ff00'] = process.argv.slice(2);
if (!src || !dst) { console.error('uso: make_key.mjs in.png out.png [0x00ff00]'); process.exit(2); }
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
  '-vf', 'colorkey=' + col + ':0.32:0.14,despill=type=green:mix=0.7:expand=0,format=rgba', dst]);
console.log('KEY', dst, (fs.statSync(dst).size / 1024).toFixed(0) + ' KB');
