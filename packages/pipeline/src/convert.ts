import { runCommandOk, type SpawnOptions } from "./process";
import {
  audioQualityLabel,
  isLosslessSource,
  isPcmSource,
  type AudioTargetFormat,
} from "./audio-quality";
import { measureLoudness, type LoudnessMeasurement } from "./audio-verify";

/**
 * Loudness a quiet track is raised *towards*, in LUFS. Not a level every track
 * is pinned to: anything already at or above this is left where it is.
 */
export const TARGET_LUFS = -9;

/**
 * Write-side sample-peak ceiling in dBFS. Used as the limiter *target* and as
 * the cap on loudness boost — not as the trigger for whether to limit.
 *
 * Integer PCM clamps at 0 dBFS. We write 0.1 dB under that so float rounding
 * between measurement and encode cannot push a sample into the clamp. This is
 * deliberately not a true-peak ceiling: holding files a full dB below full
 * scale would protect the CDJ's D/A from inter-sample overshoot, but it costs
 * level on tracks that would never have clipped on disk.
 */
export const SAMPLE_PEAK_CEILING_DB = -0.1;

/**
 * Where integer PCM actually clamps. The limiter runs only when the decoded
 * (post-boost) peak exceeds this — files between here and SAMPLE_PEAK_CEILING_DB
 * already fit on disk and must not be ducked.
 */
const INTEGER_CLIP_DB = 0;

/** Gains smaller than this are inaudible; skip the filter entirely. */
const MIN_MEANINGFUL_GAIN_DB = 0.1;

/** Linear amplitude matching SAMPLE_PEAK_CEILING_DB for FFmpeg's limiter. */
const SAMPLE_PEAK_CEILING_LINEAR = 10 ** (SAMPLE_PEAK_CEILING_DB / 20);

/**
 * Fastest lookahead FFmpeg's alimiter allows (attack 0.1–80 ms, release 1–8000).
 * 5/50 are the filter defaults and duck ~55 ms around every overshoot — on a
 * dense club master that is every kick. 0.1/1 still avoids a click, and only
 * the samples that would have clamped.
 */
const LIMITER_ATTACK_MS = 0.1;
const LIMITER_RELEASE_MS = 1;

export type LossyProcessingPlan = {
  gainDb: number | null;
  peakLimited: boolean;
};

/**
 * Bring a quiet lossy source up towards the library target, never down.
 *
 * Two rules, and the order matters:
 *
 * 1. Loudness gain is boost-only. A track already louder than the target keeps
 *    its level — electronic masters are deliberately hot, and pulling them down
 *    to match quieter material is not wanted here. The cost is accepted:
 *    matching is one-directional, so a crushed master still sits above a
 *    dynamic one and the library is not fully level-matched.
 *
 * 2. The sample-peak ceiling still attenuates, and overrides rule 1. This is
 *    not a loudness decision and it is not optional: a signal above 0 dBFS
 *    cannot be represented in integer PCM at all, so the alternative is not
 *    "louder", it is the same file with its peaks clamped flat — distortion
 *    that was never in the master. Clipping the artist baked in is unaffected
 *    by gain and survives either way; this removes only what *we* would add.
 *
 * Never limits: a quiet track with no headroom simply stays quiet rather than
 * being squashed to hit the target.
 *
 * Lossless masters are never touched (caller skips this path).
 * Returns null when nothing meaningful to apply, or measurement failed.
 */
export function loudnessGainDb(params: {
  integratedLufs: number | null;
  samplePeakDb: number | null;
}): number | null {
  const { integratedLufs, samplePeakDb } = params;
  // A failed measurement must not be read as a hot file and trigger attenuation.
  if (integratedLufs === null || !Number.isFinite(integratedLufs)) return null;
  if (samplePeakDb === null || !Number.isFinite(samplePeakDb)) return null;

  // Boost-only: a track above the target asks for no loudness change at all.
  const wantedBoost = Math.max(TARGET_LUFS - integratedLufs, 0);
  // Negative only when the decode would clip on write — the one case allowed
  // to pull a file down.
  const headroom = SAMPLE_PEAK_CEILING_DB - samplePeakDb;
  const gain = Math.min(wantedBoost, headroom);

  if (Math.abs(gain) < MIN_MEANINGFUL_GAIN_DB) return null;
  return Number(gain.toFixed(3));
}

