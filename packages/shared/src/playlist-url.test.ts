import { describe, expect, it } from "bun:test";
import { isPlaylistUrl } from "./index";

describe("isPlaylistUrl", () => {
  it("detects YouTube playlists", () => {
    expect(
      isPlaylistUrl("https://youtube.com/playlist?list=PLU2N0DH_rOrxexUrD"),
    ).toBe(true);
    expect(
      isPlaylistUrl("https://www.youtube.com/watch?v=abc123&list=PLxyz"),
    ).toBe(true);
  });

  it("detects SoundCloud sets and Spotify collections", () => {
    expect(isPlaylistUrl("https://soundcloud.com/artist/sets/my-ep")).toBe(true);
    expect(isPlaylistUrl("https://open.spotify.com/playlist/abc")).toBe(true);
    expect(isPlaylistUrl("https://open.spotify.com/album/abc")).toBe(true);
  });

  it("does not flag single tracks", () => {
    expect(isPlaylistUrl("https://www.youtube.com/watch?v=62i7zHtmsTA")).toBe(
      false,
    );
    expect(isPlaylistUrl("https://soundcloud.com/artist/a-track")).toBe(false);
    expect(isPlaylistUrl("https://open.spotify.com/track/abc")).toBe(false);
    expect(isPlaylistUrl("not a url")).toBe(false);
  });
});
