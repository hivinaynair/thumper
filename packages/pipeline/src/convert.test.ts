import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  buildFfmpegArgs,
  buildMp3TagArgs,
  convertAudio,
  hasAttachedArtwork,
  loudnessGainDb,
  lossyFilterArgs,
  lossyProcessingPlan,
  probeAudio,
  tagMp3Copy,
  TARGET_LUFS,
  SAMPLE_PEAK_CEILING_DB,
  type AudioProbe,
} from "./convert";

describe("loudnessGainDb", () => {
  it("leaves a hot master alone when it has peak headroom", () => {
    // −5.7 LUFS is a real measurement from a crushed SoundCloud stream. It sits
    // well above the target, but loudness gain is boost-only: electronic
    // masters are deliberately hot and are not pulled down to match.
    expect(
      loudnessGainDb({ integratedLufs: -5.7, samplePeakDb: -2 }),
    ).toBeNull();
  });

  it("still attenuates a hot master whose decode would clip on write", () => {
    // The one case allowed to reduce level, and it is not a loudness decision:
    // writing a +2.8 dBFS overshoot to integer PCM clips it flat, adding
    // distortion that was never in the master.
    const gain = loudnessGainDb({ integratedLufs: -5.7, samplePeakDb: 2.8 });
    expect(gain).toBeCloseTo(SAMPLE_PEAK_CEILING_DB - 2.8, 3);
    expect(gain!).toBeLessThan(0);
  });

  it("boosts a quiet track only as far as peak headroom allows", () => {
    // Wants +5 LU, but sample peak is already at −1.5 dBFS, so only 1.4 dB of
    // room exists under the ceiling. Reaching the target would need a limiter.
    const gain = loudnessGainDb({ integratedLufs: -14, samplePeakDb: -1.5 });
    expect(gain).toBeCloseTo(1.4, 3);
  });

  it("never limits — a dynamic track stays quiet rather than being squashed", () => {
    const gain = loudnessGainDb({ integratedLufs: -20, samplePeakDb: -0.1 });
    // Zero headroom left, and the 11 LU shortfall is simply not taken.
    expect(gain).toBeNull();
  });

  it("attenuates exactly to the ceiling, no further", () => {
    // The minimum reduction that keeps the decode out of the clamp.
    const gain = loudnessGainDb({ integratedLufs: -9, samplePeakDb: 0.8 });
    expect(gain).toBeCloseTo(SAMPLE_PEAK_CEILING_DB - 0.8, 3);
    expect(gain!).toBeLessThan(0);
  });

  it("skips inaudibly small corrections", () => {
    expect(
      loudnessGainDb({ integratedLufs: -9.05, samplePeakDb: -3 }),
    ).toBeNull();
  });

  it("never returns a positive gain that would overshoot the target", () => {
    // A track sitting exactly on target with plenty of headroom must not be
    // pushed further just because room exists.
    expect(
      loudnessGainDb({ integratedLufs: -9, samplePeakDb: -12 }),
    ).toBeNull();
  });

  it("ignores a silent file", () => {
    expect(
      loudnessGainDb({ integratedLufs: -Infinity, samplePeakDb: -Infinity }),
    ).toBeNull();
    expect(
      loudnessGainDb({ integratedLufs: Number.NaN, samplePeakDb: -3 }),
    ).toBeNull();
  });

  it("leaves an unmeasured file alone rather than guessing", () => {
    // null means measurement failed. Treating it as a hot file would attenuate
    // every track whose analysis happened to error.
    expect(
      loudnessGainDb({ integratedLufs: null, samplePeakDb: -3 }),
    ).toBeNull();
    expect(
      loudnessGainDb({ integratedLufs: -9, samplePeakDb: null }),
    ).toBeNull();
  });
});

