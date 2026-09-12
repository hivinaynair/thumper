#!/usr/bin/env bash
# Watch m4 only. Ground truth = files on disk, not a state variable.
D="/Users/vinay/code/thumper/scripts/stem-bench/out/longstoryshort - ONE TIME 2 THE BEAT/m4"
phase=""; ticks=0
while true; do
  ticks=$((ticks+1))
  n=$(ls "$D"/*.flac 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" -ge 2 ]; then
    echo "[$(date '+%H:%M')] m4 DONE — $(tr '\r' '\n' < "$D/log.txt" | grep -oE 'Separation duration: [0-9:]+' | tail -1)"
    for f in "$D"/*.flac; do
      echo "   $(basename "$f" | sed -E 's/.*_\((Instrumental|Vocals)\)_.*/\1/'): $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")s"
    done
    exit 0
  fi
  if grep -qiE "traceback|no space|killed|out of memory|assertionerror" "$D/log.txt" 2>/dev/null; then
    echo "[$(date '+%H:%M')] m4 ERROR: $(grep -iE 'traceback|no space|killed|out of memory|assertionerror' "$D/log.txt" | tail -1 | cut -c1-160)"
    exit 1
  fi
  if ! pgrep -f "[a]udio-separator" >/dev/null && ! pgrep -f "[q]ueue2.sh" >/dev/null; then
    echo "[$(date '+%H:%M')] FATAL: m4 has $n stems but no separator and no queue driver running"
    exit 1
  fi
  L=$(tr '\r' '\n' < "$D/log.txt" 2>/dev/null | tail -1)
  case "$L" in *"it/s"*|*"s/it"*) p=separating ;; *iB/s*) p=downloading ;; *) p="$phase" ;; esac
  [ -n "$p" ] && [ "$p" != "$phase" ] && { echo "[$(date '+%H:%M')] m4 -> $p"; phase="$p"; }
  free=$(df -g "$D" 2>/dev/null | tail -1 | awk '{print $4}')
  [ -n "$free" ] && [ "$free" -lt 5 ] && { echo "[$(date '+%H:%M')] FATAL: ${free}GB disk left"; exit 1; }
  [ $((ticks % 24)) -eq 0 ] && echo "[$(date '+%H:%M')] heartbeat: m4 $phase $(tr '\r' '\n' < "$D/log.txt" 2>/dev/null | tail -1 | grep -oE '[0-9]+%|[0-9]+/[0-9]+' | head -1) disk=${free}GB"
  sleep 30
done
