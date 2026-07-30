import { describe, expect, it } from "vitest";
import { detectSourceKind, sanitizeFilename } from "./index";

describe("detectSourceKind", () => {
  it("detects youtube", () => {
    expect(detectSourceKind("https://www.youtube.com/watch?v=abc")).toBe(
      "youtube",
    );
    expect(detectSourceKind("https://youtu.be/abc")).toBe("youtube");
  });

  it("detects soundcloud and spotify", () => {
    expect(detectSourceKind("https://soundcloud.com/x/y")).toBe("soundcloud");
    expect(detectSourceKind("https://open.spotify.com/track/1")).toBe("spotify");
  });

  it("returns null for unknown", () => {
    expect(detectSourceKind("https://example.com")).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("strips illegal characters", () => {
    expect(sanitizeFilename('a/b:c*d?.wav')).toBe("abcd.wav");
  });
});
