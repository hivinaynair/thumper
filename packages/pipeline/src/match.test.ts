import { describe, expect, it } from "bun:test";
import {
  MIN_MATCH_SCORE,
  scoreMirrorCandidate,
  type MirrorCandidate,
} from "./match";
import { splitArtistNames } from "./metadata";
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

  it("accepts a perfect artist/title hit when duration is unknown", () => {
    // Geo-blocked SoundCloud tracks only expose a 30s preview length, which
    // resolveSoundCloudMeta drops — matching must still clear the threshold.
    const noDuration: SpotifyTrackMeta = {
      title: "Gravity",
      artists: ["Oppidan", "Hans Glader"],
    };
    const candidate: MirrorCandidate = {
      url: "https://www.youtube.com/watch?v=grav",
      title: "Gravity",
      uploader: "Oppidan",
      durationSec: 188,
      views: 50_000,
      source: "youtube",
    };
    const scored = scoreMirrorCandidate(noDuration, candidate);
    expect(scored.score).toBeGreaterThanOrEqual(78);
  });

  it("does not trust a 30s preview length against a full YouTube upload", () => {
    const previewDuration: SpotifyTrackMeta = {
      title: "Gravity",
      artists: ["Oppidan"],
      durationMs: 30_000,
    };
    const candidate: MirrorCandidate = {
      url: "https://www.youtube.com/watch?v=grav",
      title: "Gravity",
      uploader: "Oppidan",
      durationSec: 188,
      views: 50_000,
      source: "youtube",
    };
    const scored = scoreMirrorCandidate(previewDuration, candidate);
    expect(scored.score).toBe(0);
  });
});

// SoundCloud never gives us a usable duration for the tracks that need a mirror
// most: geo-blocked ones extract no metadata at all, and preview-only ones
// report 30s. Blending a neutral time score into those capped every candidate
// at 77.5 — permanently under the confidence gate — so a perfect match was
// rejected just as readily as a karaoke cover.
describe("scoreMirrorCandidate without a known duration", () => {
  const track: SpotifyTrackMeta = {
    title: "Take Me Under",
    artists: ["Daniel Allan", "Liv Grace Blue"],
  };

  it("accepts an exact artist + title match", () => {
    const scored = scoreMirrorCandidate(track, {
      url: "https://www.youtube.com/watch?v=exact",
      title: "Take Me Under",
      uploader: "Daniel Allan",
      durationSec: 0,
      views: 11_800,
      source: "youtube",
    });
    expect(scored.score).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
  });

  it("still rejects a different song by the same artist", () => {
    const scored = scoreMirrorCandidate(track, {
      url: "https://www.youtube.com/watch?v=other",
      title: "Daniel Allan - I Just Need (with Lyrah)",
      uploader: "Daniel Allan",
      durationSec: 0,
      views: 900_000,
      source: "youtube",
    });
    expect(scored.score).toBeLessThan(MIN_MATCH_SCORE);
  });

  it("still rejects a remix of the right song", () => {
    const scored = scoreMirrorCandidate(track, {
      url: "https://www.youtube.com/watch?v=remix",
      title: "Daniel Allan - Take Me Under (Showboats Remix)",
      uploader: "Onda Sonora Músicas",
      durationSec: 0,
      views: 4_000,
      source: "youtube",
    });
    expect(scored.score).toBeLessThan(MIN_MATCH_SCORE);
  });

  it("matches a collaboration once the credit is split into artists", () => {
    const collab: SpotifyTrackMeta = {
      title: "Gravity",
      artists: splitArtistNames("Oppidan and Hans Glader"),
    };
    const scored = scoreMirrorCandidate(collab, {
      url: "https://www.youtube.com/watch?v=gravity",
      title: "Gravity",
      uploader: "Oppidan",
      durationSec: 0,
      views: 48_000,
      source: "youtube",
    });
    expect(scored.score).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
  });
});

describe("splitArtistNames", () => {
  it("splits the separators SoundCloud credits actually use", () => {
    expect(splitArtistNames("Oppidan and Hans Glader")).toEqual([
      "Oppidan",
      "Hans Glader",
    ]);
    expect(splitArtistNames("Daniel Allan, Liv Grace Blue")).toEqual([
      "Daniel Allan",
      "Liv Grace Blue",
    ]);
    // yt-dlp escapes commas as U+FF0C when it flattens its `artists` list.
    expect(splitArtistNames("Daniel Allan， Liv Grace Blue")).toEqual([
      "Daniel Allan",
      "Liv Grace Blue",
    ]);
    expect(splitArtistNames("Oppidan feat. Strategy")).toEqual([
      "Oppidan",
      "Strategy",
    ]);
    expect(splitArtistNames("Hans Glader & Isenberg")).toEqual([
      "Hans Glader",
      "Isenberg",
    ]);
  });

  it("keeps band names that merely contain a separator word", () => {
    expect(splitArtistNames("Florence and the Machine")).toEqual([
      "Florence and the Machine",
    ]);
    expect(splitArtistNames("AC/DC")).toEqual(["AC/DC"]);
    expect(splitArtistNames("")).toEqual([]);
  });
});
