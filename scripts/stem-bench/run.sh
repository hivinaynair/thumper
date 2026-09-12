#!/usr/bin/env bash
# Run N separation models over one track, timing each.
#   ./run.sh "/path/to/track.m4a"
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv/bin/audio-separator"
MODEL_DIR="$HERE/models"
IN="${1:?usage: ./run.sh <audio-file>}"
[ -f "$IN" ] || { echo "no such file: $IN" >&2; exit 1; }

BASE="$(basename "${IN%.*}")"
OUT="$HERE/out/$BASE"
mkdir -p "$OUT" "$MODEL_DIR"

MODELS=(
  "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
  "melband_roformer_instvox_duality_v2.ckpt"
  "melband_roformer_inst_v2.ckpt"
  "MDX23C-8KFFT-InstVoc_HQ_2.ckpt"
  "htdemucs_ft.yaml"
)

echo "track : $BASE"
echo "out   : $OUT"
echo

for i in "${!MODELS[@]}"; do
  m="${MODELS[$i]}"
  tag="m$((i+1))"
  echo "── [$tag] $m"
  mkdir -p "$OUT/$tag"
  start=$(date +%s)
  "$PY" "$IN" \
    --model_filename "$m" \
    --model_file_dir "$MODEL_DIR" \
    --output_dir "$OUT/$tag" \
    --output_format FLAC \
    >"$OUT/$tag/log.txt" 2>&1
  rc=$?
  el=$(( $(date +%s) - start ))
  if [ $rc -eq 0 ]; then
    echo "   ok  ${el}s  ->  $(ls "$OUT/$tag" | grep -c '\.flac$') stems"
  else
    echo "   FAIL (rc=$rc, ${el}s) — see $OUT/$tag/log.txt"
    tail -3 "$OUT/$tag/log.txt" | sed 's/^/     /'
  fi
  echo "$m" > "$OUT/$tag/MODEL.txt"
done

echo
echo "done. blind-listen: model names are in each <tag>/MODEL.txt — don't peek."
