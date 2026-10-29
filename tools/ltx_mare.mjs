/**
 * ltx_mare.mjs — video plate di mare image-to-video via ComfyUI remoto (DGX Spark).
 *
 * Zero dipendenze: usa solo fetch / FormData / Blob nativi di Node >= 18.
 * Mette in coda il workflow LTX-2.3, fa polling (timeout generoso) e scarica
 * il risultato in assets/video/mare_raw.mp4.
 *
 * Uso:
 *   node tools/ltx_mare.mjs [opzioni]
 *     --image   assets/img/ocean_plate.jpg   frame iniziale (caricato su ComfyUI)
 *     --out     assets/video/mare_raw.mp4    file scaricato
 *     --width   896   --height 512           multipli di 32
 *     --frames  193   --fps    24            frames = 8n+1  (193/24 = 8.04 s)
 *     --steps   8                            (preset distilled: 8 | 4 | 2)
 *     --seed    2030  --cfg 1.0
 *     --model   ltx-2.3-22b-distilled-fp8.safetensors
 *     --host    192.168.0.169:8188           (o env COMFY_HOST)
 *     --timeout 1500                         secondi di polling
 *     --audio-branch                         aggiungi il ramo audio LTXV (fallback)
 *     --smoke                                render minuscolo per validare il grafo
 *     --dry-run                              stampa il grafo e basta
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return dflt;
  const nxt = argv[i + 1];
  if (nxt === undefined || nxt.startsWith('--')) return true;
  return nxt;
}
const flag = (n) => opt(n, false) === true;

const SIGMA_PRESETS = {
  8: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0',
  4: '1.0, 0.7250, 0.4219, 0.0',
  2: '1.0, 0.5, 0.0',
};

const HOST = opt('host', process.env.COMFY_HOST || '192.168.0.169:8188').replace(/^https?:\/\//, '').replace(/\/$/, '');
const smoke = flag('smoke');
const steps = +(opt('steps', smoke ? 2 : 8));

const O = {
  image: opt('image', 'assets/img/ocean_plate.jpg'),
  out: opt('out', 'assets/video/mare_raw.mp4'),
  width: +(opt('width', smoke ? 256 : 896)),
  height: +(opt('height', smoke ? 256 : 512)),
  frames: +(opt('frames', smoke ? 9 : 193)),
  fps: +(opt('fps', 24)),
  seed: +(opt('seed', 2030)),
  cfg: +(opt('cfg', 1.0)),
  steps,
  sigmas: opt('sigmas', SIGMA_PRESETS[steps] || SIGMA_PRESETS[8]),
  model: opt('model', 'ltx-2.3-22b-distilled-fp8.safetensors'),
  textEncoder: opt('text-encoder', 'gemma_3_12B_it_fp4_mixed.safetensors'),
  sampler: opt('sampler', 'euler_ancestral_cfg_pp'),
  prefix: opt('prefix', 'cislunar/mare'),
  timeout: +(opt('timeout', 1500)),
  audioBranch: flag('audio-branch'),
  remoteName: opt('remote-name', 'cislunar_mare_plate.jpg'),
  prompt: opt('prompt',
    'Slow gentle ocean swells rolling forward toward the low horizon. The water surface shimmers with soft sun glitter, ' +
    'small ripples drift and dissolve, thin morning haze hangs over the sea, pastel dawn sky in pale teal and warm gold. ' +
    'Completely static locked camera, no camera movement, no zoom, no pan. Calm cinematic seascape, seamless loop, ' +
    'photorealistic, soft natural light, subtle continuous motion only.'),
  negative: opt('negative',
    'camera movement, zoom, pan, tilt, dolly, handheld shake, people, boat, ship, birds, text, watermark, logo, subtitles, ' +
    'morphing, warping, distortion, flicker, cartoon, CGI look, low quality, oversaturated, storm, huge breaking waves, splash'),
};

const BASE = 'http://' + HOST;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------------------------------------------------------- graph -- */
function buildGraph() {
  const g = {
    ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: O.model } },
    text: { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: O.textEncoder, ckpt_name: O.model, device: 'cpu' } },
    pos: { class_type: 'CLIPTextEncode', inputs: { text: O.prompt, clip: ['text', 0] } },
    neg: { class_type: 'CLIPTextEncode', inputs: { text: O.negative, clip: ['text', 0] } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: O.fps } },
    img: { class_type: 'LoadImage', inputs: { image: O.remoteName } },
    rs: { class_type: 'ResizeImageMaskNode', inputs: {
      input: ['img', 0], resize_type: 'scale dimensions', scale_method: 'lanczos',
      'resize_type.width': O.width, 'resize_type.height': O.height, 'resize_type.crop': 'center' } },
    pre: { class_type: 'LTXVPreprocess', inputs: { image: ['rs', 0], img_compression: 18 } },
    lat: { class_type: 'EmptyLTXVLatentVideo', inputs: { width: O.width, height: O.height, length: O.frames, batch_size: 1 } },
    i2v: { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['ckpt', 2], image: ['pre', 0], latent: ['lat', 0], strength: 1.0, bypass: false } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: O.seed } },
    ksel: { class_type: 'KSamplerSelect', inputs: { sampler_name: O.sampler } },
    sig: { class_type: 'ManualSigmas', inputs: { sigmas: O.sigmas } },
    guide: { class_type: 'CFGGuider', inputs: { model: ['ckpt', 0], positive: ['cond', 0], negative: ['cond', 1], cfg: O.cfg } },
  };

  let samples;
  if (O.audioBranch) {
    // LTX-2.3 e' un modello audio+video: se il ramo video-only non viene accettato
    // si campiona il latente AV congiunto e si scarta l'audio in uscita.
    g.avae = { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: O.model } };
    g.alat = { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: O.frames, frame_rate: O.fps, batch_size: 1, audio_vae: ['avae', 0] } };
    g.cat = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['i2v', 0], audio_latent: ['alat', 0] } };
    g.samp = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guide', 0], sampler: ['ksel', 0], sigmas: ['sig', 0], latent_image: ['cat', 0] } };
    g.sep = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['samp', 0] } };
    samples = ['sep', 0];
  } else {
    g.samp = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guide', 0], sampler: ['ksel', 0], sigmas: ['sig', 0], latent_image: ['i2v', 0] } };
    samples = ['samp', 0];
  }

  g.dec = { class_type: 'VAEDecodeTiled', inputs: { samples, vae: ['ckpt', 2], tile_size: 1024, overlap: 64, temporal_size: 4096, temporal_overlap: 4 } };
  g.vid = { class_type: 'CreateVideo', inputs: { images: ['dec', 0], fps: O.fps } };
  g.save = { class_type: 'SaveVideo', inputs: { video: ['vid', 0], filename_prefix: O.prefix, format: 'auto', codec: 'auto' } };
  return g;
}

