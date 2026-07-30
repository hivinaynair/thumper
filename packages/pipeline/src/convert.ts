import { runCommandOk, type SpawnOptions } from "./process";
import {
  audioQualityLabel,
  isPcmSource,
  type AudioTargetFormat,
} from "./audio-quality";

export type AudioProbe = {
  codec: string;
  channels: number;
  sampleRate: string;
  bitRate: string;
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

export async function convertAudio(params: {
  inputPath: string;
  outputPath: string;
  target: AudioTargetFormat;
  title?: string;
  artist?: string;
  signal?: AbortSignal;
}): Promise<{ qualityLabel: string }> {
  const info = await probeAudio(params.inputPath, { signal: params.signal });
  const sampleRate = Number.parseInt(info.sampleRate) || 44100;
  const channels = info.channels || 2;
  const qualityLabel = audioQualityLabel(
    params.target,
    info.codec,
    params.inputPath,
  );

  const meta: string[] = [];
  if (params.title) meta.push("-metadata", `title=${params.title}`);
  if (params.artist) meta.push("-metadata", `artist=${params.artist}`);

  let args: string[];

  if (params.target === "wav") {
    if (isPcmSource(info.codec, params.inputPath)) {
      args = ["-y", "-i", params.inputPath, "-vn", "-c:a", "copy", ...meta, params.outputPath];
    } else {
      args = [
        "-y",
        "-i",
        params.inputPath,
        "-vn",
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
    args = alreadyFlac
      ? ["-y", "-i", params.inputPath, "-vn", "-c:a", "copy", ...meta, params.outputPath]
      : [
          "-y",
          "-i",
          params.inputPath,
          "-vn",
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
  } else {
    args = [
      "-y",
      "-i",
      params.inputPath,
      "-vn",
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

  await runCommandOk("ffmpeg", args, { signal: params.signal });
  return { qualityLabel };
}
