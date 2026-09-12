import { describe, expect, it } from "bun:test";
import { classifyStemFile, parseSeparationProgress } from "./separate";

describe("classifyStemFile", () => {
  it("reads the role marker audio-separator writes", () => {
    expect(
      classifyStemFile(
        "track_(Instrumental)_melband_roformer_instvox_duality_v2.flac",
      ),
    ).toBe("instrumental");
    expect(
      classifyStemFile(
        "track_(Vocals)_melband_roformer_instvox_duality_v2.flac",
      ),
    ).toBe("vocals");
  });

  it("still classifies when the model suffix was truncated at a dot", () => {
    // audio-separator cuts the model name at its first ".", so a checkpoint
    // named `..._sdr_12.9755.ckpt` lands as `..._sdr_12`. The role marker is
    // the only stable part of the name.
    expect(
      classifyStemFile("track_(Instrumental)_model_bs_roformer_ep_317_sdr_12.flac"),
    ).toBe("instrumental");
  });

  it("ignores unrelated files left in the output directory", () => {
    expect(classifyStemFile("track.flac")).toBeNull();
    expect(classifyStemFile("log.txt")).toBeNull();
    expect(classifyStemFile("input_1234.wav")).toBeNull();
  });

  it("matches regardless of case", () => {
    expect(classifyStemFile("t_(instrumental)_m.flac")).toBe("instrumental");
    expect(classifyStemFile("t_(VOCALS)_m.flac")).toBe("vocals");
  });
});

describe("parseSeparationProgress", () => {
  it("reads the tqdm chunk ratio", () => {
    expect(
      parseSeparationProgress(" 27%|██▋       | 20/73 [02:52<09:50, 11.14s/it]"),
    ).toBeCloseTo(20 / 73);
  });

  it("takes the last ratio when several are buffered together", () => {
    const chunk =
      "  1%|▏ | 1/73 [00:09<11:11,  9.32s/it]" +
      "  3%|▎ | 2/73 [00:16<09:49,  8.31s/it]" +
      "  4%|▍ | 3/73 [00:24<09:19,  7.99s/it]";
    expect(parseSeparationProgress(chunk)).toBeCloseTo(3 / 73);
  });

  it("clamps to 1 and never exceeds it", () => {
    expect(parseSeparationProgress("100%|██| 73/73 [12:00<00:00]")).toBe(1);
    expect(parseSeparationProgress("| 80/73 [12:00<00:00]")).toBe(1);
  });

  it("returns null for output carrying no ratio", () => {
    expect(parseSeparationProgress("Loading model ...")).toBeNull();
    expect(parseSeparationProgress("")).toBeNull();
    // A download line reports bytes, not chunks — must not read as progress.
    expect(parseSeparationProgress(" 36%|███▌ | 618M/1.72G [04:36<44:05]")).toBeNull();
  });
});
