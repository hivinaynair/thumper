import { describe, expect, it } from "bun:test";
import { queryFromAudioFilename } from "./retag-search";

describe("queryFromAudioFilename", () => {
  it("strips extension and normalizes separators", () => {
    expect(queryFromAudioFilename("Artist_-_Track_Title.wav")).toBe(
      "Artist - Track Title",
    );
  });

  it("drops trailing free-download / format tags", () => {
    expect(queryFromAudioFilename("Oppidan - Borne (Free Download).wav")).toBe(
      "Oppidan - Borne",
    );
    expect(queryFromAudioFilename("MPH - Swoon (free DL).wav")).toBe(
      "MPH - Swoon",
    );
    expect(queryFromAudioFilename("Track Name HQ.wav")).toBe("Track Name");
  });

  it("ignores path prefixes", () => {
    expect(queryFromAudioFilename("/tmp/foo/Bar - Baz.wav")).toBe("Bar - Baz");
  });
});

describe("queryFromAudioFilename across formats", () => {
  it("strips every accepted extension, not just .wav", () => {
    // Retag used to be WAV-only; these silently kept the extension in the
    // search query and poisoned the match.
    expect(queryFromAudioFilename("MPH - Swoon.mp3")).toBe("MPH - Swoon");
    expect(queryFromAudioFilename("MPH - Swoon.m4a")).toBe("MPH - Swoon");
    expect(queryFromAudioFilename("MPH - Swoon.flac")).toBe("MPH - Swoon");
    expect(queryFromAudioFilename("MPH - Swoon.aiff")).toBe("MPH - Swoon");
  });
});
