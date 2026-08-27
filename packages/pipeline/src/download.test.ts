import { describe, expect, it } from "bun:test";
import * as pipeline from "./index";
import {
  AUDIO_FORMAT_SORT,
  YOUTUBE_AUDIO_FORMAT_SELECTOR,
  youtubeExtractorArgs,
} from "./audio-quality";
import {
  downloadMediaWithDeps,
  isFormatUnavailable,
  isRateLimitError,
  isSoundCloudPreviewError,
  isSoundCloudUnavailableError,
  isYoutubeBotError,
  soundcloudHasFreeDownload,
  SoundCloudPreviewError,
} from "./download";

const youtubeParams = {
  url: "https://www.youtube.com/watch?v=quality",
  workDir: "/virtual/work",
  cookiePath: "/virtual/youtube-cookies.txt",
};

const selectedFile = "/virtual/work/selected.m4a";

const selectedOutput = (overrides: {
  formatId?: string;
  acodec?: string;
  abr?: string;
} = {}) =>
  [
    `__filepath__=${selectedFile}`,
    `__format_id__=${overrides.formatId ?? "premium-audio"}`,
    `__acodec__=${overrides.acodec ?? "aac"}`,
    `__abr__=${overrides.abr ?? "256"}`,
    "__title__=Selected track",
  ].join("\n");

const initialYoutubeArgs = () => [
  "-f",
  YOUTUBE_AUDIO_FORMAT_SELECTOR,
  "-S",
  AUDIO_FORMAT_SORT,
  "--no-check-certificate",
  "--no-playlist",
  "--force-ipv4",
  "--no-warnings",
  "--user-agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "-o",
  "/virtual/work/dl_test-uuid.%(ext)s",
  "--print",
  "after_move:__filepath__=%(filepath)s",
  "--print",
  "after_move:__abr__=%(abr)s",
  "--print",
  "after_move:__title__=%(title)s",
  "--print",
  "after_move:__format_id__=%(format_id)s",
  "--print",
  "after_move:__acodec__=%(acodec)s",
  "--extractor-args",
  youtubeExtractorArgs(),
  "--cookies",
  youtubeParams.cookiePath,
  youtubeParams.url,
];

const isolatedDeps = {
  mkdir: async (_directory: string) => undefined,
  randomUUID: () => "test-uuid",
};

describe("downloadMedia YouTube quality guarantees", () => {
  it("passes the exact codec-neutral authenticated quality argv initially", async () => {
    const invocations: string[][] = [];

    await downloadMediaWithDeps(youtubeParams, {
      ...isolatedDeps,
      runCommand: async (_command, args) => {
        invocations.push(args);
        return { stdout: selectedOutput(), stderr: "" };
      },
    });

    expect(invocations).toEqual([initialYoutubeArgs()]);
  });

  it("retries every authenticated client in order with exact argv", async () => {
    const invocations: string[][] = [];

    await expect(
      downloadMediaWithDeps(youtubeParams, {
        ...isolatedDeps,
        runCommand: async (_command, args) => {
          invocations.push(args);
          throw new Error("Requested format is not available");
        },
      }),
    ).rejects.toThrow(/Re-sync fresh YouTube cookies|unavailable/i);

    const clients = [
      youtubeExtractorArgs(),
      "youtube:player_client=android_vr",
      "youtube:player_client=android",
      "youtube:player_client=mweb",
      "youtube:player_client=tv",
    ];
    expect(invocations).toHaveLength(clients.length);
    expect(invocations).toEqual(
      clients.map((extractorArgs) => {
        const args = initialYoutubeArgs();
        args[args.indexOf(youtubeExtractorArgs())] = extractorArgs;
        return args;
      }),
    );
    for (const args of invocations) {
      expect(args).toContain("--cookies");
      expect(args).toContain(youtubeParams.cookiePath);
    }
  });

  it("never attempts anonymous recovery after an authenticated failure", async () => {
    const invocations: string[][] = [];
    const progress: string[] = [];

    await expect(
      downloadMediaWithDeps(
        {
          ...youtubeParams,
          onProgress: (line) => progress.push(line),
        },
        {
          ...isolatedDeps,
          runCommand: async (_command, args) => {
            invocations.push(args);
            throw new Error("Sign in to confirm you’re not a bot");
          },
        },
      ),
    ).rejects.toThrow(/Re-sync fresh YouTube cookies|blocked/i);

    expect(invocations).toHaveLength(5);
    for (const args of invocations) {
      const cookieIndex = args.indexOf("--cookies");
      expect(args.slice(cookieIndex, cookieIndex + 2)).toEqual([
        "--cookies",
        youtubeParams.cookiePath,
      ]);
    }
    expect(progress.join("")).not.toContain("anonymously");
  });

  for (const missing of ["formatId", "acodec", "abr"] as const) {
    it(`rejects a successful YouTube download missing ${missing} and attempts cleanup`, async () => {
      const cleaned: string[] = [];
      const overrides =
        missing === "abr"
          ? { abr: "NA" }
          : missing === "acodec"
            ? { acodec: "NA" }
            : { formatId: "NA" };

      await expect(
        downloadMediaWithDeps(youtubeParams, {
          ...isolatedDeps,
          runCommand: async () => ({
            stdout: selectedOutput(overrides),
            stderr: "",
          }),
          unlink: async (filePath) => {
            cleaned.push(filePath);
          },
        }),
      ).rejects.toThrow(/quality verification/i);

      expect(cleaned).toEqual([selectedFile]);
    });
  }

  for (const selected of [
    { acodec: "aac", formatId: "aac-format", abr: "256" },
    { acodec: "opus", formatId: "251", abr: "160" },
  ]) {
    it(`accepts valid ${selected.acodec} selected markers`, async () => {
      const result = await downloadMediaWithDeps(youtubeParams, {
        ...isolatedDeps,
        runCommand: async () => ({
          stdout: selectedOutput(selected),
          stderr: "",
        }),
      });

      expect(result).toMatchObject({
        formatId: selected.formatId,
        acodec: selected.acodec,
        abr: Number(selected.abr),
      });
    });
  }

  it("keeps the dependency-injected test seam out of the package barrel", () => {
    expect("downloadMediaWithDeps" in pipeline).toBe(false);
  });
});

describe("soundcloudHasFreeDownload", () => {
  it("detects format_id=download in the formats list", () => {
    expect(
      soundcloudHasFreeDownload({
        formats: [
          { format_id: "http_mp3_128_0" },
          { format_id: "download" },
        ],
      }),
    ).toBe(true);
  });

  it("ignores preview-only and ordinary stream formats", () => {
    expect(
      soundcloudHasFreeDownload({
        formats: [
          { format_id: "http_mp3_128_0" },
          { format_id: "hls_aac_160_preview" },
        ],
      }),
    ).toBe(false);
  });

  it("accepts a top-level format_id when formats is missing", () => {
    expect(soundcloudHasFreeDownload({ format_id: "download" })).toBe(true);
  });
});

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
