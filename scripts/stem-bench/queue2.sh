#!/usr/bin/env bash
cd "$(dirname "${BASH_SOURCE[0]}")"
IN="/Users/vinay/Downloads/longstoryshort - ONE TIME 2 THE BEAT.flac"
BASE="out/longstoryshort - ONE TIME 2 THE BEAT"
while pgrep -f "[a]udio-separator" >/dev/null; do sleep 20; done
tag=m4; model="MDX23C-8KFFT-InstVoc_HQ_2.ckpt"
mkdir -p "$BASE/$tag"; echo "$model" > "$BASE/$tag/MODEL.txt"
echo "[$(date '+%H:%M:%S')] starting $tag $model"
.venv/bin/audio-separator "$IN" --model_filename "$model" \
  --model_file_dir "$(pwd)/models" --output_dir "$BASE/$tag" \
  --output_format FLAC > "$BASE/$tag/log.txt" 2>&1
echo "[$(date '+%H:%M:%S')] $tag done -> $(ls "$BASE/$tag"/*.flac 2>/dev/null | wc -l | tr -d ' ') stems"
