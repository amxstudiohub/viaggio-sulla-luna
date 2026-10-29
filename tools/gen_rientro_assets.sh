#!/usr/bin/env bash
# Asset della missione di ritorno: still Qwen Image 2.1 (DGX) + keying alpha + pesi finali.
# Uso: bash tools/gen_rientro_assets.sh [solo-nome...]   (nessun nome = tutti)
set -e
cd "$(dirname "$0")/.."
G() { node tools/comfy_gen.mjs "$@" qwen; }
GREEN="isolated on a flat uniform bright green chroma key background, no shadow on the background, no text, no logo, no watermark, photorealistic, sharp focus"
WANT="$*"
run() { local n="$1"; shift; if [ -z "$WANT" ] || [[ " $WANT " == *" $n "* ]]; then echo "== $n"; G "$n" "$@"; fi; }

run capsule_plasma 1024 1024 30 "photorealistic render of a conical crew return capsule, white body with a dark bronze ablative heat shield glowing bright orange, wrapped in a pink and gold plasma sheath with trailing sparks, three-quarter view, $GREEN"
run capsule_drogue 1024 1024 30 "photorealistic render of a conical white space capsule hanging from a single small orange and white striped drogue parachute on long suspension lines, viewed slightly from below, $GREEN"
run capsule_mains 1024 1024 30 "photorealistic render of a conical white space capsule hanging under four large white and orange striped main parachutes on long suspension lines, viewed from a distance, $GREEN"
run ship_recovery 1024 1024 30 "photorealistic side view of a modern ocean recovery vessel, grey hull, flat open stern deck, helicopter pad, white superstructure with cranes, hull only without water, $GREEN"
run heli_recovery 1024 1024 30 "photorealistic three quarter view of a medium twin engine transport helicopter with rotor blades in motion blur, skid landing gear, hovering slightly nose down, $GREEN"
run ocean_plate 1216 832 30 "cinematic wide photograph of a calm deep blue ocean with small swells at golden hour, low horizon line, soft sea haze, empty gradient sky, no text, no people, no boats"
run reentry_plate 1216 832 30 "cinematic view from orbit during atmospheric re-entry, the curved limb of the Earth glowing orange below a thin blue atmosphere band, black space with faint stars above, streaks of plasma and motion blur, no text"

# sprite: verde -> alpha, ridotti a 640 px, poi l'originale verde si butta
for n in capsule_plasma capsule_drogue capsule_mains ship_recovery heli_recovery; do
  [ -f "assets/img/$n.png" ] || continue
  node tools/make_key.mjs "assets/img/$n.png" "assets/img/${n}_key.png"
  ffmpeg -y -loglevel error -i "assets/img/${n}_key.png" -vf "scale=640:640:flags=lanczos" -pix_fmt rgba /tmp/k.png && mv /tmp/k.png "assets/img/${n}_key.png"
  rm -f "assets/img/$n.png"
done
# placche a tutto schermo: JPEG (pesano 1/10 del PNG)
for p in ocean_plate reentry_plate; do
  [ -f "assets/img/$p.png" ] || continue
  ffmpeg -y -loglevel error -i "assets/img/$p.png" -q:v 4 "assets/img/$p.jpg" && rm -f "assets/img/$p.png"
done
echo FATTO
