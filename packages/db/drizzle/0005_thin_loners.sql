-- 'aiff' stays a valid enum value: rows written before FLAC became the only
-- output still reference it, and Postgres cannot drop a value from an enum
-- without rebuilding the type. Only the defaults move.
ALTER TYPE "public"."audio_format" ADD VALUE IF NOT EXISTS 'aiff';--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "audio_format" SET DEFAULT 'flac';--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "default_format" SET DEFAULT 'flac';
