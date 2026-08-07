import { runCommandOk, type SpawnOptions } from "./process";
import {
  audioQualityLabel,
  isLosslessSource,
  isPcmSource,
  type AudioTargetFormat,
} from "./audio-quality";
import { measurePeakDb } from "./audio-verify";

/**
 * Peak-normalize lossy sources for DJ use.
 *
 * Lossy decoders can overshoot (±1.0) — pull those back to 0 dBFS so PCM
 * doesn't clip. Quiet loudness-normalized streams (YouTube ~−14 LUFS) get
 * boosted to 0 dBFS so waveforms in Rekordbox/DJ Pro match club masters.
 * Relative dynamics within the track are unchanged; only overall gain moves.
 *
 * Lossless masters are never touched (caller skips this path).
 * Returns null when already at full scale or peak could not be measured.
 */
export function headroomGainDb(peakDb: number | null): number | null {
  if (peakDb === null || !Number.isFinite(peakDb)) return null;
  // Near full scale (±0.1 dB) — leave alone.
  if (peakDb <= 0.1 && peakDb >= -0.1) return null;
  // Overshoot or quiet stream → bring peak to 0 dBFS.
  return Number((-peakDb).toFixed(3));
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

/**
 * AIFF stores PCM big-endian. Map a probed WAV/PCM codec (or sample_fmt) to
 * the matching AIFF encoder so bit depth is preserved — only endianness changes.
 *
 * Do not trust sample_fmt=s32 alone: ffmpeg unpacks 24-bit WAV into 32-bit
 * slots. Prefer codec name / bits_per_raw_sample so we write real 24-bit AIFF
 * instead of padded pcm_s32be that tools mislabel as "32-bit".
 */
export function aiffPcmCodec(
  codec: string,
  sampleFmt = "",
  bitsPerRawSample: number | null = null,
): string {
  const c = codec.toLowerCase();
  const fmt = sampleFmt.toLowerCase();
  const bits =
    typeof bitsPerRawSample === "number" &&
    Number.isFinite(bitsPerRawSample) &&
    bitsPerRawSample > 0
      ? bitsPerRawSample
      : null;

  // Float before int — "pcm_f32le" also contains "32".
  //
  // Only a genuine float PCM *codec* earns float output. sample_fmt is not
  // evidence: every lossy decoder reports fltp (Opus and AAC both do), so
  // trusting it wrote 32-bit float AIFF for every YouTube and SoundCloud
  // stream — a third larger than 24-bit, carrying no extra information, in a
  // format CDJs and Rekordbox handle poorly. Those fall through to 24-bit.
  if (c.includes("f32")) {
    return "pcm_f32be";
  }

  // Explicit codec bit depth wins over sample_fmt (see padded s32 note above).
  if (c.includes("s24") || c.includes("24")) return "pcm_s24be";
  if (c.includes("s16") || c.includes("16")) return "pcm_s16be";
  if (c.includes("s32") || c.includes("32")) {
    if (bits === 24) return "pcm_s24be";
    if (bits === 16) return "pcm_s16be";
    return "pcm_s32be";
  }

  if (bits === 24) return "pcm_s24be";
  if (bits === 16) return "pcm_s16be";
  if (bits === 32) return "pcm_s32be";

  if (fmt.includes("s24") || fmt === "s24") return "pcm_s24be";
  if (fmt.includes("s16") || fmt === "s16") return "pcm_s16be";
  // sample_fmt=s32 alone usually means padded 24-bit, not a 32-bit master.
  // Producer downloads are almost always 24-bit when the probe is vague.
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
    const pcmCodec = aiffPcmCodec(
      info.codec,
      info.sampleFmt,
      info.bitsPerRawSample,
    );
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
