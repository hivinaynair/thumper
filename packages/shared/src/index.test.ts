import { describe, expect, it } from "bun:test";
import {
  detectSourceKind,
  isSupportedSource,
  looksLikePlaylistUrl,
  sanitizeFilename,
} from "./index";

describe("detectSourceKind", () => {
  it("detects youtube soundcloud spotify", () => {
    expect(detectSourceKind("https://www.youtube.com/watch?v=abc")).toBe(
      "youtube",
    );
    expect(detectSourceKind("https://soundcloud.com/x/y")).toBe("soundcloud");
    expect(detectSourceKind("https://open.spotify.com/playlist/1")).toBe(
      "spotify",
    );
  });
});

describe("isSupportedSource", () => {
  it("allows youtube soundcloud spotify", () => {
    expect(isSupportedSource("https://youtu.be/abc")).toBe(true);
    expect(isSupportedSource("https://soundcloud.com/a/b")).toBe(true);
    expect(isSupportedSource("https://open.spotify.com/track/1")).toBe(true);
    expect(isSupportedSource("https://patreon.com/x")).toBe(false);
  });
});

describe("looksLikePlaylistUrl", () => {
  it("detects playlists including spotify", () => {
    expect(
      looksLikePlaylistUrl("https://open.spotify.com/playlist/abc"),
    ).toBe(true);
    expect(
      looksLikePlaylistUrl("https://www.youtube.com/playlist?list=PLxx"),
    ).toBe(true);
  });
});

describe("sanitizeFilename", () => {
  it("strips illegal characters", () => {
    expect(sanitizeFilename("a/b:c*d?.wav")).toBe("abcd.wav");
  });
});