describe("lossyProcessingPlan", () => {
  it("limits an overshooting stream instead of lowering the whole track", () => {
    const plan = lossyProcessingPlan(
      { integratedLufs: -7.6, samplePeakDb: 1 },
      true,
    );

    expect(plan).toEqual({ gainDb: null, peakLimited: true });
    expect(lossyFilterArgs(plan)).toEqual([
      "-af",
      "alimiter=limit=0.988553:attack=0.1:release=1:level=false:latency=true",
    ]);
  });

  it("does not limit a stream that already fits in integer PCM", () => {
    // −0.05 dBFS is above the −0.1 write margin but will not clamp on encode.
    // The 5/50 limiter used to fire here and duck every near-full-scale kick.
    const plan = lossyProcessingPlan(
      { integratedLufs: -7.6, samplePeakDb: -0.05 },
      true,
    );
    expect(plan).toEqual({ gainDb: null, peakLimited: false });
    expect(lossyFilterArgs(plan)).toEqual([]);
  });

  it("does not limit a file sitting exactly at 0 dBFS", () => {
    const plan = lossyProcessingPlan(
      { integratedLufs: -7.6, samplePeakDb: 0 },
      true,
    );
    expect(plan).toEqual({ gainDb: null, peakLimited: false });
  });

  it("keeps clean boost below the ceiling without invoking the limiter", () => {
    const plan = lossyProcessingPlan(
      { integratedLufs: -14, samplePeakDb: -3 },
      true,
    );

    expect(plan).toEqual({ gainDb: 2.9, peakLimited: false });
    expect(lossyFilterArgs(plan)).toEqual(["-af", "volume=2.9dB"]);
  });

  it("retains whole-track safety attenuation when limiting is disabled", () => {
    const plan = lossyProcessingPlan(
      { integratedLufs: -7.6, samplePeakDb: 1 },
      false,
    );

    expect(plan).toEqual({ gainDb: -1.1, peakLimited: false });
    expect(lossyFilterArgs(plan)).toEqual(["-af", "volume=-1.1dB"]);
  });

  it("does not guess when loudness measurement failed", () => {
    expect(
      lossyProcessingPlan({ integratedLufs: null, samplePeakDb: 1 }, true),
    ).toEqual({ gainDb: null, peakLimited: false });
  });
});

