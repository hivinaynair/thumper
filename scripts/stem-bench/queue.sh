#!/usr/bin/env bash
# Wait for any running separator, then run the queued models.
cd "$(dirname "${BASH_SOURCE[0]}")"
IN="/Users/vinay/Downloads/longstoryshort - ONE TIME 2 THE BEAT.flac"
BASE="out/longstoryshort - ONE TIME 2 THE BEAT"
while pgrep -f "[a]udio-separator" >/dev/null; do sleep 20; done
run() {
  local tag="$1" model="$2"
  mkdir -p "$BASE/$tag"; echo "$model" > "$BASE/$tag/MODEL.txt"
  echo "[$(date '+%H:%M:%S')] $tag  $model"
  .venv/bin/audio-separator "$IN" --model_filename "$model" \
    --model_file_dir "$(pwd)/models" --output_dir "$BASE/$tag" \
    --output_format FLAC > "$BASE/$tag/log.txt" 2>&1
  echo "[$(date '+%H:%M:%S')] $tag done -> $(ls "$BASE/$tag"/*.flac 2>/dev/null | wc -l | tr -d ' ') stems"
}
run m7 "melband_roformer_instvox_duality_v2.ckpt"
run m8 "melband_roformer_inst_v2.ckpt"
echo "[$(date '+%H:%M:%S')] queue complete"
