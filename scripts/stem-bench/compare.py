#!/usr/bin/env python3
"""Build a blind A/B listening page from out/<track>/m*/.

  .venv/bin/python compare.py "<track name>"   # or omit to pick the only one
"""
import json, random, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"


def pick_track(arg):
    tracks = sorted(p for p in OUT.iterdir() if p.is_dir()) if OUT.exists() else []
    if not tracks:
        sys.exit("no output yet — run ./run.sh first")
    if arg:
        m = [t for t in tracks if arg.lower() in t.name.lower()]
        if not m:
            sys.exit(f"no track matching {arg!r}; have: {[t.name for t in tracks]}")
        return m[0]
    if len(tracks) > 1:
        sys.exit(f"pick one: {[t.name for t in tracks]}")
    return tracks[0]


def classify(name):
    n = name.lower()
    if "instrumental" in n or "no_vocals" in n or "(instrumental)" in n:
        return "instrumental"
    if "vocal" in n:
        return "vocals"
    return "other"


def main():
    track = pick_track(sys.argv[1] if len(sys.argv) > 1 else None)
    entries = []
    for tag_dir in sorted(track.glob("m*")):
        model_f = tag_dir / "MODEL.txt"
        stems = {}
        for f in tag_dir.glob("*.flac"):
            stems.setdefault(classify(f.name), []).append(f.name)
        if not stems:
            continue
        entries.append({
            "tag": tag_dir.name,
            "model": model_f.read_text().strip() if model_f.exists() else "?",
            "dir": tag_dir.name,
            "stems": {k: sorted(v) for k, v in stems.items()},
        })

    if not entries:
        sys.exit("no stems found — run may still be going or every model failed")

    # stable shuffle per track so reloads don't change the blind order
    rnd = random.Random(track.name)
    order = entries[:]
    rnd.shuffle(order)
    for i, e in enumerate(order):
        e["label"] = chr(ord("A") + i)

    html = TEMPLATE.replace("__TRACK__", json.dumps(track.name)).replace(
        "__DATA__", json.dumps(order, indent=2)
    )
    dest = track / "compare.html"
    dest.write_text(html)
    print(f"wrote {dest}")
    print(f"models included: {len(order)}")
    for e in order:
        print(f"  {e['label']}  <- {e['tag']}  ({', '.join(e['stems'])})")


TEMPLATE = r"""<!doctype html>
<meta charset="utf-8"><title>blind stem compare</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:900px}
 h1{font-size:18px;margin:0 0 4px} .sub{opacity:.6;margin-bottom:20px}
 .card{border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:10px;padding:14px 16px;margin-bottom:14px}
 .lab{font-size:22px;font-weight:700;margin-bottom:10px}
 .row{display:flex;align-items:center;gap:10px;margin:6px 0;flex-wrap:wrap}
 .row b{width:96px;font-weight:600;opacity:.75;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
 audio{flex:1;min-width:260px;height:34px}
 .score{display:flex;gap:16px;margin-top:12px;flex-wrap:wrap;align-items:center}
 .score label{font-size:12px;opacity:.8}
 select,textarea{font:inherit;padding:3px 6px;border-radius:6px}
 textarea{width:100%;min-height:44px;margin-top:8px}
 button{font:inherit;padding:8px 14px;border-radius:8px;cursor:pointer;margin-right:8px}
 .reveal{margin-top:8px;padding:12px 16px;border-radius:10px;
   background:color-mix(in srgb,currentColor 8%,transparent)}
 .hidden{display:none}
 code{font-family:ui-monospace,monospace;font-size:12px}
</style>
<h1>Blind stem comparison</h1>
<div class="sub">__TRACK__ — model identities hidden. Score before revealing.</div>
<div id="cards"></div>
<button id="revealBtn">Reveal models</button>
<button id="copyBtn">Copy scores</button>
<div id="reveal" class="reveal hidden"></div>
<script>
const DATA = __DATA__;
const enc = s => s.split('/').map(encodeURIComponent).join('/');
const cards = document.getElementById('cards');
const sel = (name, tip) => `<label>${tip} <select data-k="${name}">
  <option value="">–</option>${[1,2,3,4,5].map(n=>`<option>${n}</option>`).join('')}</select></label>`;

cards.innerHTML = DATA.map(e => {
  const rows = ['instrumental','vocals','other'].flatMap(kind =>
    (e.stems[kind]||[]).map(f =>
      `<div class="row"><b>${kind}</b><audio controls preload="none" src="${enc(e.dir)}/${enc(f)}"></audio></div>`)
  ).join('');
  return `<div class="card" data-label="${e.label}">
    <div class="lab">${e.label}</div>${rows}
    <div class="score">
      ${sel('bleedless','Bleedless (no vocal left in instrumental)')}
      ${sel('fullness','Fullness (instrumental not hollowed)')}
    </div>
    <textarea placeholder="notes — artifacts, chops, reverb tails…"></textarea>
  </div>`;
}).join('');

document.getElementById('revealBtn').onclick = () => {
  const d = document.getElementById('reveal');
  d.classList.remove('hidden');
  d.innerHTML = '<b>Mapping</b><br>' +
    DATA.map(e=>`${e.label} → <code>${e.model}</code>`).join('<br>');
};
document.getElementById('copyBtn').onclick = () => {
  const out = [...document.querySelectorAll('.card')].map(c => {
    const g = k => c.querySelector(`[data-k="${k}"]`).value || '-';
    return `${c.dataset.label}: bleedless=${g('bleedless')} fullness=${g('fullness')} ` +
           `notes=${JSON.stringify(c.querySelector('textarea').value)}`;
  }).join('\n');
  navigator.clipboard.writeText(out);
  document.getElementById('copyBtn').textContent = 'Copied';
};
</script>
"""

if __name__ == "__main__":
    main()
