-- Thumper app schema (pg-boss creates its own tables on start)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE job_status AS ENUM (
  'queued',
  'running',
  'cancelling',
  'cancelled',
  'completed',
  'failed'
);

CREATE TYPE job_stage AS ENUM (
  'queued',
  'resolving',
  'downloading',
  'converting',
  'delivering',
  'cleanup',
  'done',
  'error'
);

CREATE TYPE audio_format AS ENUM ('flac', 'wav', 'alac');
CREATE TYPE destination AS ENUM ('browser', 'drive', 'both');
CREATE TYPE source_kind AS ENUM ('youtube', 'soundcloud', 'spotify', 'patreon');

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  stage job_stage NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0,
  source_kind source_kind,
  source_url text NOT NULL,
  matched_url text,
  title text,
  artist text,
  audio_format audio_format NOT NULL DEFAULT 'flac',
  destination destination NOT NULL DEFAULT 'browser',
  error text,
  pg_boss_id text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_user_id_created_at_idx ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  relative_path text NOT NULL,
  filename text NOT NULL,
  mime text,
  size_bytes integer,
  drive_file_id text,
  drive_url text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_user_id_idx ON files (user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id text PRIMARY KEY,
  default_format audio_format NOT NULL DEFAULT 'flac',
  default_destination destination NOT NULL DEFAULT 'browser',
  updated_at timestamptz NOT NULL DEFAULT now()
);
