import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
]);

export const jobStageEnum = pgEnum("job_stage", [
  "queued",
  "resolving",
  "downloading",
  "converting",
  "delivering",
  "cleanup",
  "done",
  "error",
]);

export const audioFormatEnum = pgEnum("audio_format", [
  "flac",
  "wav",
  "alac",
  "aiff",
]);

export const destinationEnum = pgEnum("destination", [
  "browser",
  "drive",
  "both",
]);

export const sourceKindEnum = pgEnum("source_kind", [
  "youtube",
  "soundcloud",
  "spotify",
  "patreon",
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  status: jobStatusEnum("status").notNull().default("queued"),
  stage: jobStageEnum("stage").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  sourceKind: sourceKindEnum("source_kind"),
  sourceUrl: text("source_url").notNull(),
  matchedUrl: text("matched_url"),
  title: text("title"),
  artist: text("artist"),
  audioFormat: audioFormatEnum("audio_format").notNull().default("aiff"),
  destination: destinationEnum("destination").notNull().default("browser"),
  error: text("error"),
  pgBossId: text("pg_boss_id"),
  result: jsonb("result").$type<{
    fileId?: string;
    relativePath?: string;
    driveFileId?: string;
    driveUrl?: string;
    qualityLabel?: string;
    /** Set on the parent job of an expanded playlist; the tracks are children. */
    playlist?: boolean;
    trackCount?: number;
    childJobIds?: string[];
    /** Spotify tracks with no confident YT/SC mirror — never became children. */
    unmatchedCount?: number;
    matchScore?: number;
    /** Measured DJ suitability of the *source* stream, not the container. */
    djTier?: "master" | "club" | "marginal" | "unsuitable";
    djHeadline?: string;
    warnings?: string[];
    sourceCodec?: string;
    sourceBitrateKbps?: number | null;
    cutoffHz?: number;
    /** Retag (WAV→AIFF) jobs store the uploaded input key here. */
    retag?: boolean;
    inputStorageKey?: string;
    /** SoundCloud Free Download via Hypeddit gate → tagged AIFF. */
    hypedditOriginal?: boolean;
    /** Non-Hypeddit purchase_url — user must download manually. */
    manualDownloadUrl?: string;
    manualDownloadTitle?: string | null;
    /** Clerk identity for Hypeddit email gates (set at job create). */
    gateEmail?: string;
    gateName?: string;
    /** SoundCloud: Hypeddit Free Downloads only (no stream / YT fallback). */
    freeDownloadsOnly?: boolean;
  }>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const files = pgTable("files", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  relativePath: text("relative_path").notNull(),
  filename: text("filename").notNull(),
  mime: text("mime"),
  sizeBytes: integer("size_bytes"),
  driveFileId: text("drive_file_id"),
  driveUrl: text("drive_url"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  defaultFormat: audioFormatEnum("default_format").notNull().default("aiff"),
  defaultDestination: destinationEnum("default_destination")
    .notNull()
    .default("browser"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
