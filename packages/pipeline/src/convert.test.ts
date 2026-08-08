import { describe, expect, it } from "bun:test";
import {
  loudnessGainDb,
  TARGET_LUFS,
  TRUE_PEAK_CEILING_DB,
} from "./convert";

describe("loudnessGainDb", () => {
  it("leaves a hot master alone when it has peak headroom", () => {
    // −5.7 LUFS is a real measurement from a crushed SoundCloud stream. It sits
    // well above the target, but loudness gain is boost-only: electronic
    // masters are deliberately hot and are not pulled down to match.
    expect(loudnessGainDb({ integratedLufs: -5.7, truePeakDb: -2 })).toBeNull();
  });

  it("still attenuates a hot master whose true peak breaches the ceiling", () => {
    // The one case allowed to reduce level, and it is not a loudness decision:
    // writing a +2.8 dBFS overshoot to integer PCM clips it flat, adding
    // distortion that was never in the master.
    const gain = loudnessGainDb({ integratedLufs: -5.7, truePeakDb: 2.8 });
    expect(gain).toBeCloseTo(TRUE_PEAK_CEILING_DB - 2.8, 3);
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

  it("never returns a positive gain that would overshoot the target", () => {
    // A track sitting exactly on target with plenty of headroom must not be
    // pushed further just because room exists.
    expect(loudnessGainDb({ integratedLufs: -9, truePeakDb: -12 })).toBeNull();
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
