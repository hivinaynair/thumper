import { describe, expect, it } from "bun:test";
import { aiffPcmCodec, headroomGainDb } from "./convert";

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

  it("defaults to 24-bit when nothing is known", () => {
    expect(aiffPcmCodec("")).toBe("pcm_s24be");
  });
});

describe("headroomGainDb", () => {
  it("leaves a signal already at full scale alone", () => {
    expect(headroomGainDb(0)).toBeNull();
    expect(headroomGainDb(-0.05)).toBeNull();
    expect(headroomGainDb(0.05)).toBeNull();
  });

  it("pulls back a decode that overshoots full scale", () => {
    // ffmpeg's astats reports >0 dB for lossy decodes whose reconstruction
    // exceeds ±1.0. Writing that to integer PCM clamps it flat.
    const gain = headroomGainDb(1.2);
    expect(gain).not.toBeNull();
    expect(gain!).toBeCloseTo(-1.2, 3);
  });

  it("boosts quiet loudness-normalized streams up to 0 dBFS", () => {
    // YouTube ~−14 LUFS often peaks around −1 to −8 dBFS — raise to full scale
    // so DJ waveforms aren't tiny next to club masters.
    expect(headroomGainDb(-1.5)).toBeCloseTo(1.5, 3);
    expect(headroomGainDb(-6)).toBeCloseTo(6, 3);
  });

  it("ignores a silent file", () => {
    expect(headroomGainDb(-Infinity)).toBeNull();
    expect(headroomGainDb(Number.NaN)).toBeNull();
  });

  it("leaves an unmeasured file alone rather than guessing", () => {
    // null means the peak could not be read. Treating that as 0 dBFS would
    // attenuate every file whose analysis happened to fail.
    expect(headroomGainDb(null)).toBeNull();
  });
});
