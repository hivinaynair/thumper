import { describe, expect, it } from "bun:test";
import { sniffAudioExt } from "./hypeddit";

describe("sniffAudioExt", () => {
  it("detects WAV (RIFF/WAVE)", () => {
    const buf = new Uint8Array(12);
    buf.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffAudioExt(buf)).toBe("wav");
  });

  it("detects MP3 (ID3 and frame sync)", () => {
    const id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);
    expect(sniffAudioExt(id3)).toBe("mp3");
    const frame = new Uint8Array([0xff, 0xfb, 0xe4, 0x44, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffAudioExt(frame)).toBe("mp3");
  });

  it("detects FLAC", () => {
    const buf = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffAudioExt(buf)).toBe("flac");
  });
});
