import { runCommandBuffer, runCommandOk, type SpawnOptions } from "./process";
import { averageSpectrumDb, estimateCutoff } from "./spectrum";

/**
 * How usable a file is on a club system.
 *
 * Deliberately not the same question as "is the container lossless" — that
 * question is useless, because re-wrapping a 128 kbps stream as ALAC produces a
 * technically-lossless file containing lossy audio.
 */
export type DjTier = "master" | "club" | "marginal" | "unsuitable";

export type AudioAnalysis = {
  codec: string;
  sampleRate: number;
  channels: number;
  /** Container/stream reported bitrate in kbps, when available. */
  bitrateKbps: number | null;
  /** Highest frequency carrying real content. The number that actually matters. */
  cutoffHz: number;
  /** cutoffHz relative to Nyquist. ~1.0 means no artificial lowpass. */
  cutoffRatio: number;
  /** Peak level of the decoded float signal; may exceed 0 for lossy overshoot. */
  peakDb: number;
  /** True when the codec itself stores PCM or losslessly-compressed PCM. */
  losslessContainer: boolean;
};

export type DjVerdict = {
  tier: DjTier;
  /** One-line summary safe to show in the UI. */
  headline: string;
  /** Specific problems, most important first. Empty for a clean master. */
  warnings: string[];
  analysis: AudioAnalysis;
};

const LOSSLESS_CODECS = new Set([
  "flac",
  "alac",
  "wavpack",
  "tta",
  "ape",
  "pcm_s16le",
  "pcm_s24le",
  "pcm_s32le",
  "pcm_f32le",
  "pcm_s16be",
  "pcm_s24be",
]);

export function isLosslessCodec(codec: string): boolean {
  const c = codec.toLowerCase();
  return LOSSLESS_CODECS.has(c) || c.startsWith("pcm_") || c === "lpcm";
}

/** Seconds of audio to transform. Enough to average out quiet passages. */
const ANALYSIS_SECONDS = 90;

type ProbeResult = {
  codec: string;
  sampleRate: number;
  channels: number;
  bitrateKbps: number | null;
  durationSec: number;
};

async function probe(
  filePath: string,
  options: SpawnOptions,
): Promise<ProbeResult> {
  const { stdout } = await runCommandOk(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,channels,sample_rate,bit_rate:format=duration,bit_rate",
      "-of",
      "json",
      filePath,
    ],
    options,
  );
  const parsed = JSON.parse(stdout) as {
    streams?: Array<Record<string, string>>;
    format?: Record<string, string>;
  };
  const stream = parsed.streams?.[0] ?? {};
  const format = parsed.format ?? {};
  const rawBitrate =
    Number.parseInt(stream.bit_rate ?? "", 10) ||
    Number.parseInt(format.bit_rate ?? "", 10) ||
    0;

  return {
    codec: (stream.codec_name ?? "").toLowerCase(),
    sampleRate: Number.parseInt(stream.sample_rate ?? "", 10) || 44100,
    channels: Number.parseInt(stream.channels ?? "", 10) || 2,
    bitrateKbps: rawBitrate > 0 ? Math.round(rawBitrate / 1000) : null,
    durationSec: Number.parseFloat(format.duration ?? "") || 0,
  };
}

/** Decoded float peak. Exceeds 0 dB when a lossy decode overshoots full scale. */
export async function measurePeakDb(
  filePath: string,
  options: SpawnOptions,
): Promise<number> {
  try {
    // astats sees the float samples; volumedetect would clamp them to 0 dB and
    // hide exactly the overshoot we're looking for.
    const { stderr } = await runCommandBuffer(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        filePath,
        "-vn",
        "-af",
        "aformat=sample_fmts=fltp,astats=measure_overall=Peak_level:measure_perchannel=none",
        "-f",
        "null",
        "-",
      ],
      options,
    );
    const match = stderr.match(/Peak level dB:\s*(-?[\d.]+|-?inf)/i);
    if (!match?.[1]) return 0;
    const value = Number.parseFloat(match[1]);
    return Number.isFinite(value) ? value : -Infinity;
  } catch {
    return 0;
  }
}

