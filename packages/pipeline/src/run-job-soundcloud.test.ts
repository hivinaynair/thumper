import { describe, expect, it } from "bun:test";
import { soundCloudStepAfterMirror, type YoutubePreferResult } from "./run-job";

describe("soundCloudStepAfterMirror", () => {
  it("stops once the mirror already delivered", () => {
    expect(soundCloudStepAfterMirror("downloaded")).toBe("done");
  });

  // Every non-delivery reason leaves the same thing behind. None of them may
  // fail outright: SoundCloud may still hold the artist's own upload, and only
  // the club-ready gate — which measures the file — gets to refuse a stream.
  const missedMirror: YoutubePreferResult[] = ["no_mirror", "no_cookies", "youtube_failed"];

  for (const ytResult of missedMirror) {
    it(`falls back to SoundCloud when the mirror is ${ytResult}`, () => {
      expect(soundCloudStepAfterMirror(ytResult)).toBe("soundcloud");
    });
  }
});
