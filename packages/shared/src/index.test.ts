import { describe, expect, it } from "bun:test";
import {
  detectSourceKind,
  isPlaylistUrl,
  isSupportedSource,
  looksLikePlaylistUrl,
  sanitizeFilename,
  trackDisplayName,
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

describe("trackDisplayName", () => {
  it("drops a leading artist when the title already credits them", () => {
    expect(
      trackDisplayName("grayshift", "benny benassi - cinema (grayshift remix)"),
    ).toBe("benny benassi - cinema (grayshift remix)");
    expect(
      trackDisplayName("MAXARKA", "Baby - Prospa (MAXARKA UKG DUB)"),
    ).toBe("Baby - Prospa (MAXARKA UKG DUB)");
    expect(
      trackDisplayName("bread.man", "RUNAWAY (BREAD.MAN REMIX)"),
    ).toBe("RUNAWAY (BREAD.MAN REMIX)");
  });

  it("keeps Artist - Title when the title does not mention the artist", () => {
    expect(trackDisplayName("Oppidan", "Borne")).toBe("Oppidan - Borne");
  });
});

describe("bandcamp support", () => {
  it("detects and accepts Bandcamp URLs", () => {
    const url = "https://inrotation.bandcamp.com/track/short-trips";
    expect(detectSourceKind(url)).toBe("bandcamp");
    expect(isSupportedSource(url)).toBe(true);
  });

  it("treats an album as a playlist but a track as one song", () => {
    expect(
      isPlaylistUrl("https://inrotation.bandcamp.com/album/short-trips-ep"),
    ).toBe(true);
    expect(
      isPlaylistUrl("https://inrotation.bandcamp.com/track/short-trips"),
    ).toBe(false);
  });
});
