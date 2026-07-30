import { z } from "zod";

export const AudioFormatSchema = z.enum(["flac", "wav", "alac"]);
export type AudioFormat = z.infer<typeof AudioFormatSchema>;

export const DeliveryDestinationSchema = z.enum(["browser", "drive", "both"]);
export type DeliveryDestination = z.infer<typeof DeliveryDestinationSchema>;

export const SourceKindSchema = z.enum([
  "youtube",
  "soundcloud",
  "spotify",
  "patreon",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

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
  confirmedMatchUrl: z.string().url().optional(),
  titleHint: z.string().optional(),
  artistHint: z.string().optional(),
});
export type CreateJobInput = z.infer<typeof CreateJobInputSchema>;

export const QUEUE_NAME_DOWNLOAD = "thumper.download" as const;

export const DownloadJobPayloadSchema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().min(1),
  url: z.string().url(),
  audioFormat: AudioFormatSchema,
  destination: DeliveryDestinationSchema,
  confirmedMatchUrl: z.string().url().optional(),
  titleHint: z.string().optional(),
  artistHint: z.string().optional(),
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

export function sanitizeFilename(name: string, maxLen = 120): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen) || "track";
}
