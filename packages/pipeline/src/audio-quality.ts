/**
 * Output containers. AIFF is deliberately absent — FLAC holds bit-identical
 * PCM in ~60% of the space with better tagging, so it is the only target.
 * AIFF remains a recognised *source* format: SoundCloud originals and retag
 * uploads still arrive as AIFF.
 */
export type AudioTargetFormat = "wav" | "flac" | "alac";

/**
 * Format preference chain, tried left to right. yt-dlp picks the first group
 * that matches anything, then applies AUDIO_FORMAT_SORT within that group — so
 * ordering here is a hard preference, not a tiebreak.
 *
 * `format_id=download` comes first because it is the only entry that can ever
 * yield an actual master: when a SoundCloud artist enables the Download button,
 * yt-dlp can fetch the original uploaded file (frequently WAV or AIFF). Every
 * other entry is a transcode.
 */
export const AUDIO_FORMAT_SELECTOR = [
  "bestaudio[format_id=download]",
  "bestaudio[acodec^=flac]",
  "bestaudio[acodec^=alac]",
  "bestaudio[acodec^=pcm]",
  "bestaudio[acodec=lpcm]",
  "bestaudio[ext=wav]",
  "bestaudio[ext=aiff]",
  "bestaudio[ext=flac]",
  "bestaudio",
  "best",
].join("/");

/**
 * yt-dlp `-S` sorting.
 *
 * Every field sorts descending by default; `+` reverses it. There is no `:desc`
 * modifier — a `:` suffix introduces a *preferred value* (numeric for numeric
 * fields), so the previous `abr:desc,asr:desc,channels:desc,acodec:opus:aac:mp3`
 * was invalid on every term and yt-dlp fell back to its default ordering. That
 * default is resolution-oriented and happily returned YouTube's 128 kbps AAC.
 *
 * `acodec` last is the tiebreak between equal-bitrate streams; yt-dlp's built-in
 * order already puts lossless above opus above aac.
 */
export const AUDIO_FORMAT_SORT = "abr,asr,channels,acodec";

/**
 * YouTube only exposes Premium audio (itag 141 @ 256 kbps AAC, itag 774 @
 * 256 kbps Opus) to certain player clients, and only when authenticated. The
 * plain `web` client additionally needs a PO token now, which is what made the
 * old cookie-stripping retry look like a fix — it "worked" by silently
 * downgrading a paying account to anonymous 128 kbps.
 *
 * `android_vr` leads: it still serves itag 251 without a PO token, and keeps
 * working when cookies have rotated. Bare `tv` is intentionally absent — a
 * YouTube experiment currently DRM-locks every tv https format, which made
 * "Requested format is not available" the only answer for SC→YT mirrors.
 *
 * Overridable because YouTube changes which clients work every few months.
 */
export const DEFAULT_YOUTUBE_PLAYER_CLIENTS =
  "android_vr,default,mweb,web_music";

export function youtubeExtractorArgs(): string {
  const clients =
    process.env.YT_PLAYER_CLIENTS?.trim() || DEFAULT_YOUTUBE_PLAYER_CLIENTS;
  return `youtube:player_client=${clients}`;
}

/**
 * Fail-closed SoundCloud selector: never fall through to an unrestricted
 * `bestaudio` / `best` that would silently accept a 30s preview clip.
 * Geo-blocked and Go+ tracks only expose `*_preview` formats; rejecting those
 * here lets the caller fall back to YouTube instead of shipping a teaser.
 */
export const withoutPreview = (selector: string) => {
  const filtered = selector
    .replaceAll("bestaudio[", "bestaudio[format_id!*=preview][")
    .replace(/\/bestaudio(\/best)?$/, "/bestaudio[format_id!*=preview]")
    .replace(/\/best$/, "");
  // Belt-and-suspenders: if the input had no trailing fallback group, still
  // ensure every bare bestaudio picks up the preview exclusion.
  if (!filtered.includes("format_id!*=preview")) {
    return `${filtered}/bestaudio[format_id!*=preview]`;
  }
  return filtered;
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

export const isLosslessSource = (codec: string, filePath = "") => {
  const lowerCodec = codec.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  return (
    isPcmSource(codec, filePath) ||
    lowerCodec === "flac" ||
    lowerCodec === "alac" ||
    lowerPath.endsWith(".flac") ||
    lowerPath.endsWith(".aiff")
  );
};

/**
 * Human-readable quality summary.
 *
 * Takes the measured spectral cutoff when one is available, because the codec
 * name alone cannot distinguish a real ALAC master from a 128 kbps stream
 * rewrapped as ALAC — the situation this whole module exists to catch.
 */
export const audioQualityLabel = (
  target: AudioTargetFormat,
  codec: string,
  filePath = "",
  cutoffHz?: number,
) => {
  const lowerCodec = codec.toLowerCase();
  const label = target === "alac" ? "ALAC" : target.toUpperCase();
  const lossless = isLosslessSource(codec, filePath);

  // A lossless-looking source that stops short of ~19 kHz was lossy upstream.
  const launderedLossy =
    lossless && typeof cutoffHz === "number" && cutoffHz > 0 && cutoffHz < 19000;

  if (launderedLossy) {
    return `${label} — lossy source rewrapped (content stops at ${(
      cutoffHz / 1000
    ).toFixed(1)} kHz)`;
  }

  if (lossless) {
    const sameFormat =
      (target === "wav" && isPcmSource(codec, filePath)) ||
      (target === "flac" && lowerCodec === "flac") ||
      (target === "alac" && lowerCodec === "alac");
    return sameFormat
      ? `Lossless (original ${lowerCodec.toUpperCase() || "PCM"})`
      : `${label} from lossless source`;
  }

  const cutoffNote =
    typeof cutoffHz === "number" && cutoffHz > 0
      ? `, content to ${(cutoffHz / 1000).toFixed(1)} kHz`
      : "";
  return `${label} converted from ${
    lowerCodec || "unknown"
  } source (no quality gain${cutoffNote})`;
};
