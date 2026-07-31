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
 * Returns the attenuation to apply, or null when the signal already fits.
 */
export function headroomGainDb(peakDb: number): number | null {
  if (!Number.isFinite(peakDb)) return null;
  if (peakDb <= TARGET_PEAK_DBFS) return null;
  return Number((TARGET_PEAK_DBFS - peakDb).toFixed(3));
}

export type AudioProbe = {
  codec: string;
  channels: number;
  sampleRate: string;
  bitRate: string;
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
        "stream=codec_name,channels,sample_rate,bit_rate",
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
    };
  } catch {
    return { codec: "", channels: 2, sampleRate: "48000", bitRate: "" };
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
    gainDb = headroomGainDb(
      await measurePeakDb(params.inputPath, { signal: params.signal }),
    );
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