/* --------------------------------------------------------------- http -- */
async function upload() {
  const buf = fs.readFileSync(O.image);
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: 'image/jpeg' }), O.remoteName);
  fd.append('overwrite', 'true');
  const r = await fetch(BASE + '/upload/image', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('upload fallito ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  log('upload ok ->', JSON.stringify(j));
  return j;
}

async function queue(graph) {
  const r = await fetch(BASE + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }) });
  const j = await r.json().catch(() => ({}));
  if (!j.prompt_id) {
    const detail = j.node_errors ? JSON.stringify(j.node_errors).slice(0, 1500) : JSON.stringify(j).slice(0, 1500);
    throw new Error('workflow rifiutato (' + r.status + '): ' + detail);
  }
  if (j.error) log('warning dal server:', JSON.stringify(j.error).slice(0, 400));
  log('queued prompt_id =', j.prompt_id);
  return j.prompt_id;
}

function findFile(outputs) {
  if (!outputs) return null;
  for (const o of Object.values(outputs)) {
    for (const key of ['videos', 'gifs', 'images', 'audio']) {
      const arr = o && o[key];
      if (Array.isArray(arr) && arr.length && arr[0].filename) {
        const f = arr.find((x) => /\.(mp4|webm|mkv)$/i.test(x.filename)) || arr[0];
        return { filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' };
      }
    }
  }
  return null;
}

async function poll(promptId) {
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < O.timeout * 1000) {
    await new Promise((r) => setTimeout(r, 5000));
    let hist;
    try {
      hist = await (await fetch(BASE + '/history/' + promptId)).json();
    } catch (e) { log('poll network:', e.message); continue; }
    const rec = hist[promptId];
    if (rec) {
      const st = rec.status && rec.status.status_str;
      if (st === 'error') {
        const msgs = (rec.status.messages || []).map((m) => JSON.stringify(m)).join(' | ');
        const nodes = (rec.nodes || {});
        const errs = Object.entries(nodes).filter(([, v]) => v.status && v.status.status_str === 'error')
          .map(([k, v]) => k + '(' + (v.class_type || '') + '): ' + JSON.stringify(v.inputs || {}).slice(0, 200)).join(' | ');
        throw new Error('ERRORE SERVER -> ' + msgs + ' || ' + errs + ' || ' + JSON.stringify(rec).slice(0, 800));
      }
      const file = findFile(rec.outputs);
      if (file) return file;
    }
    if (Date.now() - lastLog > 30000) {
      lastLog = Date.now();
      let q = '';
      try {
        const qq = await (await fetch(BASE + '/queue')).json();
        q = ' running=' + (qq.queue_running || []).length + ' pending=' + (qq.queue_pending || []).length;
      } catch { /* ignora */ }
      log('in attesa... ' + Math.round((Date.now() - t0) / 1000) + 's' + q);
    }
  }
  throw new Error('timeout dopo ' + O.timeout + 's');
}

async function download(file) {
  const url = BASE + '/view?filename=' + encodeURIComponent(file.filename) + '&subfolder=' + encodeURIComponent(file.subfolder) + '&type=' + encodeURIComponent(file.type);
  const r = await fetch(url);
  if (!r.ok) throw new Error('download ' + r.status + ' ' + url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(O.out), { recursive: true });
  fs.writeFileSync(O.out, buf);
  log('scaricato', url);
  return { bytes: buf.length, url };
}

/* ---------------------------------------------------------------- main -- */
const graph = buildGraph();
log('host=' + HOST + '  ' + O.width + 'x' + O.height + '  frames=' + O.frames + '  fps=' + O.fps + '  steps=' + O.steps + '  audio-branch=' + O.audioBranch);
if (flag('dry-run')) { console.log(JSON.stringify(graph, null, 2)); process.exit(0); }

try {
  await upload();
  const pid = await queue(graph);
  const file = await poll(pid);
  const { bytes } = await download(file);
  console.log('OK  ' + O.out + '  ' + (bytes / 1024).toFixed(0) + ' KB  (server: ' + (file.subfolder ? file.subfolder + '/' : '') + file.filename + ')');
} catch (e) {
  console.error('FALLITO: ' + e.message);
  process.exit(1);
}
