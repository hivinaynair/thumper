export type AudioTargetFormat = "wav" | "flac" | "alac";

export const AUDIO_FORMAT_SELECTOR =
  "bestaudio[ext=wav]/bestaudio[acodec^=pcm]/bestaudio[acodec=lpcm]/bestaudio[acodec^=flac]/bestaudio[acodec^=alac]/bestaudio/best";

export const AUDIO_FORMAT_SORT =
  "abr:desc,asr:desc,channels:desc,acodec:opus:aac:mp3";

/** Fail-closed: exclude SoundCloud preview formats from the selector. */
export const withoutPreview = (selector: string) => {
  const filteredSelectors = selector.replaceAll(
    "bestaudio[",
    "bestaudio[format_id!*=preview][",
  );
  return filteredSelectors.replace(
    "/bestaudio/best",
    "/bestaudio[format_id!*=preview]/bestaudio/best",
  );
};

export const isPcmSource = (codec: string, filePath = "") => {
  const lowerCodec = codec.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  return (
    lowerCodec.startsWith("pcm_") ||
    lowerCodec === "lpcm" ||
    lowerPath.endsWith(".wav")
  );
};

const isLosslessSource = (codec: string, filePath = "") => {
  const lowerCodec = codec.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  return (
    isPcmSource(codec, filePath) ||
    lowerCodec === "flac" ||
    lowerCodec === "alac" ||
    lowerPath.endsWith(".flac")
  );
};

export const audioQualityLabel = (
  target: AudioTargetFormat,
  codec: string,
  filePath = "",
) => {
  const lowerCodec = codec.toLowerCase();
  const lowerPath = filePath.toLowerCase();

  if (target === "wav" && isPcmSource(codec, filePath)) {
    return "Highest Available (Original WAV/PCM)";
  }
  if (
    target === "flac" &&
    (lowerCodec === "flac" || lowerPath.endsWith(".flac"))
  ) {
    return "Lossless (Original FLAC)";
  }
  if (target === "alac" && lowerCodec === "alac") {
    return "Lossless (Original ALAC)";
  }

  if (isLosslessSource(codec, filePath)) {
    const label = target === "alac" ? "ALAC" : target.toUpperCase();
    return `${label} from lossless source`;
  }

  const label =
    target === "wav" ? "WAV/PCM" : target === "flac" ? "FLAC" : "ALAC";
  return `${label} converted from ${lowerCodec || "unknown"} source (no quality gain)`;
};
