import { z } from "zod";

/**
 * Output formats. FLAC only: it stores bit-identical PCM in ~60% of AIFF's
 * space with native, extensible tagging. AIFF stays a recognised *input*.
 */
export const AudioFormatSchema = z.enum(["flac"]);
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

export const DeliveryDestinationSchema = z.enum(["browser", "drive", "both"]);
export type DeliveryDestination = z.infer<typeof DeliveryDestinationSchema>;

/** Google OAuth scope required for Drive delivery (`drive.file`). */
export const GOOGLE_DRIVE_FILE_SCOPE =
  "https://www.googleapis.com/auth/drive.file";

export const GOOGLE_DRIVE_TOKEN_ERROR =
  "Google Drive selected but no Google token with drive.file — open your account menu and reconnect Google";

export function oauthScopesIncludeDrive(scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) =>
      scope === GOOGLE_DRIVE_FILE_SCOPE ||
      scope.includes("drive.file") ||
      scope === "https://www.googleapis.com/auth/drive" ||
      /(^|\/)drive$/.test(scope),
  );
}

export const SourceKindSchema = z.enum([
  "youtube",
  "soundcloud",
  "spotify",
  "patreon",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** Accepted inputs. Spotify is catalog-only — audio is mirrored from YT/SC. */
export const SupportedSourceKindSchema = z.enum([
  "youtube",
  "soundcloud",
  "spotify",
]);
export type SupportedSourceKind = z.infer<typeof SupportedSourceKindSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobStageSchema = z.enum([
  "queued",
  "resolving",
  "downloading",
  "converting",
  "delivering",
  "cleanup",
  "done",
  "error",
]);
export type JobStage = z.infer<typeof JobStageSchema>;

export const CreateJobInputSchema = z.object({
  url: z.string().url(),
  audioFormat: AudioFormatSchema.default("flac"),
  destination: DeliveryDestinationSchema.default("browser"),
  titleHint: z.string().optional(),
  artistHint: z.string().optional(),
  /**
   * SoundCloud only: skip streams / YouTube mirrors. Only Hypeddit Free
   * Download gates and artist originals are delivered; other tracks fail.
   */
  freeDownloadsOnly: z.boolean().optional().default(false),
  /**
   * Reject any track whose measured tier is not club-ready (see `isClubReady`),
   * after trying alternate sources. Applies to every source kind, not just
   * SoundCloud — a YouTube-only job can flunk the bar just as easily.
   */
  clubReadyOnly: z.boolean().optional().default(false),
});
export type CreateJobInput = z.infer<typeof CreateJobInputSchema>;

export const QUEUE_NAME_DOWNLOAD = "thumper.download" as const;
export const MAX_PLAYLIST_TRACKS = 100;

export const DownloadJobPayloadSchema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().min(1),
  /** URL to download (YouTube/SoundCloud). For Spotify parents this is the Spotify URL. */
  url: z.string().url(),
  audioFormat: AudioFormatSchema,
  destination: DeliveryDestinationSchema,
  titleHint: z.string().optional(),
  artistHint: z.string().optional(),
  parentJobId: z.string().uuid().optional(),
  /** Provenance when mirrored from Spotify. */
  spotifyUrl: z.string().url().optional(),
  /**
   * Google Drive folder id for `Thumper/<playlist>/`. Set on child tracks by
   * the parent playlist job so every upload lands in the same subfolder.
   */
  driveFolderId: z.string().min(1).optional(),
  /**
   * Clerk primary email / display name for Hypeddit email gate steps.
   * Set at job create; playlist children inherit from the parent payload.
   */
  gateEmail: z.string().email().optional(),
  gateName: z.string().min(1).optional(),
  /** When true, SoundCloud jobs only take Hypeddit Free Downloads. */
  freeDownloadsOnly: z.boolean().optional().default(false),
  /** When true, only club-ready sources are delivered; the rest fail. */
  clubReadyOnly: z.boolean().optional().default(false),
});
export type DownloadJobPayload = z.infer<typeof DownloadJobPayloadSchema>;

/**
 * Audio the retag flow accepts. The pipeline itself is codec-agnostic —
 * convertAudio probes the real format and the extension is only a hint — so
 * this list exists to reject obvious non-audio at the upload boundary, not
 * because anything downstream needs WAV.
 */
