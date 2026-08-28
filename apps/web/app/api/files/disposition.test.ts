import { describe, expect, it } from "bun:test";
import { contentDispositionAttachment } from "./disposition";

describe("contentDispositionAttachment", () => {
  it("keeps a YouTube curly apostrophe out of the HTTP header", () => {
    const filename =
      "Odd Mob, OMNOM, HYPERBEAM - Coming Up (It\u2019s Dare).flac";

    const value = contentDispositionAttachment(filename);

    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain("%E2%80%99");
    expect(value).toMatch(/filename="[^"]*It's Dare[^"]*"/);
  });

  it("strips quotes so the fallback filename stays a valid quoted-string", () => {
    const value = contentDispositionAttachment('Artist - "Track".flac');
    expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
    expect(value).toContain('filename="Artist - Track.flac"');
  });
});
