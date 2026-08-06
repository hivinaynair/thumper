import { describe, expect, it } from "bun:test";
import { queryFromWavFilename } from "./retag-search";

describe("queryFromWavFilename", () => {
  it("strips extension and normalizes separators", () => {
    expect(queryFromWavFilename("Artist_-_Track_Title.wav")).toBe(
      "Artist - Track Title",
    );
  });

  it("drops trailing free-download / format tags", () => {
    expect(queryFromWavFilename("Oppidan - Borne (Free Download).wav")).toBe(
      "Oppidan - Borne",
    );
    expect(queryFromWavFilename("Track Name HQ.wav")).toBe("Track Name");
  });

  it("ignores path prefixes", () => {
    expect(queryFromWavFilename("/tmp/foo/Bar - Baz.wav")).toBe("Bar - Baz");
  });
});