export const RETAG_INPUT_EXTENSIONS = ["wav", "mp3", "m4a", "flac"] as const;

export const RETAG_INPUT_CONTENT_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/flac",
  "audio/x-flac",
  // Browsers routinely send this for audio dragged off a disk.
  "application/octet-stream",
] as const;

/** Human list for error copy: "WAV, MP3, M4A, or FLAC". */
export const RETAG_INPUT_LABEL = "WAV, MP3, M4A, or FLAC";

export function retagInputExtension(filename: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  const ext = match?.[1]?.toLowerCase();
  return ext && (RETAG_INPUT_EXTENSIONS as readonly string[]).includes(ext)
    ? ext
    : null;
}

/**
 * Content type is advisory: browsers report `application/octet-stream` for
 * plenty of real audio, so a recognised extension alone is enough.
 */
export function isRetagInput(filename: string, contentType = ""): boolean {
  if (retagInputExtension(filename)) return true;
  const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (RETAG_INPUT_CONTENT_TYPES as readonly string[]).includes(type)
    && type !== "application/octet-stream";
}

export const CreateRetagJobInputSchema = z.object({
  inputStorageKey: z.string().min(1),
  metadataUrl: z.string().url(),
  titleHint: z.string().optional(),
  artistHint: z.string().optional(),
  destination: DeliveryDestinationSchema.default("browser"),
});
export type CreateRetagJobInput = z.infer<typeof CreateRetagJobInputSchema>;

export const RetagJobPayloadSchema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().min(1),
  /** Storage key for the uploaded WAV (Blob or DATA_DIR). */
  inputStorageKey: z.string().min(1),
  /** SoundCloud or Spotify URL used for tags + artwork. */
  metadataUrl: z.string().url(),
  titleHint: z.string().optional(),
  artistHint: z.string().optional(),
  destination: DeliveryDestinationSchema.default("browser"),
  driveFolderId: z.string().optional(),
  /** Set when the input came from a Hypeddit Free Download gate. */
  hypedditOriginal: z.boolean().optional(),
  clubReadyOnly: z.boolean().optional().default(false),
});
export type RetagJobPayload = z.infer<typeof RetagJobPayloadSchema>;

export function detectSourceKind(url: string): SourceKind | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("youtube.com") || host === "youtu.be") return "youtube";
    if (host.includes("soundcloud.com")) return "soundcloud";
    if (host.includes("spotify.com")) return "spotify";
    if (host.includes("patreon.com")) return "patreon";
    return null;
  } catch {
    return null;
  }
}

/** A URL that names a collection rather than a single track. */
export function isPlaylistUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("youtube.com")) {
      return (
        parsed.pathname.startsWith("/playlist") ||
        parsed.searchParams.has("list")
      );
    }
    if (host.includes("soundcloud.com")) {
      return /\/sets\//.test(parsed.pathname);
    }
    if (host.includes("spotify.com")) {
      return /\/(playlist|album)\//.test(parsed.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

export function isSupportedSource(url: string): boolean {
  const kind = detectSourceKind(url);
  return kind === "youtube" || kind === "soundcloud" || kind === "spotify";
}

export function looksLikePlaylistUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host.includes("youtube.com") || host === "youtu.be") {
      if (path.includes("/playlist")) return true;
      if (u.searchParams.has("list")) return true;
    }
    if (host.includes("soundcloud.com") && path.includes("/sets/")) return true;
    if (host.includes("spotify.com")) {
      if (path.includes("/playlist/") || path.includes("/album/")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function sanitizeFilename(name: string, maxLen = 120): string {
  return (
    name
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E]/g, '"')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen) || "track"
  );
}

/** Collapse to alphanumerics so "bread.man" matches "BREAD.MAN". */
function normArtistToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Build a display / file title from artist + track.
 * Remix uploads often already credit the remixer in parentheses
 * ("… (grayshift remix)"), so prefixing artist again doubles the name.
 */
export function trackDisplayName(
  artist: string | null | undefined,
  title: string | null | undefined,
): string {
  const t = (title ?? "").trim() || "track";
  const a = (artist ?? "").trim();
  if (!a) return t;

  const na = normArtistToken(a);
  if (na.length >= 2 && normArtistToken(t).includes(na)) {
    return t;
  }
  return `${a} - ${t}`;
}