/**
 * Build the DJ-stream processing plan.
 *
 * With peak limiting enabled, loudness gain remains boost-only and is still
 * capped by clean headroom. The difference is the overshoot case: instead of
 * lowering the entire track, the limiter catches only samples that would clamp
 * in integer PCM (> 0 dBFS). This is deliberately opt-in at the conversion
 * boundary so retagged user uploads keep the conservative, dynamics-preserving
 * behaviour.
 */
export function lossyProcessingPlan(
  params: {
    integratedLufs: number | null;
    samplePeakDb: number | null;
  },
  peakLimiting: boolean,
): LossyProcessingPlan {
  if (!peakLimiting) {
    return { gainDb: loudnessGainDb(params), peakLimited: false };
  }

  const { integratedLufs, samplePeakDb } = params;
  if (integratedLufs === null || !Number.isFinite(integratedLufs)) {
    return { gainDb: null, peakLimited: false };
  }
  if (samplePeakDb === null || !Number.isFinite(samplePeakDb)) {
    return { gainDb: null, peakLimited: false };
  }

  const wantedBoost = Math.max(TARGET_LUFS - integratedLufs, 0);
  const cleanHeadroom = Math.max(SAMPLE_PEAK_CEILING_DB - samplePeakDb, 0);
  const rawGain = Math.min(wantedBoost, cleanHeadroom);
  const gainDb =
    rawGain >= MIN_MEANINGFUL_GAIN_DB ? Number(rawGain.toFixed(3)) : null;
  const peakAfterGain = samplePeakDb + (gainDb ?? 0);

  return {
    gainDb,
    peakLimited: peakAfterGain > INTEGER_CLIP_DB,
  };
}

export function lossyFilterArgs(plan: LossyProcessingPlan): string[] {
  const filters: string[] = [];
  if (plan.gainDb !== null) filters.push(`volume=${plan.gainDb}dB`);
  if (plan.peakLimited) {
    filters.push(
      `alimiter=limit=${SAMPLE_PEAK_CEILING_LINEAR.toFixed(6)}` +
        `:attack=${LIMITER_ATTACK_MS}:release=${LIMITER_RELEASE_MS}` +
        ":level=false:latency=true",
    );
  }
  return filters.length === 0 ? [] : ["-af", filters.join(",")];
}

export type AudioProbe = {
  codec: string;
  channels: number;
  sampleRate: string;
  bitRate: string;
  /** e.g. s16, s24, s32, flt — used to preserve meaningful PCM depth. */
  sampleFmt: string;
  /**
   * Meaningful sample width from the container (e.g. 24), when present.
   * Prefer this over sample_fmt — ffmpeg often decodes 24-bit PCM as s32
   * with 8 bits of zero padding.
   */
  bitsPerRawSample: number | null;
};

export type ConvertMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  date?: string;
  /** Local image path for embedded cover art (FLAC / ALAC / copy-tagged MP3). */
  artworkPath?: string | null;
};

