import { describe, expect, it } from "bun:test";
import { artistOriginalAction } from "./artist-original";

describe("artistOriginalAction", () => {
  const cases = [
    {
      name: "original wav",
      input: { artistOriginal: true, extension: "wav" },
      expected: "convert-wav",
    },
    {
      name: "original uppercase wav",
      input: { artistOriginal: true, extension: "WAV" },
      expected: "convert-wav",
    },
    {
      name: "original dotted wav",
      input: { artistOriginal: true, extension: ".wav" },
      expected: "convert-wav",
    },
    {
      name: "original dotted uppercase wav",
      input: { artistOriginal: true, extension: ".WAV" },
      expected: "convert-wav",
    },
    {
      name: "original mp3",
      input: { artistOriginal: true, extension: "mp3" },
      expected: "preserve-original",
    },
    {
      name: "original aiff",
      input: { artistOriginal: true, extension: "aiff" },
      expected: "preserve-original",
    },
    {
      name: "original aif",
      input: { artistOriginal: true, extension: "aif" },
      expected: "preserve-original",
    },
    {
      name: "original flac",
      input: { artistOriginal: true, extension: "flac" },
      expected: "preserve-original",
    },
    {
      name: "original m4a",
      input: { artistOriginal: true, extension: "m4a" },
      expected: "preserve-original",
    },
    {
      name: "original unknown format",
      input: { artistOriginal: true, extension: "unknown" },
      expected: "preserve-original",
    },
    {
      name: "non-original wav",
      input: { artistOriginal: false, extension: "wav" },
      expected: "normal-conversion",
    },
    {
      name: "non-original mp3",
      input: { artistOriginal: false, extension: "mp3" },
      expected: "normal-conversion",
    },
  ] as const;

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(artistOriginalAction(input)).toBe(expected);
    });
  }
});
