import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { classifyForDj, isClubReady } from "./audio-verify";
import { averageSpectrumDb, estimateCutoff } from "./spectrum";

/**
 * The bug these exist to prevent:
 *
 * `estimateCutoff` used to derive its noise floor from the top 4% of the
 * spectrum. MP3 output is exactly zero above its ~20.5 kHz band limit, so that
 * floor landed near −127 dB and numerical residue at the codec's band edge read
 * as music — every MP3 measured ~20.7 kHz whether it was 320 kbps or 64, and a
 * 128 kbps stream rewrapped as FLAC classified as `master`. The unit tests all
 * fed hand-built spectra and passed throughout.
 *
 * So these encode real audio at known bitrates and assert the verdict. Slower
 * than a synthetic spectrum, and the only kind of test that would have caught
 * it. ffmpeg is already a hard dependency of this package.
 */

const SAMPLE_RATE = 44100;
let dir: string;

function ffmpeg(args: string[]): void {
  const res = spawnSync("ffmpeg", ["-v", "error", ...args], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`ffmpeg failed: ${res.stderr || res.status}`);
  }
}

/** Pink noise: broadband, so an encoder's lowpass is unambiguous. */
function source(name: string, filters: string[] = []): string {
  const out = path.join(dir, name);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=d=6:c=pink:r=${SAMPLE_RATE}:a=0.5`,
    ...(filters.length ? ["-af", filters.join(",")] : []),
    "-c:a",
    "pcm_s16le",
    "-ac",
    "2",
    "-y",
    out,
  ]);
  return out;
}

function encode(input: string, name: string, codecArgs: string[]): string {
  const out = path.join(dir, name);
  ffmpeg(["-i", input, ...codecArgs, "-y", out]);
  return out;
}

function cutoffHzOf(file: string): number {
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 },
  );
  const samples = new Float32Array(
    res.stdout.buffer,
    res.stdout.byteOffset,
    Math.floor(res.stdout.length / 4),
  );
  const estimate = estimateCutoff(averageSpectrumDb(samples), SAMPLE_RATE);
  expect(estimate.detected).toBe(true);
  return estimate.cutoffHz;
}

let lossless: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumper-spectrum-"));
  lossless = source("lossless.wav");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("estimateCutoff on real encodes", () => {
  it("reports full band for lossless audio", () => {
    // The old floor-from-the-top approach measured the floor inside the music
    // here and reported 1.4 kHz — a master, rejected as unsuitable.
    expect(cutoffHzOf(lossless)).toBeGreaterThan(21000);
  });

  it("tracks MP3 bitrate instead of the codec's band edge", () => {
    const at = (kbps: number) =>
      cutoffHzOf(
        encode(lossless, `mp3_${kbps}.mp3`, [
          "-c:a",
          "libmp3lame",
          "-b:a",
          `${kbps}k`,
        ]),
      );

    const low = at(64);
    const mid = at(128);
    const high = at(320);

    // Previously all three measured an identical ~20.7 kHz.
    expect(low).toBeLessThan(14000);
    expect(mid).toBeGreaterThan(15000);
    expect(mid).toBeLessThan(18000);
    expect(high).toBeGreaterThan(19500);
  });

  it("keeps a dark master on the music side of the presence threshold", () => {
    // Heavy treble shelving puts 20 kHz ~57 dB under the midband. That is a
    // real master and must not read as a lowpass.
    const dark = source("dark.wav", [
      "treble=g=-25:f=6000:width_type=o:w=2",
      "treble=g=-25:f=9000:width_type=o:w=2",
    ]);
    expect(cutoffHzOf(dark)).toBeGreaterThan(19000);
  });
});

describe("club-ready gate on real encodes", () => {
  function tierOf(file: string, losslessContainer: boolean) {
    const cutoffHz = cutoffHzOf(file);
    return classifyForDj(
      {
        codec: losslessContainer ? "flac" : "mp3",
        sampleRate: SAMPLE_RATE,
        channels: 2,
        cutoffHz,
        cutoffRatio: cutoffHz / (SAMPLE_RATE / 2),
        losslessContainer,
        peakDb: -1,
        durationSec: 6,
      },
      // These fixtures stand in for artist-supplied files, so provenance is
      // granted and the spectrum is left as the only thing under test.
      { artistOriginal: true },
    );
  }

  it("accepts a genuine master", () => {
    const verdict = tierOf(lossless, true);
    expect(verdict.tier).toBe("master");
    expect(isClubReady(verdict.tier)).toBe(true);
  });

  it("rejects a lossy stream laundered into a lossless container", () => {
    // The case the whole module exists for: 128 kbps MP3 decoded and rewrapped
    // as FLAC. Every codec-name check passes; only the spectrum gives it away.
    // This classified as `master` before the rewrite.
    const mp3 = encode(lossless, "launder.mp3", [
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
    ]);
    const flac = encode(mp3, "laundered.flac", ["-c:a", "flac"]);

    const verdict = tierOf(flac, true);
    expect(isClubReady(verdict.tier)).toBe(false);
    expect(verdict.warnings.join(" ")).toContain("lossy stream");
  });
});