export async function probeAudio(
  filePath: string,
  options: SpawnOptions = {},
): Promise<AudioProbe> {
  try {
    const { stdout } = await runCommandOk(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,channels,sample_rate,bit_rate,sample_fmt,bits_per_raw_sample,bits_per_coded_sample",
        "-of",
        "json",
        filePath,
      ],
      options,
    );
    const stream = JSON.parse(stdout).streams?.[0] ?? {};
    const rawBits = Number.parseInt(String(stream.bits_per_raw_sample ?? ""), 10);
    const codedBits = Number.parseInt(
      String(stream.bits_per_coded_sample ?? ""),
      10,
    );
    const bitsPerRawSample = Number.isFinite(rawBits) && rawBits > 0
      ? rawBits
      : Number.isFinite(codedBits) && codedBits > 0
        ? codedBits
        : null;
    return {
      codec: stream.codec_name || "",
      channels: stream.channels || 2,
      sampleRate: stream.sample_rate || "48000",
      bitRate: stream.bit_rate || "",
      sampleFmt: stream.sample_fmt || "",
      bitsPerRawSample,
    };
  } catch {
    return {
      codec: "",
      channels: 2,
      sampleRate: "48000",
      bitRate: "",
      sampleFmt: "",
      bitsPerRawSample: null,
    };
  }
}

function buildMetadataArgs(meta: ConvertMetadata): string[] {
  const out: string[] = [];
  if (meta.title) out.push("-metadata", `title=${meta.title}`);
  if (meta.artist) out.push("-metadata", `artist=${meta.artist}`);
  if (meta.album) out.push("-metadata", `album=${meta.album}`);
  if (meta.genre) out.push("-metadata", `genre=${meta.genre}`);
  if (meta.date) out.push("-metadata", `date=${meta.date}`);
  return out;
}

export type Mp3TagParams = ConvertMetadata & {
  inputPath: string;
  outputPath: string;
  signal?: AbortSignal;
};

/**
 * True when ffprobe reports an attached picture (ID3 APIC / cover stream).
 * A missing or unreadable file is treated as no artwork so the caller can
 * still copy-tag rather than crash the job.
 */
export async function hasAttachedArtwork(
  filePath: string,
  options: SpawnOptions = {},
): Promise<boolean> {
  try {
    const { stdout } = await runCommandOk(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type:stream_disposition=attached_pic",
        "-of",
        "json",
        filePath,
      ],
      options,
    );
    const streams = (JSON.parse(stdout).streams ?? []) as Array<{
      disposition?: { attached_pic?: number };
    }>;
    return streams.some((stream) => Number(stream.disposition?.attached_pic) === 1);
  } catch {
    return false;
  }
}

/** Copy MP3 audio packets and write ID3v2.3 text tags plus optional APIC. */
export function buildMp3TagArgs(params: Mp3TagParams): string[] {
  const meta = buildMetadataArgs(params);
  const version = ["-id3v2_version", "3"];
  if (params.artworkPath) {
    return [
      "-y",
      "-i",
      params.inputPath,
      "-i",
      params.artworkPath,
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
      ...version,
      ...meta,
      params.outputPath,
    ];
  }
  return [
    "-y",
    "-i",
    params.inputPath,
    "-c:a",
    "copy",
    ...version,
    ...meta,
    params.outputPath,
  ];
}

export async function tagMp3Copy(params: Mp3TagParams): Promise<void> {
  await runCommandOk("ffmpeg", buildMp3TagArgs(params), {
    signal: params.signal,
  });
}

export type ConvertAudioParams = {
  inputPath: string;
  outputPath: string;
  target: AudioTargetFormat;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  date?: string;
  artworkPath?: string | null;
  /** Measured spectral cutoff of the source, used for an honest quality label. */
  cutoffHz?: number;
  /**
   * Loudness already measured for this same file. Pass it to skip a second full
   * decode; omit it and this measures its own.
   */
  loudness?: LoudnessMeasurement;
  /**
   * Catch decoded lossy overshoots without lowering the whole track. Enabled
   * by the YouTube/SoundCloud download pipeline; omitted for user retag jobs.
   */
  peakLimitLossy?: boolean;
  signal?: AbortSignal;
};

