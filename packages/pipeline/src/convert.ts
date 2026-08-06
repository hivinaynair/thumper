import { runCommandOk, type SpawnOptions } from "./process";
import {
  audioQualityLabel,
  isLosslessSource,
  isPcmSource,
  type AudioTargetFormat,
} from "./audio-quality";
import { measurePeakDb } from "./audio-verify";

/** Leave this much room below full scale when re-encoding to an integer format. */
const TARGET_PEAK_DBFS = -0.3;

/**
 * Lossy decoders routinely produce samples above ±1.0 — the reconstruction
 * overshoots even when the original master didn't clip. Writing that straight
 * into 16- or 24-bit PCM clamps every one of those samples flat, which is how a
 * 128 kbps stream ends up with ten thousand clipped samples after being
 * "losslessly" rewrapped.
 *
 * Returns the attenuation to apply, or null when the signal already fits or the
 * peak could not be measured — an unmeasured file is left alone rather than
 * quietly attenuated on a guess.
 */
export function headroomGainDb(peakDb: number | null): number | null {
  if (peakDb === null || !Number.isFinite(peakDb)) return null;
  if (peakDb <= TARGET_PEAK_DBFS) return null;
  return Number((TARGET_PEAK_DBFS - peakDb).toFixed(3));
}

export type AudioProbe = {
  codec: string;
  channels: number;
  sampleRate: string;
  bitRate: string;
  /** e.g. s16, s24, s32, flt — used to pick a matching AIFF PCM codec. */
  sampleFmt: string;
};

/**
 * AIFF stores PCM big-endian. Map a probed WAV/PCM codec (or sample_fmt) to
 * the matching AIFF encoder so bit depth is preserved — only endianness changes.
 */
export function aiffPcmCodec(codec: string, sampleFmt = ""): string {
  const c = codec.toLowerCase();
  const fmt = sampleFmt.toLowerCase();
  // Float before int32 — "pcm_f32le" also contains "32".
  if (c.includes("f32") || fmt.includes("flt") || fmt === "flt") return "pcm_f32be";
  if (c.includes("32") || fmt.includes("s32") || fmt === "s32") return "pcm_s32be";
  if (c.includes("24") || fmt.includes("s24") || fmt === "s24") return "pcm_s24be";
  if (c.includes("16") || fmt.includes("s16") || fmt === "s16") return "pcm_s16be";
  // Producer masters are usually 24-bit when the probe is vague.
  return "pcm_s24be";
}

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
        "stream=codec_name,channels,sample_rate,bit_rate,sample_fmt",
        "-of",
        "json",
        filePath,
      ],
      options,
    );
    const stream = JSON.parse(stdout).streams?.[0] ?? {};
    return {
      codec: stream.codec_name || "",
      channels: stream.channels || 2,
      sampleRate: stream.sample_rate || "48000",
      bitRate: stream.bit_rate || "",
      sampleFmt: stream.sample_fmt || "",
    };
  } catch {
    return {
      codec: "",
      channels: 2,
      sampleRate: "48000",
      bitRate: "",
      sampleFmt: "",
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
   * Peak already measured by the verifier for this same file. Pass it to skip a
   * second full decode; `null` means "measured and unavailable", `undefined`
   * means "not measured yet".
   */
  peakDb?: number | null;
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

  // Only lossy sources overshoot; a lossless source is already integer-bounded,
  // and touching its gain would make the "lossless" claim untrue.
  let gainDb: number | null = null;
  if (!isLosslessSource(info.codec, params.inputPath)) {
    const peakDb =
      params.peakDb !== undefined
        ? params.peakDb
        : await measurePeakDb(params.inputPath, { signal: params.signal });
    gainDb = headroomGainDb(peakDb);
  }
  const gain = gainDb === null ? [] : ["-af", `volume=${gainDb}dB`];

  const meta = buildMetadataArgs(params);
  const canEmbedArt =
    Boolean(params.artworkPath) &&
    (params.target === "flac" ||
      params.target === "alac" ||
      params.target === "aiff");

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
  } else if (params.target === "aiff") {
    // Lossless PCM remux into AIFF. Preserve bit depth; AIFF wants big-endian.
    // ID3v2 carries text tags + cover art (Rekordbox / most DJ tools read it).
    const pcmCodec = aiffPcmCodec(info.codec, info.sampleFmt);
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
        pcmCodec,
        "-ar",
        String(sampleRate),
        "-ac",
        String(channels),
        "-c:v",
        "mjpeg",
        "-disposition:v:0",
        "attached_pic",
        "-write_id3v2",
        "1",
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
        pcmCodec,
        "-ar",
        String(sampleRate),
        "-ac",
        String(channels),
        "-write_id3v2",
        "1",
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
