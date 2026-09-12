import { describe, expect, test } from "bun:test";
import { processingEstimate, stageInfo, waveformPeaks } from "./progress";

describe("stem progress", () => {
  test("distinguishes upload, queue, AI, delivery and terminal states", () => {
    expect(stageInfo("uploading", undefined, undefined, false).step).toBe(0);
    expect(stageInfo(undefined, "queued", "queued", false).title).toBe("Waiting for the AI");
    expect(stageInfo(undefined, "separating", "running", false).step).toBe(1);
    expect(stageInfo(undefined, "delivering", "running", false).step).toBe(2);
    expect(stageInfo(undefined, "separating", "cancelled", false).title).toBe("Cancelled");
    expect(stageInfo(undefined, "separating", "failed", true).title).toBe(
      "Couldn’t separate this track",
    );
  });
  test("waits for enough measured progress and excludes saving time", () => {
    expect(processingEstimate(undefined, 40, 60000)).toBeNull();
    expect(processingEstimate({ progress: 10, at: 0 }, 12, 60000)).toBeNull();
    expect(processingEstimate({ progress: 10, at: 0 }, 30, 5000)).toBeNull();
    expect(processingEstimate({ progress: 10, at: 0 }, 30, 60000)).toBe(
      "About 2 min of AI processing left · saving follows",
    );
    expect(processingEstimate({ progress: 10, at: 0 }, 70, 60000)).toBeNull();
  });
});

describe("waveform peaks", () => {
  test("preserves silence and finds peaks across both channels", () => {
    expect(waveformPeaks([new Float32Array(8)], 4)).toEqual([0, 0, 0, 0]);
    expect(
      waveformPeaks([new Float32Array([0, 0, 0, 0]), new Float32Array([0, -0.5, 1, 0])], 2),
    ).toEqual([0.5, 1]);
    expect(waveformPeaks([], 4)).toEqual([]);
  });
});
