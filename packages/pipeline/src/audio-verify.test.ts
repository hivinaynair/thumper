import { describe, expect, it } from "bun:test";
import {
  classifyForDj,
  impliedBitrateKbps,
  isClubReady,
  isLosslessCodec,
  isQualityGateError,
  QualityGateError,
  type AudioAnalysis,
} from "./audio-verify";
import { averageSpectrumDb, estimateCutoff, SPECTRUM_FFT_SIZE } from "./spectrum";

const SR = 44100;

function analysis(over: Partial<AudioAnalysis> = {}): AudioAnalysis {
  return {
    codec: "flac",
    sampleRate: SR,
    channels: 2,
    bitrateKbps: 900,
    cutoffHz: 21000,
    cutoffRatio: 21000 / (SR / 2),
    peakDb: -1.2,
    losslessContainer: true,
    ...over,
  };
}

/** Deterministic PRNG so the fixture is reproducible across runs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}

/**
 * Dense content up to `cutoffHz` and nothing but a dither-level floor above it —
 * the shape a lossy encoder leaves behind.
 *
 * The floor matters: estimateCutoff calibrates against the noise in the top of
 * the band, and real audio always has one (dither, room noise, decoder noise).
 * A mathematically silent tail is the one case that never occurs in practice.
 */
function syntheticLowpassed(cutoffHz: number, seconds = 4): Float32Array {
  const n = SPECTRUM_FFT_SIZE * Math.ceil((seconds * SR) / SPECTRUM_FFT_SIZE);
  const out = new Float32Array(n);

  const partials = 240;
  for (let p = 1; p <= partials; p++) {
    const freq = (cutoffHz * p) / partials;
    const phase = (p * 1.37) % (2 * Math.PI);
    const w = (2 * Math.PI * freq) / SR;
    const amp = 0.4 / Math.sqrt(partials);
    for (let i = 0; i < n; i++) out[i]! += amp * Math.cos(w * i + phase);
  }

  // Broadband floor ~70 dB below the content, i.e. a 16-bit dither floor.
  const rand = lcg(0x5eed);
  for (let i = 0; i < n; i++) out[i]! += rand() * 3e-4;

  return out;
}

describe("estimateCutoff", () => {
  it("finds a brickwall where a lossy encoder would put one", () => {
    const spectrum = averageSpectrumDb(syntheticLowpassed(16000));
    const { cutoffHz } = estimateCutoff(spectrum, SR);
    expect(cutoffHz).toBeGreaterThan(15000);
    expect(cutoffHz).toBeLessThan(17000);
  });

  it("reports Nyquist for full-band content", () => {
    const spectrum = averageSpectrumDb(syntheticLowpassed(21800));
    const { cutoffHz, ratio } = estimateCutoff(spectrum, SR);
    expect(ratio).toBeGreaterThan(0.95);
    expect(cutoffHz).toBeGreaterThan(20500);
  });

  it("separates a 128k-style cutoff from a 256k-style one", () => {
    const low = estimateCutoff(averageSpectrumDb(syntheticLowpassed(16000)), SR);
    const high = estimateCutoff(averageSpectrumDb(syntheticLowpassed(19500)), SR);
    expect(high.cutoffHz - low.cutoffHz).toBeGreaterThan(2500);
  });

  it("does not crash on silence, and reports it as unmeasurable", () => {
    const spectrum = averageSpectrumDb(new Float32Array(SPECTRUM_FFT_SIZE * 4));
    expect(() => estimateCutoff(spectrum, SR)).not.toThrow();
    // Not "content stops at 0 Hz" — we simply could not measure this file.
    expect(estimateCutoff(spectrum, SR).detected).toBe(false);
  });

  it("ignores an isolated spur above the brickwall", () => {
    // A single ultrasonic bin — a stray tone or encoder artefact — used to set
    // the cutoff on its own and promote a 16 kHz file to full-band.
    const bins = SPECTRUM_FFT_SIZE / 2 + 1;
    const binHz = SR / 2 / (bins - 1);
    const spectrum = new Float64Array(bins).fill(-90);
    for (let i = 0; i * binHz < 16000; i++) spectrum[i] = 0;
    spectrum[Math.round(21000 / binHz)] = -40;

    const { cutoffHz, detected } = estimateCutoff(spectrum, SR);
    expect(detected).toBe(true);
    expect(cutoffHz).toBeLessThan(16100);
  });
});

describe("isLosslessCodec", () => {
  it("recognises the lossless family", () => {
    for (const c of ["flac", "alac", "pcm_s16le", "pcm_s24le", "LPCM"]) {
      expect(isLosslessCodec(c)).toBe(true);
    }
  });

  it("rejects lossy codecs", () => {
    for (const c of ["aac", "mp3", "opus", "vorbis"]) {
      expect(isLosslessCodec(c)).toBe(false);
    }
  });
});

