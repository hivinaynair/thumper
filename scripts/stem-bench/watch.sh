#!/usr/bin/env bash
# Emit one line per meaningful state change / problem. Exit when m2+m4 are done or fatal.
BASE="/Users/vinay/code/thumper/scripts/stem-bench/out/longstoryshort - ONE TIME 2 THE BEAT"
declare -A last
ticks=0

state_of() {
  local d="$BASE/$1"
  [ -d "$d" ] || { echo "pending"; return; }
  local n; n=$(ls "$d"/*.flac 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -ge 2 ] && { echo "done"; return; }
  [ -f "$d/log.txt" ] || { echo "pending"; return; }
  local L; L=$(tr '\r' '\n' < "$d/log.txt" | tail -1)
  if grep -qiE "traceback|error|no space|killed|out of memory|cuda|assertion" "$d/log.txt" 2>/dev/null; then
    echo "ERROR"; return
  fi
  case "$L" in
    *"it/s"*|*"s/it"*) echo "separating" ;;
    *iB/s*)            echo "downloading" ;;
    *)                 echo "starting" ;;
  esac
}

while true; do
  ticks=$((ticks+1))
  alive=$(pgrep -f "[a]udio-separator" >/dev/null && echo yes || echo no)
  free=$(df -g "$BASE" 2>/dev/null | tail -1 | awk '{print $4}')

  for t in m2 m4; do
    s=$(state_of "$t")
    # an unknown/partial read must never clobber the last known state
    if [ "$s" = "starting" ] || [ "$s" = "pending" ]; then
      [ -n "${last[$t]:-}" ] && continue
    fi
    if [ "${last[$t]:-}" != "$s" ]; then
      case "$s" in
        done)  echo "[$(date '+%H:%M')] $t DONE — $(tr '\r' '\n' < "$BASE/$t/log.txt" | grep -oE 'Separation duration: [0-9:]+' | tail -1)" ;;
        ERROR) echo "[$(date '+%H:%M')] $t ERROR: $(grep -iE 'traceback|error|no space|killed|out of memory' "$BASE/$t/log.txt" | tail -1 | cut -c1-160)" ;;
        *)     [[ "$s" == separating* || "$s" == downloading* ]] && echo "[$(date '+%H:%M')] $t -> $s" ;;
      esac
      last[$t]="$s"
    fi
  done

  m2s="${last[m2]:-pending}"; m4s="${last[m4]:-pending}"

  # fatal: nothing running, queue driver gone, and work unfinished
  if [ "$alive" = no ] && ! pgrep -f "[q]ueue2.sh" >/dev/null; then
    if [ "$m2s" != done ] || [ "$m4s" != done ]; then
      echo "[$(date '+%H:%M')] FATAL: no separator and no queue driver, but m2=$m2s m4=$m4s"
      exit 1
    fi
  fi

  [ -n "$free" ] && [ "$free" -lt 5 ] && { echo "[$(date '+%H:%M')] FATAL: only ${free}GB disk left"; exit 1; }

  if [ "$m2s" = done ] && [ "$m4s" = done ]; then
    echo "[$(date '+%H:%M')] ALL DONE — m2 and m4 complete, ${free}GB disk free"
    exit 0
  fi

  # heartbeat every ~12 min so silence is never ambiguous
  if [ $((ticks % 24)) -eq 0 ]; then
    d2=$(tr '\r' '\n' < "$BASE/m2/log.txt" 2>/dev/null | tail -1 | grep -oE '[0-9]+%|[0-9]+/[0-9]+' | head -1)
    d4=$(tr '\r' '\n' < "$BASE/m4/log.txt" 2>/dev/null | tail -1 | grep -oE '[0-9]+%|[0-9]+/[0-9]+' | head -1)
    echo "[$(date '+%H:%M')] heartbeat: m2=$m2s${d2:+ $d2} m4=$m4s${d4:+ $d4} proc=$alive disk=${free}GB"
  fi
  sleep 30
done
