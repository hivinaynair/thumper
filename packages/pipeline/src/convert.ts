import { runCommandOk, type SpawnOptions } from "./process";
import {
  audioQualityLabel,
  isLosslessSource,
  isPcmSource,
  type AudioTargetFormat,
} from "./audio-quality";
import { measureLoudness, type LoudnessMeasurement } from "./audio-verify";

/**
 * Loudness target for the library, in LUFS.
 *
 * Roughly where contemporary club masters sit, so most tracks move a decibel
 * or two and the hot ones come *down* rather than everything being pushed up.
 */
export const TARGET_LUFS = -9;

/**
 * True-peak ceiling in dBFS. Not 0: a file sitting exactly at full scale hands
 * the CDJ's D/A — and any downstream resampling or key lock — nothing to work
 * with, so the reconstructed waveform clips even though no sample does.
 */
export const TRUE_PEAK_CEILING_DB = -1;

/** Gains smaller than this are inaudible; skip the filter entirely. */
const MIN_MEANINGFUL_GAIN_DB = 0.1;

/**
 * Match a lossy source to the library loudness target.
 *
 * Peak normalization cannot make a library consistent: a crushed master and an
 * airy one both peak near full scale while sitting many LU apart to the ear.
 * Gain is therefore matched on integrated loudness, then clamped so true peak
 * never crosses the ceiling.
 *
 * Deliberately never limits. A quiet, dynamic track that would need +7 dB but
 * has only 0.8 dB of headroom gets +0.8 dB and stays quiet — reaching the
 * target would mean squashing the dynamic range that made it worth keeping.
 * Attenuation is unbounded; boosts are capped by real headroom.
 *
 * Lossless masters are never touched (caller skips this path).
 * Returns null when nothing meaningful to apply, or measurement failed.
 */
export function loudnessGainDb(params: {
  integratedLufs: number | null;
  truePeakDb: number | null;
}): number | null {
  const { integratedLufs, truePeakDb } = params;
  // A failed measurement must not be read as a hot file and trigger attenuation.
  if (integratedLufs === null || !Number.isFinite(integratedLufs)) return null;
  if (truePeakDb === null || !Number.isFinite(truePeakDb)) return null;

  const wanted = TARGET_LUFS - integratedLufs;
  const headroom = TRUE_PEAK_CEILING_DB - truePeakDb;
  // Attenuation is always safe, so the ceiling only ever caps a boost.
  const gain = Math.min(wanted, headroom);

  if (Math.abs(gain) < MIN_MEANINGFUL_GAIN_DB) return null;
  return Number(gain.toFixed(3));
}

export type AudioProbe = {
  codec: string;
  channels: number;
  sampleRate: string;
  bitRate: string;
  /** e.g. s16, s24, s32, flt — used to pick a matching AIFF PCM codec. */
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
  /** Local image path for embedded cover art (FLAC / ALAC). */
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

export async function convertAudio(params: {
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
  signal?: AbortSignal;
}): Promise<{ qualityLabel: string; headroomGainDb: number | null }> {
  const info = await probeAudio(params.inputPath, { signal: params.signal });
  const sampleRate = Number.parseInt(info.sampleRate) || 44100;
  const channels = info.channels || 2;
  const qualityLabel = audioQualityLabel(
    params.target,
    info.codec,
    params.inputPath,
    params.cutoffHz,
  );

  // Only lossy sources are normalized; a lossless source is already
  // integer-bounded, and touching its gain would make the "lossless" claim
  // untrue — the file would no longer be the master it claims to be.
  let gainDb: number | null = null;
  if (!isLosslessSource(info.codec, params.inputPath)) {
    const loudness =
      params.loudness ??
      (await measureLoudness(params.inputPath, { signal: params.signal }));
    gainDb = loudnessGainDb(loudness);
  }
  const gain = gainDb === null ? [] : ["-af", `volume=${gainDb}dB`];

  const meta = buildMetadataArgs(params);
  const canEmbedArt =
    Boolean(params.artworkPath) &&
    (params.target === "flac" || params.target === "alac");

  let args: string[];

  if (params.target === "wav") {
    // WAV keeps text tags; cover art is unreliable in DJ tools — skip artwork.
    if (isPcmSource(info.codec, params.inputPath)) {
      args = ["-y", "-i", params.inputPath, "-vn", "-c:a", "copy", ...meta, params.outputPath];
    } else {
      args = [
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
  } else if (params.target === "flac") {
    const alreadyFlac =
      info.codec === "flac" || params.inputPath.toLowerCase().endsWith(".flac");
    if (canEmbedArt) {
      args = [
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
    } else if (alreadyFlac) {
      args = ["-y", "-i", params.inputPath, "-vn", "-c:a", "copy", ...meta, params.outputPath];
    } else {
      args = [
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
  } else {
    // ALAC / m4a
    if (canEmbedArt) {
      args = [
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
    } else {
      args = [
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
  }

  await runCommandOk("ffmpeg", args, { signal: params.signal });
  return { qualityLabel, headroomGainDb: gainDb };
}