describe("lossless WAV to FLAC", () => {
  it("keeps the source layout unfiltered while mapping metadata and artwork", () => {
    const probe: AudioProbe = {
      codec: "pcm_s24le",
      channels: 1,
      sampleRate: "96000",
      bitRate: "2304000",
      sampleFmt: "s32",
      bitsPerRawSample: 24,
    };

    const args = buildFfmpegArgs(
      {
        inputPath: "/tmp/artist-original.wav",
        outputPath: "/tmp/artist-original.flac",
        target: "flac",
        title: "Original title",
        artist: "Original artist",
        album: "Original album",
        genre: "Electronic",
        date: "2026",
        artworkPath: "/tmp/artwork.jpg",
      },
      probe,
      { gainDb: null, peakLimited: false },
    );

    expect(args).toEqual([
      "-y",
      "-i",
      "/tmp/artist-original.wav",
      "-i",
      "/tmp/artwork.jpg",
      "-map",
      "0:a:0",
      "-map",
      "1:0",
      "-c:a",
      "flac",
      "-compression_level",
      "8",
      "-ar",
      "96000",
      "-ac",
      "1",
      "-c:v",
      "mjpeg",
      "-disposition:v:0",
      "attached_pic",
      "-metadata",
      "title=Original title",
      "-metadata",
      "artist=Original artist",
      "-metadata",
      "album=Original album",
      "-metadata",
      "genre=Electronic",
      "-metadata",
      "date=2026",
      "/tmp/artist-original.flac",
    ]);
    expect(args).not.toContain("-af");
    expect(args.join(" ")).not.toMatch(/volume|alimiter|pcm_s16/);
  });

  it("preserves 24 meaningful bits through a real FFmpeg conversion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumper-convert-"));
    const inputPath = path.join(dir, "artist-original.wav");
    const outputPath = path.join(dir, "artist-original.flac");

    try {
      const generated = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=1000:duration=0.1:sample_rate=96000",
          "-c:a",
          "pcm_s24le",
          "-ac",
          "1",
          "-y",
          inputPath,
        ],
        { encoding: "utf8" },
      );
      if (generated.status !== 0) {
        throw new Error(
          `ffmpeg failed to create 24-bit WAV: ${generated.stderr || generated.status}`,
        );
      }

      await convertAudio({ inputPath, outputPath, target: "flac" });

      const outputProbe = await probeAudio(outputPath);
      expect(outputProbe.codec).toBe("flac");
      expect(outputProbe.sampleRate).toBe("96000");
      expect(outputProbe.channels).toBe(1);
      expect(outputProbe.bitsPerRawSample).toBe(24);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("artist-original MP3 tagging", () => {
  it("copies audio and embeds ID3v2.3 tags plus artwork without filters", () => {
    const args = buildMp3TagArgs({
      inputPath: "/tmp/artist-original.mp3",
      outputPath: "/tmp/artist-original-tagged.mp3",
      title: "Original title",
      artist: "Original artist",
      album: "Original album",
      genre: "Electronic",
      date: "2026",
      artworkPath: "/tmp/artwork.jpg",
    });

    expect(args).toEqual([
      "-y",
      "-i",
      "/tmp/artist-original.mp3",
      "-i",
      "/tmp/artwork.jpg",
      "-map",
      "0:a:0",
      "-map",
      "1:0",
      "-c:a",
      "copy",
      "-c:v",
      "mjpeg",
      "-disposition:v:0",
      "attached_pic",
      "-id3v2_version",
      "3",
      "-metadata",
      "title=Original title",
      "-metadata",
      "artist=Original artist",
      "-metadata",
      "album=Original album",
      "-metadata",
      "genre=Electronic",
      "-metadata",
      "date=2026",
      "/tmp/artist-original-tagged.mp3",
    ]);
    expect(args.join(" ")).not.toMatch(/volume|alimiter|-af /);
  });

  it("copies audio and writes text tags when no artwork is available", () => {
    const args = buildMp3TagArgs({
      inputPath: "/tmp/artist-original.mp3",
      outputPath: "/tmp/artist-original-tagged.mp3",
      title: "Original title",
      artist: "Original artist",
    });

    expect(args).toEqual([
      "-y",
      "-i",
      "/tmp/artist-original.mp3",
      "-c:a",
      "copy",
      "-id3v2_version",
      "3",
      "-metadata",
      "title=Original title",
      "-metadata",
      "artist=Original artist",
      "/tmp/artist-original-tagged.mp3",
    ]);
  });

  it("probes attached artwork and embeds a cover on a real MP3 copy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumper-mp3-tag-"));
    const inputPath = path.join(dir, "artist-original.mp3");
    const artworkPath = path.join(dir, "cover.jpg");
    const outputPath = path.join(dir, "tagged.mp3");

    try {
      const audio = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=1000:duration=0.2:sample_rate=44100",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "192k",
          "-y",
          inputPath,
        ],
        { encoding: "utf8" },
      );
      if (audio.status !== 0) {
        throw new Error(
          `ffmpeg failed to create MP3: ${audio.stderr || audio.status}`,
        );
      }
      const cover = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:s=64x64:d=0.1",
          "-frames:v",
          "1",
          "-y",
          artworkPath,
        ],
        { encoding: "utf8" },
      );
      if (cover.status !== 0) {
        throw new Error(
          `ffmpeg failed to create cover: ${cover.stderr || cover.status}`,
        );
      }

      expect(await hasAttachedArtwork(inputPath)).toBe(false);
      await tagMp3Copy({
        inputPath,
        outputPath,
        title: "Five Hours",
        artist: "Darby",
        artworkPath,
      });
      expect(await hasAttachedArtwork(outputPath)).toBe(true);

      const tagged = await probeAudio(outputPath);
      expect(tagged.codec).toBe("mp3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
