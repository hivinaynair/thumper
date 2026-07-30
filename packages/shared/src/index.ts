import { z } from "zod";

export const AudioFormatSchema = z.enum(["flac", "wav", "alac"]);
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

export const DeliveryDestinationSchema = z.enum(["browser", "drive", "both"]);
export type DeliveryDestination = z.infer<typeof DeliveryDestinationSchema>;

/** DB may still contain legacy values; only youtube + soundcloud are accepted for new jobs. */
export const SourceKindSchema = z.enum([
  "youtube",
  "soundcloud",
  "spotify",
  "patreon",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SupportedSourceKindSchema = z.enum(["youtube", "soundcloud"]);
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
});
export type CreateJobInput = z.infer<typeof CreateJobInputSchema>;

export const QUEUE_NAME_DOWNLOAD = "thumper.download" as const;
export const MAX_PLAYLIST_TRACKS = 100;

export const DownloadJobPayloadSchema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().min(1),
  url: z.string().url(),
  audioFormat: AudioFormatSchema,
  destination: DeliveryDestinationSchema,
  titleHint: z.string().optional(),
  artistHint: z.string().optional(),
  /** Set on child track jobs spawned from a playlist parent. */
  parentJobId: z.string().uuid().optional(),
});
export type DownloadJobPayload = z.infer<typeof DownloadJobPayloadSchema>;

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

export function isSupportedSource(url: string): boolean {
  const kind = detectSourceKind(url);
  return kind === "youtube" || kind === "soundcloud";
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
    if (host.includes("soundcloud.com")) {
      if (path.includes("/sets/")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function sanitizeFilename(name: string, maxLen = 120): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen) || "track"
  );
}
