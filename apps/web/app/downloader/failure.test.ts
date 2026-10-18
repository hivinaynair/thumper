import { describe, expect, it } from "bun:test";
import { classifyFailure } from "./failure";
import type { Job } from "./job-view";

function job(partial: Partial<Job> & Pick<Job, "id">): Job {
  return {
    status: "failed",
    stage: "error",
    progress: 0,
    sourceUrl: `https://example.com/${partial.id}`,
    audioFormat: "flac",
    destination: "browser",
    error: null,
    result: null,
    ...partial,
  };
}

function codeFor(error: string, result: Job["result"] = null): string | undefined {
  return classifyFailure(job({ id: "t", error, result }))?.code;
}

describe("classifyFailure", () => {
  it("says nothing about a job that has not failed", () => {
    expect(classifyFailure(job({ id: "t", status: "completed" }))).toBeNull();
    expect(classifyFailure(job({ id: "t", status: "running" }))).toBeNull();
    expect(classifyFailure(job({ id: "t", status: "cancelled", error: "Cancelled" }))).toBeNull();
  });

  it("falls back to the raw error rather than inventing friendly copy", () => {
    const failure = classifyFailure(job({ id: "t", error: "ffmpeg exited with code 1" }));
    expect(failure).toEqual({
      code: "unknown",
      headline: "Download failed",
      detail: "ffmpeg exited with code 1",
      raw: "ffmpeg exited with code 1",
    });
  });

  it("handles a failed job with no error string at all", () => {
    const failure = classifyFailure(job({ id: "t", error: null }));
    expect(failure?.code).toBe("unknown");
    expect(failure?.detail).toBe("No reason recorded.");
  });
});

describe("classifyFailure — pipeline strings", () => {
  it("reads YouTube bot checks, cookies or not", () => {
    expect(
      codeFor(
        "YouTube blocked this download (bot check), even with your synced cookies. Re-sync fresh YouTube cookies from a signed-in browser and retry.",
      ),
    ).toBe("youtube-bot-check");
    expect(
      codeFor(
        "YouTube blocked this download (bot check). Sync YouTube cookies from a signed-in browser, then retry.",
      ),
    ).toBe("youtube-bot-check");
  });

  it("reads the three ways YouTube reports no usable audio", () => {
    expect(
      codeFor(
        "YouTube returned no playable formats. Sync YouTube cookies from a signed-in browser and retry.",
      ),
    ).toBe("youtube-no-formats");
    expect(
      codeFor(
        "Authenticated YouTube audio is unavailable (cookies may be stale, or this client is DRM-locked). Re-sync fresh YouTube cookies from a signed-in browser and retry.",
      ),
    ).toBe("youtube-no-formats");
    expect(
      codeFor(
        "YouTube quality verification failed: yt-dlp did not report a real format id, audio codec, and positive audio bitrate.",
      ),
    ).toBe("youtube-no-formats");
  });

  it("reads an expired SoundCloud session", () => {
    expect(
      codeFor("SoundCloud session is no longer usable — refresh SoundCloud cookies and retry."),
    ).toBe("soundcloud-session");
  });

  it("reads preview-only SoundCloud streams", () => {
    expect(
      codeFor(
        "SoundCloud has no full stream (preview-only, geo-blocked, or DRM). Falling back to YouTube when possible.",
      ),
    ).toBe("soundcloud-preview");
    expect(
      codeFor("SoundCloud returned a preview-only stream. Falling back to YouTube when possible."),
    ).toBe("soundcloud-preview");
  });

  it("blames the preview, not the missing mirror, when both are true", () => {
    expect(
      codeFor(
        "SoundCloud only has a preview (often geo-blocked or Go+) and no confident YouTube mirror found for “Pearson Sound – Untitled”",
      ),
    ).toBe("soundcloud-preview");
  });

  it("reads a Spotify track with no mirror anywhere", () => {
    expect(codeFor("No confident mirror for “Hodge – Ghost Cassette” on YouTube/SoundCloud")).toBe(
      "no-mirror",
    );
    expect(
      codeFor(
        "No YouTube mirror to fall back on. If the artist offers a Free Download on SoundCloud, grab it there and upload it on Retag.",
      ),
    ).toBe("no-mirror");
  });

  it("reads rate limiting", () => {
    expect(codeFor("ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests")).toBe(
      "rate-limited",
    );
  });

  it("reads a missing Google Drive token", () => {
    expect(
      codeFor(
        "Google Drive selected but no Google token with drive.file — open your account menu and reconnect Google",
      ),
    ).toBe("drive");
    expect(codeFor("Drive upload returned no file id")).toBe("drive");
  });

  it("reads an unreadable playlist", () => {
    expect(
      codeFor(
        "Could not read this playlist — YouTube returned no track list. Try again in a minute, or queue the tracks individually.",
      ),
    ).toBe("playlist-unreadable");
    expect(codeFor("Could not read Spotify catalog metadata")).toBe("playlist-unreadable");
  });
});

describe("classifyFailure — result flags beat the string", () => {
  it("reads a club-ready rejection from the result flag", () => {
    const failure = classifyFailure(
      job({
        id: "t",
        error:
          "SoundCloud stream is not club-ready — audio stops at 16.0 kHz. Turn off Club-ready only to download it anyway.",
        result: { qualityRejected: true, cutoffHz: 16000, djTier: "marginal" },
      }),
    );
    expect(failure?.code).toBe("quality-gate");
    expect(failure?.headline).toBe("Below club-ready");
    // The measured cutoff only exists in the raw sentence, so that is the detail.
    expect(failure?.detail).toContain("16.0 kHz");
  });

  it("reads a store or stream page from the result flag", () => {
    const failure = classifyFailure(
      job({
        id: "t",
        error:
          "Manual download required: https://shop.example/track. This link is a stream or store page, not a file. Download it yourself, then upload it on Retag.",
        result: { manualDownloadUrl: "https://shop.example/track" },
      }),
    );
    expect(failure?.code).toBe("manual-download");
    expect(failure?.headline).toBe("Store or stream page");
  });
});

describe("classifyFailure — detail and raw", () => {
  it("keeps the raw text available when the hint is shorter", () => {
    const raw =
      "YouTube blocked this download (bot check), even with your synced cookies. Re-sync fresh YouTube cookies from a signed-in browser and retry.";
    const failure = classifyFailure(job({ id: "t", error: raw }));
    expect(failure?.raw).toBe(raw);
    expect(failure?.detail).not.toBe(raw);
  });

  it("makes detail and raw identical when there is nothing shorter to say", () => {
    const failure = classifyFailure(job({ id: "t", error: "ffmpeg exited with code 1" }));
    expect(failure?.detail).toBe(failure?.raw);
  });
});