describe("classifyForDj", () => {
  it("passes a real master", () => {
    const v = classifyForDj(analysis(), { artistOriginal: true });
    expect(v.tier).toBe("master");
    expect(v.warnings).toEqual([]);
  });

  it("catches a lossy stream rewrapped as ALAC", () => {
    // The GLOSS file: ALAC container, 24-bit, larger than the WAV, 16.1 kHz.
    const v = classifyForDj(
      analysis({
        codec: "alac",
        cutoffHz: 16134,
        cutoffRatio: 16134 / (SR / 2),
        bitrateKbps: 1765,
        peakDb: 0,
      }),
    );
    expect(v.tier).toBe("unsuitable");
    expect(v.warnings.join(" ")).toContain("not a master");
    expect(v.warnings.join(" ")).toContain("128 kbps");
    expect(v.headline).toContain("Not suitable");
  });

  it("flags zero headroom separately from the codec problem", () => {
    const v = classifyForDj(
      analysis({ codec: "aac", losslessContainer: false, peakDb: 0 }),
    );
    expect(v.warnings.some((w) => w.includes("headroom"))).toBe(true);
  });

  it("accepts a good lossy stream as club-ready", () => {
    const v = classifyForDj(
      analysis({
        codec: "aac",
        losslessContainer: false,
        cutoffHz: 19800,
        cutoffRatio: 19800 / (SR / 2),
        bitrateKbps: 256,
      }),
    );
    expect(v.tier).toBe("club");
  });

  it("calls a 17-19 kHz source marginal", () => {
    const v = classifyForDj(
      analysis({
        codec: "opus",
        losslessContainer: false,
        cutoffHz: 18000,
        cutoffRatio: 18000 / 24000,
        sampleRate: 48000,
      }),
    );
    expect(v.tier).toBe("marginal");
  });

  it("does not penalise a lossless file for a benign 20 kHz roll-off", () => {
    // 20 kHz of 22.05 is ratio 0.907 — above the laundering threshold, so a
    // gently filtered but genuine master still reads as a master.
    const v = classifyForDj(
      analysis({ cutoffHz: 20100, cutoffRatio: 20100 / (SR / 2) }),
      { artistOriginal: true },
    );
    expect(v.tier).toBe("master");
  });

  it("will not call a 48 kHz file ending at 20 kHz a master", () => {
    // Ratio 0.833. Deliberately demoted to club: at 48 kHz this is spectrally
    // indistinguishable from Opus rewrapped as FLAC (0.854), and there is no
    // measurement that separates them. Nothing is blocked — club still clears
    // the club-ready gate — only the 'master' claim is withheld.
    const v = classifyForDj(
      analysis({
        codec: "pcm_s24le",
        sampleRate: 48000,
        cutoffHz: 20000,
        cutoffRatio: 20000 / 24000,
      }),
      { artistOriginal: true },
    );
    expect(v.tier).toBe("club");
    // Still not accused of being laundered — the lenient bar covers it.
    expect(v.warnings.join(" ")).not.toContain("not a master");
  });

  it("passes a 96 kHz hi-res master", () => {
    // The case the ratio test got badly wrong: no music has content near
    // 48 kHz, so every hi-res file scored ~0.5 and was called laundered lossy.
    const v = classifyForDj(
      analysis({
        codec: "pcm_s24le",
        sampleRate: 96000,
        cutoffHz: 24352,
        cutoffRatio: 24352 / 48000,
        bitrateKbps: 4608,
      }),
      { artistOriginal: true },
    );
    expect(v.tier).toBe("master");
    expect(v.warnings.join(" ")).not.toContain("not a master");
  });

  it("calls a band-limited lossless file narrow without calling it fake", () => {
    // 32 kHz PCM: full band for its own rate, but genuinely missing highs.
    const v = classifyForDj(
      analysis({
        codec: "pcm_s16le",
        sampleRate: 32000,
        cutoffHz: 15500,
        cutoffRatio: 15500 / 16000,
      }),
    );
    expect(v.tier).toBe("unsuitable");
    expect(v.warnings.join(" ")).not.toContain("not a master");
    expect(v.headline).toContain("lossless source");
  });

  it("says nothing about headroom when the peak could not be measured", () => {
    const v = classifyForDj(
      analysis({ codec: "aac", losslessContainer: false, peakDb: null }),
    );
    expect(v.warnings.some((w) => w.includes("headroom"))).toBe(false);
  });
});

describe("impliedBitrateKbps", () => {
  it("maps cutoffs onto the bitrates that produce them", () => {
    expect(impliedBitrateKbps(16134)).toBe(128);
    expect(impliedBitrateKbps(19500)).toBe(256);
    expect(impliedBitrateKbps(21000)).toBeNull();
  });
});

describe("isClubReady", () => {
  it("accepts master and club", () => {
    expect(isClubReady("master")).toBe(true);
    expect(isClubReady("club")).toBe(true);
  });

  it("rejects marginal and unsuitable", () => {
    expect(isClubReady("marginal")).toBe(false);
    expect(isClubReady("unsuitable")).toBe(false);
  });

  it("rejects a lossless container carrying lossy audio", () => {
    // The case the whole module exists for: FLAC wrapper, 16 kHz content.
    const tier = classifyForDj(
      analysis({ codec: "flac", cutoffHz: 16000, cutoffRatio: 16000 / (SR / 2) }),
    ).tier;
    expect(isClubReady(tier)).toBe(false);
  });
});

describe("QualityGateError", () => {
  it("names the tier and where the audio stops", () => {
    const err = new QualityGateError({
      tier: "marginal",
      cutoffHz: 16200,
      source: "SoundCloud stream",
    });
    expect(err.message).toContain("16.2 kHz");
    expect(err.message).toContain("SoundCloud stream");
    expect(err.tier).toBe("marginal");
    expect(err.cutoffHz).toBe(16200);
    expect(isQualityGateError(err)).toBe(true);
  });

  it("says so plainly when the audio could not be measured", () => {
    const err = new QualityGateError({ tier: null, source: "YouTube mirror" });
    expect(err.message).toContain("could not be verified");
    // No frequency may be claimed when none was measured.
    expect(err.message).not.toContain("kHz");
    expect(err.cutoffHz).toBeNull();
    expect(isQualityGateError(err)).toBe(true);
  });

  it("will not compile a known tier without its measurement", () => {
    // @ts-expect-error cutoffHz is required whenever the tier is known.
    const err = new QualityGateError({ tier: "marginal", source: "Bandcamp" });
    expect(isQualityGateError(err)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isQualityGateError(new Error("nope"))).toBe(false);
  });
});
