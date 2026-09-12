#!/usr/bin/env python3
"""Compare separated stems against the original mix.

  .venv/bin/python analyze.py <original> <instrumental> <vocals>
"""
import sys
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


def load(p, target_sr=None):
    x, sr = sf.read(p, always_2d=True, dtype="float64")
    if target_sr and sr != target_sr:
        g = np.gcd(sr, target_sr)
        x = resample_poly(x, target_sr // g, sr // g, axis=0)
        sr = target_sr
    return x, sr


def db(x):
    r = float(np.sqrt(np.mean(x**2)))
    return 20 * np.log10(r) if r > 0 else -np.inf


def rolloff(x, sr, frac=0.995):
    """Frequency below which `frac` of spectral energy lies."""
    m = x.mean(axis=1)
    n = 1 << 16
    acc = np.zeros(n // 2 + 1)
    hop = n // 2
    w = np.hanning(n)
    cnt = 0
    for i in range(0, max(1, len(m) - n), hop):
        seg = m[i : i + n]
        if len(seg) < n:
            break
        acc += np.abs(np.fft.rfft(seg * w)) ** 2
        cnt += 1
    if cnt == 0:
        return 0.0
    freqs = np.fft.rfftfreq(n, 1 / sr)
    c = np.cumsum(acc)
    return float(freqs[np.searchsorted(c, c[-1] * frac)])


def bands(x, sr):
    m = x.mean(axis=1)
    n = 1 << 16
    w = np.hanning(n)
    acc = np.zeros(n // 2 + 1)
    for i in range(0, max(1, len(m) - n), n // 2):
        seg = m[i : i + n]
        if len(seg) < n:
            break
        acc += np.abs(np.fft.rfft(seg * w)) ** 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    edges = [0, 120, 500, 2000, 6000, 12000, sr / 2]
    tot = acc.sum() or 1.0
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (freqs >= lo) & (freqs < hi)
        out.append((lo, hi, 100 * acc[sel].sum() / tot))
    return out


def main():
    orig_p, inst_p, voc_p = sys.argv[1:4]
    inst, sr = load(inst_p)
    voc, _ = load(voc_p)
    orig, _ = load(orig_p, target_sr=sr)

    n = min(len(orig), len(inst), len(voc))
    orig, inst, voc = orig[:n], inst[:n], voc[:n]

    print(f"sample rate      : {sr} Hz   ({n/sr:.2f} s)")
    print()
    print("── levels (RMS)")
    for name, x in (("original", orig), ("instrumental", inst), ("vocals", voc)):
        print(f"  {name:<14} {db(x):7.2f} dBFS   peak {20*np.log10(np.max(np.abs(x))):6.2f}")

    print()
    print("── null test  (instrumental + vocals) − original")
    s = inst + voc
    res = s - orig
    print(f"  sum of stems   {db(s):7.2f} dBFS")
    print(f"  residual       {db(res):7.2f} dBFS")
    print(f"  → {db(res) - db(orig):+.2f} dB relative to original")
    print("     (very negative = stems reconstruct the mix almost exactly)")

    print()
    print("── bandwidth (99.5% energy rolloff)")
    for name, x in (("original", orig), ("instrumental", inst), ("vocals", voc)):
        print(f"  {name:<14} {rolloff(x, sr)/1000:6.2f} kHz")

    print()
    print("── energy by band (%)")
    hdr = "  band            orig    inst     voc"
    print(hdr)
    bo, bi, bv = bands(orig, sr), bands(inst, sr), bands(voc, sr)
    for (lo, hi, po), (_, _, pi), (_, _, pv) in zip(bo, bi, bv):
        lbl = f"{lo/1000:g}–{hi/1000:g}k"
        print(f"  {lbl:<12} {po:6.2f}  {pi:6.2f}  {pv:6.2f}")

    print()
    print("── stem independence")
    a, b = inst.mean(axis=1), voc.mean(axis=1)
    c = float(np.corrcoef(a, b)[0, 1])
    print(f"  inst/vocals correlation  {c:+.4f}   (near 0 = cleanly separated)")


if __name__ == "__main__":
    main()
