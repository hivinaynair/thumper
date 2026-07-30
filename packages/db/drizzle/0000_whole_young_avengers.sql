CREATE TYPE "public"."audio_format" AS ENUM('flac', 'wav', 'alac');--> statement-breakpoint
CREATE TYPE "public"."destination" AS ENUM('browser', 'drive', 'both');--> statement-breakpoint
CREATE TYPE "public"."job_stage" AS ENUM('queued', 'resolving', 'downloading', 'converting', 'delivering', 'cleanup', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('youtube', 'soundcloud', 'spotify', 'patreon');--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text,
	"size_bytes" integer,
	"drive_file_id" text,
	"drive_url" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"stage" "job_stage" DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"source_kind" "source_kind",
	"source_url" text NOT NULL,
	"matched_url" text,
	"title" text,
	"artist" text,
	"audio_format" "audio_format" DEFAULT 'flac' NOT NULL,
	"destination" "destination" DEFAULT 'browser' NOT NULL,
	"error" text,
	"pg_boss_id" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"default_format" "audio_format" DEFAULT 'flac' NOT NULL,
	"default_destination" "destination" DEFAULT 'browser' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;