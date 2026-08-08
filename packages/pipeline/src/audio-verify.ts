import {
  ProcessCancelledError,
  runCommandBuffer,
  runCommandOk,
  type SpawnOptions,
} from "./process";
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
  /**
   * Peak level of the decoded float signal; may exceed 0 for lossy overshoot.
   * Null when the measurement could not be taken — distinct from 0 dBFS.
   */
  peakDb: number | null;
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

/**
 * Decoded float peak. Exceeds 0 dB when a lossy decode overshoots full scale.
 *
 * Null means "could not measure", which is deliberately not the same as 0 dBFS:
 * a failed measurement must not be read as a hot file and trigger attenuation.
 */
export async function measurePeakDb(
  filePath: string,
  options: SpawnOptions,
): Promise<number | null> {
  try {
    // astats sees the float samples; volumedetect would clamp them to 0 dB and
    // hide exactly the overshoot we're looking for.
    const { stderr, code } = await runCommandBuffer(
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
    if (code !== 0) return null;
    const match = stderr.match(/Peak level dB:\s*(-?[\d.]+|-?inf)/i);
    if (!match?.[1]) return null;
    const value = Number.parseFloat(match[1]);
    // -inf is a real answer: digital silence.
    return Number.isFinite(value) ? value : -Infinity;
  } catch (err) {
    if (err instanceof ProcessCancelledError) throw err;
    return null;
  }
}

export type LoudnessMeasurement = {
  /** Integrated loudness (EBU R128), the perceptual anchor for gain matching. */
  integratedLufs: number | null;
  /**
   * True peak in dBFS — the reconstructed inter-sample maximum, which runs
   * 0.5–1.5 dB above sample peak on dense, limited masters. Sample peak is the
   * wrong ceiling: normalizing to it leaves the D/A nothing to work with.
   */
  truePeakDb: number | null;
};

/**
 * Integrated loudness + true peak in one decode.
 *
 * Peak alone cannot make a library consistent — a crushed master and an airy
 * one both peak near full scale while sitting many LU apart perceptually.
 * Loudness is what the ear tracks, so that is what the gain is matched on.
 */
export async function measureLoudness(
  filePath: string,
  options: SpawnOptions = {},
): Promise<LoudnessMeasurement> {
  const none: LoudnessMeasurement = { integratedLufs: null, truePeakDb: null };
  try {
    const { stderr, code } = await runCommandBuffer(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        filePath,
        "-vn",
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
      ],
      options,
    );
    if (code !== 0) return none;

    // ebur128 prints per-frame lines during the decode and a Summary block at
    // the end. Match the last occurrence so a frame line can never win.
    const lastMatch = (re: RegExp): number | null => {
      const hits = [...stderr.matchAll(re)];
      const raw = hits.at(-1)?.[1];
      if (raw === undefined) return null;
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : null;
    };

    return {
      integratedLufs: lastMatch(/^\s*I:\s*(-?[\d.]+|-?inf)\s*LUFS/gim),
      truePeakDb: lastMatch(/^\s*Peak:\s*(-?[\d.]+|-?inf)\s*dBFS/gim),
    };
  } catch (err) {
    if (err instanceof ProcessCancelledError) throw err;
    return none;
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

  const { stdout, stderr, code } = await runCommandBuffer(
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

  // Throwing on any failed decode keeps the caller's "verification unavailable"
  // path distinct from "verified and it's bad". A partial decode is not safe to
  // judge either: the samples we did get may be the tail of a truncated file.
  if (code !== 0) {
    throw new Error(
      `Audio analysis decode failed (${code}): ${stderr.trim().slice(0, 200)}`,
    );
  }
  if (stdout.byteLength < 4) {
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
  const { cutoffHz, ratio, detected } = estimateCutoff(spectrum, info.sampleRate);
  if (!detected) {
    // Nothing rose clear of the noise floor — a flat spectrum we cannot read,
    // not a file without highs. Same treatment as a failed decode.
    throw new Error(`No measurable spectrum for analysis: ${filePath}`);
  }
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

/**
 * Content reaching this high was never through a lossy encoder: no consumer
 * codec passes 19.5 kHz at any bitrate a download service ships.
 */
const FULL_BAND_HZ = 19500;

/** Above this the source carries everything a club system can reproduce. */
const CLUB_HZ = 19000;
const MARGINAL_HZ = 17000;

/**
 * Nyquist-relative fallback, applied at 48 kHz and below only. Judging bandwidth
 * as a fraction of Nyquist is right at 44.1 kHz — real masters run to ~20 kHz of
 * 22.05 — and nonsense above it: no music has content near 48 kHz, so a genuine
 * 96 kHz master stopping at 24 kHz scores 0.5 and would be called a fake.
 */
const NYQUIST_FULL_BAND_RATIO = 0.88;
const NYQUIST_RATIO_MAX_RATE = 48000;

export function classifyForDj(analysis: AudioAnalysis): DjVerdict {
  const warnings: string[] = [];
  const { cutoffHz, cutoffRatio, losslessContainer, peakDb, sampleRate } =
    analysis;

  const fullBand =
    cutoffHz >= FULL_BAND_HZ ||
    (sampleRate <= NYQUIST_RATIO_MAX_RATE &&
      cutoffRatio >= NYQUIST_FULL_BAND_RATIO);

  // A lossless container that isn't carrying a full band is a laundered lossy
  // file. This is the case that used to slip through as "Lossless" and end up
  // in a set.
  const launderedLossy = losslessContainer && !fullBand;

  // Note "master" also requires CLUB_HZ: a 32 kHz PCM file is full band for its
  // own rate without being a file you want on a big system.
  let tier: DjTier;
  if (losslessContainer && fullBand && cutoffHz >= CLUB_HZ) {
    tier = "master";
  } else if (cutoffHz >= CLUB_HZ) {
    tier = "club";
  } else if (cutoffHz >= MARGINAL_HZ) {
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

  if (peakDb !== null && peakDb > -0.1) {
    warnings.push(
      `Peaks at ${peakDb.toFixed(
        2,
      )} dBFS with no headroom — expect intersample clipping into the mixer's limiter. Pull the channel trim down a touch.`,
    );
  }

  // Don't call a genuinely lossless file a lossy source just because it is
  // narrow — a 32 kHz master is band-limited, not laundered.
  const provenance =
    losslessContainer && !launderedLossy ? "lossless source" : "lossy source";

  const headline =
    tier === "master"
      ? `Master quality — ${analysis.codec.toUpperCase()} ${
          sampleRate / 1000
        } kHz, full band to ${kHz(cutoffHz)}`
      : tier === "club"
        ? `Club-ready — ${provenance}, clean to ${kHz(cutoffHz)}`
        : tier === "marginal"
          ? `Marginal — ${provenance}, rolls off at ${kHz(cutoffHz)}`
          : `Not suitable for performance — ${provenance} cut at ${kHz(cutoffHz)}`;

  return { tier, headline, warnings, analysis };
}

/**
 * The bar for "club-ready only" mode: measured content reaching CLUB_HZ,
 * whatever the container claims. Deliberately a tier check rather than a raw
 * cutoff comparison so the threshold lives in exactly one place.
 */
export function isClubReady(tier: DjTier): boolean {
  return tier === "master" || tier === "club";
}

/**
 * Thrown when club-ready-only mode rejects a downloaded source.
 *
 * `tier: null` means the analysis itself failed — an unmeasurable file is not
 * evidence of a good one, so the gate treats it as a rejection.
 */
export class QualityGateError extends Error {
  readonly tier: DjTier | null;
  readonly cutoffHz: number | null;

  /**
   * A union rather than an optional `cutoffHz`, so a known tier cannot be
   * reported without the measurement that produced it — "audio stops at
   * 0.0 kHz" reads as a corrupt file and sends the user after the wrong bug.
   */
  constructor(
    params:
      /** `source` is the human name of the attempt, e.g. "SoundCloud stream". */
      | { tier: DjTier; cutoffHz: number; source: string }
      | { tier: null; source: string },
  ) {
    super(
      params.tier === null
        ? `${params.source} could not be verified, and club-ready-only mode does not ship unverified audio. Turn off Club-ready only to download it anyway.`
        : `${params.source} is not club-ready — audio stops at ${kHz(
            params.cutoffHz,
          )}. Turn off Club-ready only to download it anyway.`,
    );
    this.name = "QualityGateError";
    this.tier = params.tier;
    this.cutoffHz = params.tier === null ? null : params.cutoffHz;
  }
}

export function isQualityGateError(err: unknown): err is QualityGateError {
  return err instanceof QualityGateError;
}

export async function verifyForDj(
  filePath: string,
  options: SpawnOptions = {},
): Promise<DjVerdict> {
  return classifyForDj(await analyzeAudioFile(filePath, options));
}
