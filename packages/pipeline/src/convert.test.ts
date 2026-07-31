import { describe, expect, it } from "bun:test";
import { headroomGainDb } from "./convert";

describe("headroomGainDb", () => {
  it("leaves a signal with headroom alone", () => {
    expect(headroomGainDb(-1.5)).toBeNull();
    expect(headroomGainDb(-0.4)).toBeNull();
  });

  it("pulls back a decode that overshoots full scale", () => {
    // ffmpeg's astats reports >0 dB for lossy decodes whose reconstruction
    // exceeds ±1.0. Writing that to integer PCM clamps it flat.
    const gain = headroomGainDb(1.2);
    expect(gain).not.toBeNull();
    expect(gain!).toBeCloseTo(-1.5, 3);
  });

  it("pulls back a signal sitting exactly at 0 dBFS", () => {
    expect(headroomGainDb(0)).toBeCloseTo(-0.3, 3);
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
