import { describe, expect, it } from "bun:test";
import {
  aiffPcmCodec,
  loudnessGainDb,
  TARGET_LUFS,
  TRUE_PEAK_CEILING_DB,
} from "./convert";

describe("aiffPcmCodec", () => {
  it("maps common WAV codecs to matching big-endian AIFF PCM", () => {
    expect(aiffPcmCodec("pcm_s16le")).toBe("pcm_s16be");
    expect(aiffPcmCodec("pcm_s24le")).toBe("pcm_s24be");
    expect(aiffPcmCodec("pcm_s32le")).toBe("pcm_s32be");
    expect(aiffPcmCodec("pcm_f32le")).toBe("pcm_f32be");
  });

  it("uses sample_fmt when codec name has no bit depth", () => {
    expect(aiffPcmCodec("", "s24")).toBe("pcm_s24be");
    expect(aiffPcmCodec("", "s16")).toBe("pcm_s16be");
  });

  it("does not treat ffmpeg's padded s32 sample_fmt as real 32-bit", () => {
    // 24-bit WAV commonly probes as codec=pcm_s24le + sample_fmt=s32.
    expect(aiffPcmCodec("pcm_s24le", "s32")).toBe("pcm_s24be");
    // Or codec=pcm_s32le with bits_per_raw_sample=24 (zero-padded container).
    expect(aiffPcmCodec("pcm_s32le", "s32", 24)).toBe("pcm_s24be");
    // Bare sample_fmt=s32 alone → assume 24-bit producer master, not 32-bit.
    expect(aiffPcmCodec("", "s32")).toBe("pcm_s24be");
  });

  it("still writes 32-bit when the source is actually 32-bit", () => {
    expect(aiffPcmCodec("pcm_s32le", "s32", 32)).toBe("pcm_s32be");
  });

  it("defaults to 24-bit when nothing is known", () => {
    expect(aiffPcmCodec("")).toBe("pcm_s24be");
  });

  it("does not write float AIFF just because a lossy decoder reports fltp", () => {
    // Opus and AAC both decode to fltp. Honouring that made every YouTube and
    // SoundCloud download a 32-bit float AIFF for no gain in information.
    expect(aiffPcmCodec("opus", "fltp")).toBe("pcm_s24be");
    expect(aiffPcmCodec("aac", "fltp")).toBe("pcm_s24be");
    // A real float PCM master still round-trips as float.
    expect(aiffPcmCodec("pcm_f32le", "flt")).toBe("pcm_f32be");
  });
});

describe("loudnessGainDb", () => {
  it("attenuates a hot master down to the target", () => {
    // −5.7 LUFS is a real measurement from a crushed SoundCloud stream.
    // Attenuation is never capped — pulling down is always safe.
    const gain = loudnessGainDb({ integratedLufs: -5.7, truePeakDb: -0.2 });
    expect(gain).toBeCloseTo(TARGET_LUFS - -5.7, 3);
    expect(gain!).toBeLessThan(0);
  });

  it("boosts a quiet track only as far as true-peak headroom allows", () => {
    // Wants +5 LU, but true peak is already at −1.5 dBFS, so only 0.5 dB of
    // room exists under the ceiling. Reaching the target would need a limiter.
    const gain = loudnessGainDb({ integratedLufs: -14, truePeakDb: -1.5 });
    expect(gain).toBeCloseTo(0.5, 3);
  });

  it("never limits — a dynamic track stays quiet rather than being squashed", () => {
    const gain = loudnessGainDb({ integratedLufs: -20, truePeakDb: -1 });
    // Zero headroom left, and the 11 LU shortfall is simply not taken.
    expect(gain).toBeNull();
  });

  it("uses true peak, not sample peak, for the ceiling", () => {
    // Sample peak could read −0.1 here while true peak is +0.8; normalizing to
    // 0 dBFS sample peak would hand the CDJ's D/A an unreconstructable signal.
    const gain = loudnessGainDb({ integratedLufs: -9, truePeakDb: 0.8 });
    expect(gain).toBeCloseTo(TRUE_PEAK_CEILING_DB - 0.8, 3);
    expect(gain!).toBeLessThan(0);
  });

  it("skips inaudibly small corrections", () => {
    expect(loudnessGainDb({ integratedLufs: -9.05, truePeakDb: -3 })).toBeNull();
  });

  it("ignores a silent file", () => {
    expect(
      loudnessGainDb({ integratedLufs: -Infinity, truePeakDb: -Infinity }),
    ).toBeNull();
    expect(
      loudnessGainDb({ integratedLufs: Number.NaN, truePeakDb: -3 }),
    ).toBeNull();
  });

  it("leaves an unmeasured file alone rather than guessing", () => {
    // null means measurement failed. Treating it as a hot file would attenuate
    // every track whose analysis happened to error.
    expect(loudnessGainDb({ integratedLufs: null, truePeakDb: -3 })).toBeNull();
    expect(loudnessGainDb({ integratedLufs: -9, truePeakDb: null })).toBeNull();
  });
});