export async function analyzeAudioFile(
  filePath: string,
  options: SpawnOptions = {},
): Promise<AudioAnalysis> {
  const info = await probe(filePath, options);

  // Start a fifth of the way in: intros are often sparse or silent, and a
  // spectrum measured over a filtered pad reads as a false lowpass.
  const start =
    info.durationSec > ANALYSIS_SECONDS ? Math.floor(info.durationSec * 0.2) : 0;

  const { stdout } = await runCommandBuffer(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(start),
      "-t",
      String(ANALYSIS_SECONDS),
      "-i",
      filePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(info.sampleRate),
      "-f",
      "f32le",
      "-",
    ],
    options,
  );

  if (stdout.byteLength < 4) {
    // ffmpeg produced nothing. Throwing keeps the caller's "verification
    // unavailable" path distinct from "verified and it's bad" — silently
    // returning a 0 Hz cutoff would condemn every file.
    throw new Error(`Could not decode audio for analysis: ${filePath}`);
  }

  // Float32Array needs 4-byte alignment; Buffer.concat does not guarantee it.
  const aligned =
    stdout.byteOffset % 4 === 0
      ? stdout
      : Buffer.from(stdout.subarray(0, stdout.byteLength));
  const samples = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 4),
  );
  const spectrum = averageSpectrumDb(samples);
  const { cutoffHz, ratio } = estimateCutoff(spectrum, info.sampleRate);
  const peakDb = await measurePeakDb(filePath, options);

  return {
    codec: info.codec,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bitrateKbps: info.bitrateKbps,
    cutoffHz: Math.round(cutoffHz),
    cutoffRatio: ratio,
    peakDb,
    losslessContainer: isLosslessCodec(info.codec),
  };
}

/**
 * Rough source bitrate implied by where the lowpass sits. Encoders pick their
 * cutoff from the bitrate budget, so the cliff is a decent proxy when the
 * container has been rewritten and the original bitrate is long gone.
 */
export function impliedBitrateKbps(cutoffHz: number): number | null {
  if (cutoffHz >= 20500) return null; // no meaningful lowpass
  if (cutoffHz >= 19000) return 256;
  if (cutoffHz >= 17500) return 192;
  if (cutoffHz >= 16800) return 160;
  if (cutoffHz >= 15000) return 128;
  return 96;
}

const kHz = (hz: number) => `${(hz / 1000).toFixed(1)} kHz`;

export function classifyForDj(analysis: AudioAnalysis): DjVerdict {
  const warnings: string[] = [];
  const { cutoffHz, cutoffRatio, losslessContainer, peakDb } = analysis;

  // A lossless container whose content stops well short of Nyquist is a
  // laundered lossy file. This is the case that used to slip through as
  // "Lossless" and end up in a set.
  const launderedLossy = losslessContainer && cutoffRatio < 0.88;

  let tier: DjTier;
  if (losslessContainer && !launderedLossy) {
    tier = "master";
  } else if (cutoffHz >= 19000) {
    tier = "club";
  } else if (cutoffHz >= 17000) {
    tier = "marginal";
  } else {
    tier = "unsuitable";
  }

  if (launderedLossy) {
    const implied = impliedBitrateKbps(cutoffHz);
    warnings.push(
      `Container says ${analysis.codec.toUpperCase()} but the audio stops at ${kHz(
        cutoffHz,
      )} — this came from a lossy stream${
        implied ? ` of roughly ${implied} kbps` : ""
      }, not a master. The file is big; the audio is not.`,
    );
  }

  if (tier === "unsuitable") {
    warnings.push(
      `Everything above ${kHz(
        cutoffHz,
      )} is missing. On a tuned club system this reads as dull, grainy highs and a narrower stereo image — worse again if you use key lock.`,
    );
  } else if (tier === "marginal") {
    warnings.push(
      `Content stops at ${kHz(
        cutoffHz,
      )}. Usable on smaller systems, audible as a loss of air on a big rig.`,
    );
  }

  if (peakDb > -0.1) {
    warnings.push(
      `Peaks at ${peakDb.toFixed(
        2,
      )} dBFS with no headroom — expect intersample clipping into the mixer's limiter. Pull the channel trim down a touch.`,
    );
  }

  const headline =
    tier === "master"
      ? `Master quality — ${analysis.codec.toUpperCase()} ${
          analysis.sampleRate / 1000
        } kHz, full band to ${kHz(cutoffHz)}`
      : tier === "club"
        ? `Club-ready — lossy source, clean to ${kHz(cutoffHz)}`
        : tier === "marginal"
          ? `Marginal — lossy source, rolls off at ${kHz(cutoffHz)}`
          : `Not suitable for performance — lossy source cut at ${kHz(cutoffHz)}`;

  return { tier, headline, warnings, analysis };
}

export async function verifyForDj(
  filePath: string,
  options: SpawnOptions = {},
): Promise<DjVerdict> {
  return classifyForDj(await analyzeAudioFile(filePath, options));
}
