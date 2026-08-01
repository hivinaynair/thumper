import { describe, expect, it } from "bun:test";
import { sanitizeDriveFolderName } from "./drive";

describe("sanitizeDriveFolderName", () => {
  it("keeps a normal playlist title", () => {
    expect(sanitizeDriveFolderName("Happy House")).toBe("Happy House");
  });

  it("strips path separators that would confuse Drive", () => {
    // Only `/` and NUL are stripped; backslash is a legal Drive name char.
    expect(sanitizeDriveFolderName("a/b")).toBe("a b");
    expect(sanitizeDriveFolderName("Sets/House")).toBe("Sets House");
  });

  it("falls back when the title is empty after cleaning", () => {
    expect(sanitizeDriveFolderName("///")).toBe("Playlist");
    expect(sanitizeDriveFolderName("   ")).toBe("Playlist");
  });

  it("truncates very long titles", () => {
    const long = "x".repeat(300);
    expect(sanitizeDriveFolderName(long).length).toBe(180);
  });
});
