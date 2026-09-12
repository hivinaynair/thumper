#!/usr/bin/env python3
"""Min-spec fusion: combine instrumentals from N models, keeping the QUIETEST
time-frequency bin from each. Anything ANY model calls vocal gets removed.

  minspec.py <out.flac> <inst1.flac> <inst2.flac> [inst3.flac ...]
"""
import sys
import numpy as np
import soundfile as sf

N_FFT, HOP = 4096, 1024


def stft(x):
    w = np.hanning(N_FFT).astype(np.float64)
    pad = N_FFT
    x = np.pad(x, (pad, pad))
    frames = 1 + (len(x) - N_FFT) // HOP
    out = np.empty((frames, N_FFT // 2 + 1), dtype=np.complex128)
    for i in range(frames):
        out[i] = np.fft.rfft(x[i * HOP : i * HOP + N_FFT] * w)
    return out


def istft(S, length):
    w = np.hanning(N_FFT).astype(np.float64)
    pad = N_FFT
    n = (S.shape[0] - 1) * HOP + N_FFT
    acc = np.zeros(n)
    wsum = np.zeros(n)
    for i in range(S.shape[0]):
        acc[i * HOP : i * HOP + N_FFT] += np.fft.irfft(S[i], N_FFT) * w
        wsum[i * HOP : i * HOP + N_FFT] += w**2
    acc /= np.maximum(wsum, 1e-10)
    return acc[pad : pad + length]


def main():
    out_p, *ins = sys.argv[1:]
    if len(ins) < 2:
        sys.exit("need at least two instrumentals")

    sigs, sr = [], None
    for p in ins:
        x, s = sf.read(p, always_2d=True, dtype="float64")
        sr = sr or s
        if s != sr:
            sys.exit(f"sample-rate mismatch: {p}")
        sigs.append(x)

    n = min(len(x) for x in sigs)
    ch = sigs[0].shape[1]
    sigs = [x[:n, :ch] for x in sigs]

    print(f"fusing {len(sigs)} instrumentals — {n/sr:.2f}s @ {sr} Hz, {ch} ch")
    for p in ins:
        print(f"  {p.split('/')[-2]}: {p.split('/')[-1][:60]}")

    out = np.zeros((n, ch))
    for c in range(ch):
        Ss = [stft(x[:, c]) for x in sigs]
        f = min(S.shape[0] for S in Ss)
        Ss = [S[:f] for S in Ss]
        mags = np.stack([np.abs(S) for S in Ss])          # (models, frames, bins)
        idx = np.argmin(mags, axis=0)                      # quietest model per bin
        mag = np.take_along_axis(mags, idx[None], 0)[0]
        # keep the phase of whichever model won that bin
        phase = np.angle(np.stack(Ss))
        ph = np.take_along_axis(phase, idx[None], 0)[0]
        out[:, c] = istft(mag * np.exp(1j * ph), n)

    peak = np.max(np.abs(out))
    if peak > 0.9:
        out *= 0.9 / peak
        print(f"  scaled by {0.9/peak:.4f} to avoid clipping")

    sf.write(out_p, out, sr, subtype="PCM_24")
    rms = 20 * np.log10(np.sqrt(np.mean(out**2)))
    print(f"wrote {out_p}")
    print(f"  RMS {rms:.2f} dBFS  peak {20*np.log10(peak):.2f} dBFS")
    for p, x in zip(ins, sigs):
        r = 20 * np.log10(np.sqrt(np.mean(x**2)))
        print(f"  vs {p.split('/')[-2]}: {r:.2f} dBFS  ({rms-r:+.2f} dB)")


if __name__ == "__main__":
    main()
