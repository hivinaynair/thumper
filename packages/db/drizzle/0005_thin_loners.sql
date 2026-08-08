ALTER TYPE "public"."audio_format" ADD VALUE 'aiff';--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "audio_format" SET DEFAULT 'aiff';--> statement-breakpoint
ALTER TABLE "user_settings" ALTER COLUMN "default_format" SET DEFAULT 'aiff';