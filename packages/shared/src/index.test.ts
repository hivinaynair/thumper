import { describe, expect, it } from "bun:test";
import {
  detectSourceKind,
  isSupportedSource,
  looksLikePlaylistUrl,
  sanitizeFilename,
} from "./index";

describe("detectSourceKind", () => {
  it("detects youtube and soundcloud", () => {
    expect(detectSourceKind("https://www.youtube.com/watch?v=abc")).toBe(
      "youtube",
    );
    expect(detectSourceKind("https://soundcloud.com/x/y")).toBe("soundcloud");
  });
});

describe("isSupportedSource", () => {
  it("allows youtube and soundcloud only", () => {
    expect(isSupportedSource("https://youtu.be/abc")).toBe(true);
    expect(isSupportedSource("https://soundcloud.com/a/b")).toBe(true);
    expect(isSupportedSource("https://open.spotify.com/track/1")).toBe(false);
    expect(isSupportedSource("https://patreon.com/x")).toBe(false);
  });
});

describe("looksLikePlaylistUrl", () => {
  it("detects youtube and soundcloud playlists", () => {
    expect(
      looksLikePlaylistUrl(
        "https://www.youtube.com/playlist?list=PLxxxxxxxx",
      ),
    ).toBe(true);
    expect(
      looksLikePlaylistUrl(
        "https://www.youtube.com/watch?v=abc&list=PLxxxxxxxx",
      ),
    ).toBe(true);
    expect(
      looksLikePlaylistUrl("https://soundcloud.com/artist/sets/my-set"),
    ).toBe(true);
    expect(looksLikePlaylistUrl("https://www.youtube.com/watch?v=abc")).toBe(
      false,
    );
  });
});

describe("sanitizeFilename", () => {
  it("strips illegal characters", () => {
    expect(sanitizeFilename("a/b:c*d?.wav")).toBe("abcd.wav");
  });
});
