import { describe, expect, it } from "bun:test";
import {
  isFormatUnavailable,
  isRateLimitError,
  isSoundCloudPreviewError,
  isSoundCloudUnavailableError,
  isYoutubeBotError,
  SoundCloudPreviewError,
} from "./download";

describe("isSoundCloudUnavailableError", () => {
  it("matches the DRM error yt-dlp reports for encrypted tracks", () => {
    const err = new Error(
      "/opt/venv/bin/yt-dlp failed (1): ERROR: [soundcloud] 2269449665: This video is DRM protected",
    );
    expect(isSoundCloudUnavailableError(err)).toBe(true);
  });

  it("matches geo-blocked tracks", () => {
    for (const message of [
      "ERROR: [soundcloud] 123: The uploader has not made this video available in your country",
      "ERROR: This video is not available from your location",
      "ERROR: [soundcloud] 123: Video is geo restricted",
    ]) {
      expect(isSoundCloudUnavailableError(new Error(message))).toBe(true);
    }
  });

  it("still covers preview-only tracks", () => {
    expect(
      isSoundCloudUnavailableError(new SoundCloudPreviewError("preview-only")),
    ).toBe(true);
    expect(
      isSoundCloudUnavailableError(
        new SoundCloudPreviewError(
          "SoundCloud has no full stream (preview-only, geo-blocked, or DRM).",
        ),
      ),
    ).toBe(true);
  });

  it("ignores ordinary download failures so they surface as errors", () => {
    for (const message of [
      "ERROR: unable to download video data: HTTP Error 403: Forbidden",
      "ERROR: [soundcloud] 123: Unable to extract client id",
      "ffmpeg exited with code 1",
    ]) {
      expect(isSoundCloudUnavailableError(new Error(message))).toBe(false);
    }
  });

  it("does not treat DRM as preview-only", () => {
    expect(isSoundCloudPreviewError(new Error("This video is DRM protected"))).toBe(
      false,
    );
  });
});

describe("isFormatUnavailable", () => {
  it("matches YouTube serving no formats", () => {
    expect(
      isFormatUnavailable(
        new Error(
          "/opt/venv/bin/yt-dlp failed (1): ERROR: [youtube] 62i7zHtmsTA: Requested format is not available. Use --list-formats for a list of available formats",
        ),
      ),
    ).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isFormatUnavailable(new Error("HTTP Error 403: Forbidden"))).toBe(
      false,
    );
    expect(isFormatUnavailable(new Error("Video unavailable"))).toBe(false);
  });
});

describe("isYoutubeBotError", () => {
  it("matches the datacenter bot challenge", () => {
    expect(
      isYoutubeBotError(
        new Error(
          "ERROR: [youtube] 6IQ7KznpdCQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser",
        ),
      ),
    ).toBe(true);
  });

  it("ignores ordinary YouTube failures", () => {
    expect(isYoutubeBotError(new Error("Video unavailable"))).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it("matches HTTP 429", () => {
    expect(
      isRateLimitError(
        new Error(
          "/opt/venv/bin/yt-dlp failed (1): ERROR: HTTP Error 429: Too Many Requests",
        ),
      ),
    ).toBe(true);
  });

  it("ignores other HTTP errors", () => {
    expect(isRateLimitError(new Error("HTTP Error 403: Forbidden"))).toBe(
      false,
    );
  });
});
