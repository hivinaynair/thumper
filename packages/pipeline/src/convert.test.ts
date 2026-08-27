import { describe, expect, it } from "bun:test";
import {
  loudnessGainDb,
  lossyFilterArgs,
  lossyProcessingPlan,
  TARGET_LUFS,
  SAMPLE_PEAK_CEILING_DB,
} from "./convert";

describe("loudnessGainDb", () => {
  it("leaves a hot master alone when it has peak headroom", () => {
    // −5.7 LUFS is a real measurement from a crushed SoundCloud stream. It sits
    // well above the target, but loudness gain is boost-only: electronic
    // masters are deliberately hot and are not pulled down to match.
    expect(
      loudnessGainDb({ integratedLufs: -5.7, samplePeakDb: -2 }),
    ).toBeNull();
  });

  it("still attenuates a hot master whose decode would clip on write", () => {
    // The one case allowed to reduce level, and it is not a loudness decision:
    // writing a +2.8 dBFS overshoot to integer PCM clips it flat, adding
    // distortion that was never in the master.
    const gain = loudnessGainDb({ integratedLufs: -5.7, samplePeakDb: 2.8 });
    expect(gain).toBeCloseTo(SAMPLE_PEAK_CEILING_DB - 2.8, 3);
    expect(gain!).toBeLessThan(0);
  });

  it("boosts a quiet track only as far as peak headroom allows", () => {
    // Wants +5 LU, but sample peak is already at −1.5 dBFS, so only 1.4 dB of
    // room exists under the ceiling. Reaching the target would need a limiter.
    const gain = loudnessGainDb({ integratedLufs: -14, samplePeakDb: -1.5 });
    expect(gain).toBeCloseTo(1.4, 3);
  });

  it("never limits — a dynamic track stays quiet rather than being squashed", () => {
    const gain = loudnessGainDb({ integratedLufs: -20, samplePeakDb: -0.1 });
    // Zero headroom left, and the 11 LU shortfall is simply not taken.
    expect(gain).toBeNull();
  });

  it("attenuates exactly to the ceiling, no further", () => {
    // The minimum reduction that keeps the decode out of the clamp.
    const gain = loudnessGainDb({ integratedLufs: -9, samplePeakDb: 0.8 });
    expect(gain).toBeCloseTo(SAMPLE_PEAK_CEILING_DB - 0.8, 3);
    expect(gain!).toBeLessThan(0);
  });

  it("skips inaudibly small corrections", () => {
    expect(
      loudnessGainDb({ integratedLufs: -9.05, samplePeakDb: -3 }),
    ).toBeNull();
  });

  it("never returns a positive gain that would overshoot the target", () => {
    // A track sitting exactly on target with plenty of headroom must not be
    // pushed further just because room exists.
    expect(
      loudnessGainDb({ integratedLufs: -9, samplePeakDb: -12 }),
    ).toBeNull();
  });

  it("ignores a silent file", () => {
    expect(
      loudnessGainDb({ integratedLufs: -Infinity, samplePeakDb: -Infinity }),
    ).toBeNull();
    expect(
      loudnessGainDb({ integratedLufs: Number.NaN, samplePeakDb: -3 }),
    ).toBeNull();
  });

  it("leaves an unmeasured file alone rather than guessing", () => {
    // null means measurement failed. Treating it as a hot file would attenuate
    // every track whose analysis happened to error.
    expect(
      loudnessGainDb({ integratedLufs: null, samplePeakDb: -3 }),
    ).toBeNull();
    expect(
      loudnessGainDb({ integratedLufs: -9, samplePeakDb: null }),
    ).toBeNull();
  });
});

describe("lossyProcessingPlan", () => {
  it("limits an overshooting stream instead of lowering the whole track", () => {
    const plan = lossyProcessingPlan(
      { integratedLufs: -7.6, samplePeakDb: 1 },
      true,
    );

    expect(plan).toEqual({ gainDb: null, peakLimited: true });
    expect(lossyFilterArgs(plan)).toEqual([
      "-af",
      "alimiter=limit=0.988553:attack=0.1:release=1:level=false:latency=true",
    ]);
  });

  it("does not limit a stream that already fits in integer PCM", () => {
    // −0.05 dBFS is above the −0.1 write margin but will not clamp on encode.
    // The 5/50 limiter used to fire here and duck every near-full-scale kick.
    const plan = lossyProcessingPlan(
      { integratedLufs: -7.6, samplePeakDb: -0.05 },
      true,
    );
    expect(plan).toEqual({ gainDb: null, peakLimited: false });
    expect(lossyFilterArgs(plan)).toEqual([]);
  });

  it("does not limit a file sitting exactly at 0 dBFS", () => {
    const plan = lossyProcessingPlan(
      { integratedLufs: -7.6, samplePeakDb: 0 },
      true,
    );
    expect(plan).toEqual({ gainDb: null, peakLimited: false });
  });

  it("keeps clean boost below the ceiling without invoking the limiter", () => {
    const plan = lossyProcessingPlan(
      { integratedLufs: -14, samplePeakDb: -3 },
      true,
    );

    expect(plan).toEqual({ gainDb: 2.9, peakLimited: false });
    expect(lossyFilterArgs(plan)).toEqual(["-af", "volume=2.9dB"]);
  });

  it("retains whole-track safety attenuation when limiting is disabled", () => {
    const plan = lossyProcessingPlan(
      { integratedLufs: -7.6, samplePeakDb: 1 },
      false,
    );

    expect(plan).toEqual({ gainDb: -1.1, peakLimited: false });
    expect(lossyFilterArgs(plan)).toEqual(["-af", "volume=-1.1dB"]);
  });

  it("does not guess when loudness measurement failed", () => {
    expect(
      lossyProcessingPlan({ integratedLufs: null, samplePeakDb: 1 }, true),
    ).toEqual({ gainDb: null, peakLimited: false });
  });
});
