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

/** Midband reference window — loud in every genre, never touched by a lowpass. */
const REF_LO_HZ = 1000;
const REF_HI_HZ = 5000;

/**
 * How far under the midband a band may sit and still count as music.
 *
 * Generous on purpose. It is not trying to find the lowpass — it only has to
 * exclude the dead zone a lossy encoder leaves behind, which sits 70-100 dB
 * down. A dark master measures ~57 dB below midband at 20 kHz and must stay
 * on the music side of this line.
 */
const PRESENCE_DB = 65;

/**
 * Total energy in a band, as dB. Deliberately not a median of the bin dBs: on
 * sparse, tonal material most bins sit in the gaps between partials, so a
 * median measures the space between the notes rather than the music.
 */
function bandEnergyDb(spectrumDb: Float64Array, lo: number, hi: number): number {
  let sum = 0;
  let count = 0;
  for (let i = lo; i <= hi; i++) {
    const v = spectrumDb[i]!;
    if (!Number.isFinite(v)) continue;
    sum += 10 ** (v / 10);
    count++;
  }
  return count === 0 ? -Infinity : 10 * Math.log10(sum / count + 1e-30);
}

/**
 * Find where content stops.
 *
 * Measures each band against the track's *own midband level*, not against the
 * top of the spectrum. The previous approach estimated a noise floor from the
 * top 4% of bins, which broke in both directions and shipped: MP3 output is
 * exactly zero above its ~20.5 kHz band limit, so the floor came out around
 * −127 dB and numerical residue at the codec's band edge read as content —
 * every MP3 scored ~20.7 kHz whether it was 320 kbps or 64. And for genuinely
 * full-band audio the top 4% *is* signal, so the floor was measured inside the
 * music and nothing cleared it, reporting a nonsense cutoff or none at all.
 *
 * The midband is immune to both: a lowpass never touches 1-5 kHz, and it is
 * loud in every genre.
 */
export function estimateCutoff(
  spectrumDb: Float64Array,
  sampleRate: number,
): CutoffEstimate {
  const n = spectrumDb.length;
  const nyquist = sampleRate / 2;
  const binHz = nyquist / (n - 1);

  const binAt = (hz: number) =>
    Math.max(0, Math.min(n - 1, Math.round(hz / binHz)));
  const refDb = bandEnergyDb(spectrumDb, binAt(REF_LO_HZ), binAt(REF_HI_HZ));
  if (!Number.isFinite(refDb)) {
    return { cutoffHz: 0, ratio: 0, floorDb: -Infinity, detected: false };
  }

  const threshold = refDb - PRESENCE_DB;

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
    floorDb: threshold,
    detected,
  };
}

export const SPECTRUM_FFT_SIZE = FFT_SIZE;