export function buildFfmpegArgs(
  params: ConvertAudioParams,
  info: AudioProbe,
  processing: LossyProcessingPlan,
): string[] {
  const sampleRate = Number.parseInt(info.sampleRate) || 44100;
  const channels = info.channels || 2;
  const gain = lossyFilterArgs(processing);
  const meta = buildMetadataArgs(params);
  const canEmbedArt =
    Boolean(params.artworkPath) &&
    (params.target === "flac" || params.target === "alac");

  if (params.target === "wav") {
    // WAV keeps text tags; cover art is unreliable in DJ tools — skip artwork.
    if (isPcmSource(info.codec, params.inputPath)) {
      return ["-y", "-i", params.inputPath, "-vn", "-c:a", "copy", ...meta, params.outputPath];
    }
    return [
      "-y",
      "-i",
      params.inputPath,
      "-vn",
      ...gain,
      "-ar",
      String(sampleRate),
      "-acodec",
      "pcm_s16le",
      "-ac",
      String(channels),
      ...meta,
      params.outputPath,
    ];
  }

  if (params.target === "flac") {
    const alreadyFlac =
      info.codec === "flac" || params.inputPath.toLowerCase().endsWith(".flac");
    if (canEmbedArt) {
      return [
        "-y",
        "-i",
        params.inputPath,
        "-i",
        params.artworkPath!,
        "-map",
        "0:a:0",
        "-map",
        "1:0",
        ...(alreadyFlac
          ? ["-c:a", "copy"]
          : [...gain, "-c:a", "flac", "-compression_level", "8", "-ar", String(sampleRate), "-ac", String(channels)]),
        "-c:v",
        "mjpeg",
        "-disposition:v:0",
        "attached_pic",
        ...meta,
        params.outputPath,
      ];
    }
    if (alreadyFlac) {
      return ["-y", "-i", params.inputPath, "-vn", "-c:a", "copy", ...meta, params.outputPath];
    }
    return [
      "-y",
      "-i",
      params.inputPath,
      "-vn",
      ...gain,
      "-c:a",
      "flac",
      "-compression_level",
      "8",
      "-ar",
      String(sampleRate),
      "-ac",
      String(channels),
      ...meta,
      params.outputPath,
    ];
  }

  // ALAC / m4a
  if (canEmbedArt) {
    return [
      "-y",
      "-i",
      params.inputPath,
      "-i",
      params.artworkPath!,
      "-map",
      "0:a:0",
      "-map",
      "1:0",
      ...gain,
      "-c:a",
      "alac",
      "-ar",
      String(sampleRate),
      "-ac",
      String(channels),
      "-c:v",
      "mjpeg",
      "-disposition:v:0",
      "attached_pic",
      ...meta,
      params.outputPath,
    ];
  }
  return [
    "-y",
    "-i",
    params.inputPath,
    "-vn",
    ...gain,
    "-c:a",
    "alac",
    "-ar",
    String(sampleRate),
    "-ac",
    String(channels),
    ...meta,
    params.outputPath,
  ];
}

export async function convertAudio(params: ConvertAudioParams): Promise<{
  qualityLabel: string;
  headroomGainDb: number | null;
  peakLimited: boolean;
}> {
  const info = await probeAudio(params.inputPath, { signal: params.signal });
  let qualityLabel = audioQualityLabel(
    params.target,
    info.codec,
    params.inputPath,
    params.cutoffHz,
  );

  // Only lossy sources are normalized; a lossless source is already
  // integer-bounded, and touching its gain would make the "lossless" claim
  // untrue — the file would no longer be the master it claims to be.
  let processing: LossyProcessingPlan = {
    gainDb: null,
    peakLimited: false,
  };
  if (!isLosslessSource(info.codec, params.inputPath)) {
    const loudness =
      params.loudness ??
      (await measureLoudness(params.inputPath, { signal: params.signal }));
    processing = lossyProcessingPlan(loudness, params.peakLimitLossy === true);
  }
  if (processing.peakLimited) {
    qualityLabel += " · peak-limited to -0.1 dBFS";
  }

  const args = buildFfmpegArgs(params, info, processing);
  await runCommandOk("ffmpeg", args, { signal: params.signal });
  return {
    qualityLabel,
    headroomGainDb: processing.gainDb,
    peakLimited: processing.peakLimited,
  };
}
