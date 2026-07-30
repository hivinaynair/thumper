import { describe, expect, it } from "bun:test";
import { scoreMirrorCandidate, type MirrorCandidate } from "./match";
import { ratio, slugify } from "./similarity";
import type { SpotifyTrackMeta } from "./spotify";

describe("similarity", () => {
  it("slugifies and ratios close titles", () => {
    expect(slugify("Hello & Goodbye!")).toBe("hello-and-goodbye");
    expect(ratio("blinding-lights", "blinding-lights")).toBe(100);
    expect(ratio("Blinding Lights", "Blinding Lightz")).toBeGreaterThan(80);
  });
});

describe("scoreMirrorCandidate", () => {
  const track: SpotifyTrackMeta = {
    title: "Blinding Lights",
    artists: ["The Weeknd"],
    durationMs: 200_000,
    spotifyUrl: "https://open.spotify.com/track/x",
  };

  it("scores a good official-audio hit highly", () => {
    const candidate: MirrorCandidate = {
      url: "https://www.youtube.com/watch?v=good",
      title: "The Weeknd - Blinding Lights (Official Audio)",
      uploader: "The Weeknd",
      durationSec: 201,
      views: 100_000_000,
      source: "youtube",
    };
    const scored = scoreMirrorCandidate(track, candidate);
    expect(scored.score).toBeGreaterThanOrEqual(78);
  });

  it("rejects live covers with wrong duration", () => {
    const candidate: MirrorCandidate = {
      url: "https://www.youtube.com/watch?v=bad",
      title: "Blinding Lights LIVE cover karaoke",
      uploader: "RandomCoverChannel",
      durationSec: 420,
      views: 500,
      source: "youtube",
    };
    const scored = scoreMirrorCandidate(track, candidate);
    expect(scored.score).toBeLessThan(78);
  });
});
