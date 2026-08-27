import { describe, expect, it } from "bun:test";
import {
  AUDIO_FORMAT_SELECTOR,
  AUDIO_FORMAT_SORT,
  audioQualityLabel,
  DEFAULT_YOUTUBE_PLAYER_CLIENTS,
  YOUTUBE_AUDIO_FORMAT_SELECTOR,
  withoutPreview,
  youtubeExtractorArgs,
} from "./audio-quality";

describe("withoutPreview", () => {
  it("excludes preview format ids and never falls through to bare best", () => {
    const out = withoutPreview("bestaudio[ext=wav]/bestaudio/best");
    expect(out).toContain("format_id!*=preview");
    expect(out).toBe(
      "bestaudio[format_id!*=preview][ext=wav]/bestaudio[format_id!*=preview]",
    );
    expect(out.endsWith("/best")).toBe(false);
    expect(out.includes("/bestaudio/") || out.endsWith("/bestaudio")).toBe(
      false,
    );
  });

  it("keeps the real SoundCloud selector fail-closed", () => {
    const out = withoutPreview(AUDIO_FORMAT_SELECTOR);
    expect(out).toContain("bestaudio[format_id!*=preview][format_id=download]");
    expect(out.endsWith("bestaudio[format_id!*=preview]")).toBe(true);
    expect(out).not.toMatch(/\/bestaudio$/);
    expect(out).not.toMatch(/\/best$/);
  });
});

describe("AUDIO_FORMAT_SELECTOR", () => {
  it("asks for the SoundCloud original upload before any transcode", () => {
    const groups = AUDIO_FORMAT_SELECTOR.split("/");
    expect(groups[0]).toBe("bestaudio[format_id=download]");
    expect(groups.indexOf("bestaudio")).toBeGreaterThan(
      groups.indexOf("bestaudio[acodec^=flac]"),
    );
  });

  it("still ends in an unconditional fallback", () => {
    expect(AUDIO_FORMAT_SELECTOR.endsWith("/bestaudio/best")).toBe(true);
  });
});

describe("AUDIO_FORMAT_SORT", () => {
  // The old value was "abr:desc,asr:desc,channels:desc,acodec:opus:aac:mp3".
  // In yt-dlp a ":" suffix means "preferred value" (numeric for numeric fields),
  // not a direction, so every term was malformed and the sort silently did
  // nothing — which is how a Premium account ended up with 128 kbps AAC.
  it("uses no direction suffixes", () => {
    expect(AUDIO_FORMAT_SORT).not.toContain(":desc");
    expect(AUDIO_FORMAT_SORT).not.toContain(":asc");
  });

  it("gives every term a bare, known field name", () => {
    const known = new Set([
      "abr",
      "asr",
      "channels",
      "acodec",
      "aext",
      "quality",
      "hasaud",
      "br",
      "size",
    ]);
    for (const term of AUDIO_FORMAT_SORT.split(",")) {
      expect(term).not.toContain(":");
      expect(known.has(term.replace(/^\+/, ""))).toBe(true);
    }
  });

  it("ranks bitrate above codec identity", () => {
    const terms = AUDIO_FORMAT_SORT.split(",");
    expect(terms.indexOf("abr")).toBeLessThan(terms.indexOf("acodec"));
  });

  it("keeps YouTube selection codec-neutral so bitrate wins", () => {
    expect(YOUTUBE_AUDIO_FORMAT_SELECTOR).toBe("bestaudio/best");
    expect(YOUTUBE_AUDIO_FORMAT_SELECTOR).not.toContain("acodec");
    expect(AUDIO_FORMAT_SORT.split(",")).toEqual([
      "abr",
      "asr",
      "channels",
      "acodec",
    ]);
  });
});

describe("youtubeExtractorArgs", () => {
  it("requests clients that can see Premium itags", () => {
    delete process.env.YT_PLAYER_CLIENTS;
    expect(youtubeExtractorArgs()).toBe(
      `youtube:player_client=${DEFAULT_YOUTUBE_PLAYER_CLIENTS}`,
    );
    expect(DEFAULT_YOUTUBE_PLAYER_CLIENTS).toContain("web_music");
    // android_vr still serves itag 251 without a PO token; bare tv is DRM-locked.
    expect(DEFAULT_YOUTUBE_PLAYER_CLIENTS).toContain("android_vr");
    expect(DEFAULT_YOUTUBE_PLAYER_CLIENTS.split(",")).not.toContain("tv");
  });

  it("is overridable when YouTube changes which clients work", () => {
    process.env.YT_PLAYER_CLIENTS = "tv";
    expect(youtubeExtractorArgs()).toBe("youtube:player_client=tv");
    delete process.env.YT_PLAYER_CLIENTS;
  });
});

describe("audioQualityLabel", () => {
  it("reports a genuine lossless passthrough", () => {
    expect(audioQualityLabel("wav", "pcm_s16le", "in.wav", 21000)).toBe(
      "Lossless (original PCM_S16LE)",
    );
  });

  it("refuses to call a rewrapped lossy stream lossless", () => {
    // Exactly the GLOSS case: ALAC container, 16.2 kHz of actual content.
    const label = audioQualityLabel("alac", "alac", "in.m4a", 16233);
    expect(label).toContain("lossy source rewrapped");
    expect(label).toContain("16.2 kHz");
    expect(label.toLowerCase()).not.toContain("lossless");
  });

  it("does not misfire on a real lossless master", () => {
    expect(audioQualityLabel("flac", "flac", "in.flac", 21500)).toBe(
      "Lossless (original FLAC)",
    );
  });

  it("notes the cutoff when converting a known-lossy source", () => {
    const label = audioQualityLabel("flac", "aac", "in.m4a", 16200);
    expect(label).toContain("no quality gain");
    expect(label).toContain("16.2 kHz");
  });

  it("still works when no cutoff was measured", () => {
    expect(audioQualityLabel("alac", "alac", "in.m4a")).toBe(
      "Lossless (original ALAC)",
    );
  });
});
