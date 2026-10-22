/**
 * Generatore asset via ComfyUI remoto (DGX Spark).
 * Uso: node tools/comfy_gen.mjs <nome> <width> <height> <steps> "<prompt>" [flux|qwen]
 * flux = flux1-dev-fp8 (cfg 1.0) | qwen = Qwen Image 2.1 int8 (cfg 4.0)
 * Output: assets/img/<nome>.png — richiede ComfyUI API su http://192.168.0.169:8188
 */
import fs from 'fs';
const HOST = process.env.COMFY_HOST || '192.168.0.169:8188';
const [nome, w, h, steps, prompt, engine] = process.argv.slice(2);
if (!nome || !prompt) { console.error('uso: comfy_gen.mjs nome w h steps "prompt" [flux|qwen]'); process.exit(2); }
const seed = 20300000 + [...nome].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 9999;
const wfQwen = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
  4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
  5: { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark, logo, signature, blurry, low quality', clip: ['2', 0] } },
  6: { class_type: 'EmptySD3LatentImage', inputs: { width: +w, height: +h, batch_size: 1 } },
  7: { class_type: 'KSampler', inputs: { seed, steps: +steps, cfg: 4.0, sampler_name: 'euler', scheduler: 'normal', denoise: 1.0, model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'cislunar/' + nome, images: ['8', 0] } },
};
const wf = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev-fp8.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark, logo, signature, blurry, low quality', clip: ['1', 1] } },
  4: { class_type: 'EmptySD3LatentImage', inputs: { width: +w, height: +h, batch_size: 1 } },
  5: { class_type: 'KSampler', inputs: { seed: 20300120, steps: +steps, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  7: { class_type: 'SaveImage', inputs: { filename_prefix: 'cislunar/' + nome, images: ['6', 0] } },
};
const graph = engine === 'qwen' ? wfQwen : wf;
const post = (path, body) => fetch('http://' + HOST + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const res = await post('/prompt', { prompt: graph });
  if (!res.prompt_id) { console.error('RIFIUTATO:', JSON.stringify(res).slice(0, 500)); process.exit(1); }
  const { prompt_id } = res;
console.log('queued', prompt_id);
let out = null;
for (let i = 0; i < 600; i++) {
  await new Promise(r => setTimeout(r, 2000));
  const hist = await (await fetch('http://' + HOST + '/history/' + prompt_id)).json();
  const rec = hist[prompt_id];
  if (!rec) continue;
  if (rec.status && rec.status.status_str === 'error') { console.error('ERRORE:', JSON.stringify(rec).slice(0, 800)); process.exit(1); }
  const saved = rec.outputs && Object.values(rec.outputs).flatMap(o => o.images || []);
  if (saved && saved.length) { out = saved[0]; break; }
}
if (!out) { console.error('timeout'); process.exit(1); }
const img = await (await fetch('http://' + HOST + '/view?filename=' + encodeURIComponent(out.filename) + '&subfolder=' + encodeURIComponent(out.subfolder) + '&type=output')).arrayBuffer();
fs.mkdirSync('assets/img', { recursive: true });
const dest = 'assets/img/' + nome + '.png';
fs.writeFileSync(dest, Buffer.from(img));
console.log('SALVATO', dest, (img.byteLength / 1024).toFixed(0) + ' KB');