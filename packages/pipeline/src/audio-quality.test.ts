import { describe, expect, it } from "bun:test";
import { withoutPreview } from "./audio-quality";

describe("withoutPreview", () => {
  it("excludes preview format ids", () => {
    const out = withoutPreview("bestaudio[ext=wav]/bestaudio/best");
    expect(out).toContain("format_id!*=preview");
    expect(out).toContain("bestaudio[format_id!*=preview]/bestaudio/best");
  });
});
