import { describe, expect, it } from "bun:test";
import { uniqueZipNames } from "./names";

describe("uniqueZipNames", () => {
  it("leaves distinct names alone", () => {
    expect(uniqueZipNames(["a.flac", "b.flac"])).toEqual(["a.flac", "b.flac"]);
  });

  it("suffixes collisions before the extension", () => {
    expect(uniqueZipNames(["a.flac", "a.flac", "a.flac"])).toEqual([
      "a.flac",
      "a (2).flac",
      "a (3).flac",
    ]);
  });

  it("suffixes extensionless names at the end", () => {
    expect(uniqueZipNames(["track", "track"])).toEqual(["track", "track (2)"]);
  });

  it("flattens path separators so entries can't escape the archive root", () => {
    expect(uniqueZipNames(["../../etc/passwd"])).toEqual([".._.._etc_passwd"]);
  });

  it("falls back to a name for empty filenames", () => {
    expect(uniqueZipNames([""])).toEqual(["track"]);
  });
});
