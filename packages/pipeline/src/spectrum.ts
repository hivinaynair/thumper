/**
 * Minimal real-input FFT + spectral cutoff estimation.
 *
 * Why this exists: a "lossless" container tells you nothing about whether the
 * audio inside it was ever lossless. A 128 kbps AAC stream decoded and re-wrapped
 * as ALAC is bit-for-bit lossless *relative to the lossy decode* — the file is
 * large, the codec name says ALAC, and every metadata check passes. The only
 * reliable tell is the spectrum: lossy encoders lowpass hard, and that cliff
 * survives every subsequent conversion.
 *
 * Pure functions, no I/O — see audio-verify.ts for the ffmpeg plumbing.
 */

const FFT_SIZE = 8192;

/** Precomputed Hann window; the transform is always FFT_SIZE wide. */
const HANN = (() => {
  const w = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }
  return w;
})();

/** In-place iterative radix-2 Cooley–Tukey. `re`/`im` must be power-of-two length. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]!;
        const aIm = im[i + k]!;
        const bRe = re[i + k + half]! * curRe - im[i + k + half]! * curIm;
        const bIm = re[i + k + half]! * curIm + im[i + k + half]! * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * Average power spectrum across the signal, in dB relative to its own peak.
 * Near-silent frames are skipped so leading/trailing silence can't drag the
 * average down and fake a low cutoff.
 *
 * Returns FFT_SIZE/2 + 1 bins spanning DC..Nyquist.
 */
export function averageSpectrumDb(samples: Float32Array): Float64Array {
  const bins = FFT_SIZE / 2 + 1;
  const acc = new Float64Array(bins);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let frames = 0;

  const frameCount = Math.floor(samples.length / FFT_SIZE);
  for (let f = 0; f < frameCount; f++) {
    const off = f * FFT_SIZE;

    let sumSq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = samples[off + i]!;
      sumSq += s * s;
    }
    // −80 dBFS RMS: quiet enough to be silence, loud enough that real fades count.
    if (Math.sqrt(sumSq / FFT_SIZE) < 1e-4) continue;

    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[off + i]! * HANN[i]!;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let b = 0; b < bins; b++) {
      acc[b] = acc[b]! + re[b]! * re[b]! + im[b]! * im[b]!;
    }
    frames++;
  }

  const out = new Float64Array(bins);
  if (frames === 0) {
    out.fill(-Infinity);
    return out;
  }

  let peak = -Infinity;
  for (let b = 0; b < bins; b++) {
    const db = 10 * Math.log10(acc[b]! / frames + 1e-30);
    out[b] = db;
    if (db > peak) peak = db;
  }
  for (let b = 0; b < bins; b++) out[b] = out[b]! - peak;
  return out;
}

export type CutoffEstimate = {
  /** Highest frequency still carrying real signal, Hz. Meaningless if !detected. */
  cutoffHz: number;
  /** cutoffHz as a fraction of Nyquist. ~1.0 means no artificial lowpass. */
  ratio: number;
  /** Estimated noise floor in the top of the band, dB below peak. */
  floorDb: number;
  /**
   * False when no band rose clear of the floor — a flat spectrum (noise, or an
   * FFT over silence) rather than a file with no highs. Callers must treat this
   * as "could not measure", never as a cutoff of 0 Hz.
   */
  detected: boolean;
};

/**
 * Consecutive bins required above the threshold before a band counts as
 * content. A lone bin is a stray tone, an encoder artefact or leakage; real
 * content is broadband and occupies a run of them.
 */
const MIN_RUN_BINS = 4;

/**
 * Find where content stops.
 *
 * Self-calibrating rather than a fixed dB threshold: a 16-bit dithered master
 * and a 24-bit one have wildly different noise floors, so we measure the floor
 * from the top few percent of the band and look for the highest *run* of bins
 * that rises meaningfully above it, scanning downward from Nyquist.
 */
export function estimateCutoff(
  spectrumDb: Float64Array,
  sampleRate: number,
): CutoffEstimate {
  const n = spectrumDb.length;
  const nyquist = sampleRate / 2;
  const binHz = nyquist / (n - 1);

  const tail = Array.from(spectrumDb.slice(Math.floor(n * 0.96))).sort(
    (a, b) => a - b,
  );
  const floorDb = tail.length
    ? (tail[Math.floor(tail.length / 2)] ?? -120)
    : -120;

  // 12 dB clear of the floor: comfortably above dither and analysis leakage,
  // well below the ~25 dB cliff a lossy encoder's lowpass leaves behind.
  const threshold = floorDb + 12;

  let cutoffHz = 0;
  let detected = false;
  let run = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (spectrumDb[i]! > threshold) {
      run++;
      if (run >= MIN_RUN_BINS) {
        // Top of the run, not the bin that completed it.
        cutoffHz = (i + MIN_RUN_BINS - 1) * binHz;
        detected = true;
        break;
      }
    } else {
      run = 0;
    }
  }

  // Content running to the very top means there is no lowpass to find; report
  // Nyquist rather than an arbitrary bin a hair below it.
  if (detected && cutoffHz >= 0.97 * nyquist) cutoffHz = nyquist;

  return {
    cutoffHz,
    ratio: nyquist > 0 ? cutoffHz / nyquist : 0,
    floorDb,
    detected,
  };
}

export const SPECTRUM_FFT_SIZE = FFT_SIZE;
