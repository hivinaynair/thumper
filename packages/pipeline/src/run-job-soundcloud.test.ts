import { describe, expect, it } from "bun:test";
import {
  soundCloudStepAfterMirror,
  type YoutubePreferResult,
} from "./run-job";

const TRACK_URL = "https://soundcloud.com/casey-club/voicenote-violence";

/** Records what the decision asked the probe, so pass-through stays verified. */
function probeRecorder(hasFreeDownload: boolean) {
  const calls: Array<{
    url: string;
    cookiePath?: string | null;
    signal?: AbortSignal;
  }> = [];
  return {
    calls,
    probe: async (
      url: string,
      cookiePath?: string | null,
      signal?: AbortSignal,
    ) => {
      calls.push({ url, cookiePath, signal });
      return hasFreeDownload;
    },
  };
}

describe("soundCloudStepAfterMirror", () => {
  it("stops without probing once the mirror already delivered", async () => {
    const recorder = probeRecorder(true);

    expect(
      await soundCloudStepAfterMirror({
        ytResult: "downloaded",
        trackUrl: TRACK_URL,
        cookiePath: "/tmp/sc.txt",
        probeFreeDownload: recorder.probe,
      }),
    ).toBe("done");
    // A second yt-dlp round trip after a finished download is pure waste.
    expect(recorder.calls).toEqual([]);
  });

  // Every non-delivery reason leaves the same thing behind: the artist's upload
  // or nothing. None of them may quietly settle for a stream.
  const missedMirror: YoutubePreferResult[] = [
    "no_mirror",
    "no_cookies",
    "youtube_failed",
  ];

  for (const ytResult of missedMirror) {
    it(`falls back to the artist's own upload when the mirror is ${ytResult}`, async () => {
      const recorder = probeRecorder(true);

      expect(
        await soundCloudStepAfterMirror({
          ytResult,
          trackUrl: TRACK_URL,
          cookiePath: "/tmp/sc.txt",
          probeFreeDownload: recorder.probe,
        }),
      ).toBe("soundcloud-original");
    });

    it(`fails rather than taking a stream when the mirror is ${ytResult} and the artist enabled no download`, async () => {
      const recorder = probeRecorder(false);

      await expect(
        soundCloudStepAfterMirror({
          ytResult,
          trackUrl: TRACK_URL,
          cookiePath: "/tmp/sc.txt",
          probeFreeDownload: recorder.probe,
        }),
      ).rejects.toThrow(/has not enabled its SoundCloud download/);
    });
  }

  it("probes the track with the caller's cookies and abort signal", async () => {
    const recorder = probeRecorder(true);
    const signal = new AbortController().signal;

    await soundCloudStepAfterMirror({
      ytResult: "no_mirror",
      trackUrl: TRACK_URL,
      cookiePath: "/tmp/sc.txt",
      signal,
      probeFreeDownload: recorder.probe,
    });

    // Without the cookie jar the probe cannot see a download the artist gated
    // behind a follow, so it would report "no original" for tracks that have one.
    expect(recorder.calls).toEqual([
      { url: TRACK_URL, cookiePath: "/tmp/sc.txt", signal },
    ]);
  });

  it("still probes when the job has no SoundCloud cookies", async () => {
    const recorder = probeRecorder(false);

    await expect(
      soundCloudStepAfterMirror({
        ytResult: "no_mirror",
        trackUrl: TRACK_URL,
        cookiePath: null,
        probeFreeDownload: recorder.probe,
      }),
    ).rejects.toThrow();
    expect(recorder.calls[0]?.cookiePath).toBeNull();
  });
});
