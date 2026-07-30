# Thumper

Private friends-and-family DJ audio harvest tool. Turborepo monorepo (**Bun only**):

- `apps/web` — Next.js 16 + Clerk BFF/UI
- `apps/worker` — pg-boss consumer (local) or one-shot `process-job` (Modal)
- `apps/modal` — Modal scale-to-zero worker (yt-dlp / FFmpeg)
- `apps/extension` — Chrome MV3 cookie sync (Load unpacked from `apps/extension/dist`)
- `packages/shared` — zod DTOs / URL helpers
- `packages/db` — Drizzle schema (jobs = UI source of truth)
- `packages/pipeline` — download / convert / cookies / Drive / Blob storage

Requires [Bun](https://bun.sh) ≥ 1.3.

## Quick start (local)

```bash
cp .env.example .env
# fill Clerk keys + COOKIE_ENCRYPTION_KEY + absolute DATA_DIR
# one env file for the whole repo — no per-app .env files

docker compose up -d postgres
bun install

# Local worker needs yt-dlp + ffmpeg on PATH (Homebrew on macOS)
brew install yt-dlp ffmpeg

# Clerk: enable invite-only; Google OAuth with custom credentials +
# https://www.googleapis.com/auth/drive.file scope for Drive delivery.
# After changing scopes, reconnect Google from the account menu.
bun run dev
```

- Web: http://localhost:3004  
- Worker: started via `bun run dev` (turbo filter) — uses `PROCESS_BACKEND=pgboss` (default)
- Extension: `bun run --filter extension build` → Chrome → Load unpacked → `apps/extension/dist`

Local mode stores cookies/media under `DATA_DIR`. Leave `BLOB_READ_WRITE_TOKEN` unset.

Env: one root `.env`, loaded by bun on root scripts and forwarded to each package by
turbo's `globalEnv`. Run tasks from the repo root (`bun run dev`, `bun run dev:web`) —
`cd apps/web && bun run dev` won't see it. New vars must be added to `globalEnv` in
[`turbo.json`](turbo.json) or turbo's strict env mode filters them out.

## Production (Vercel + Modal + Neon + Blob)

Idle-cheap hybrid:

| Piece | Service |
|---|---|
| Web + domains | **Vercel** (`apps/web`) |
| Postgres | **Neon** |
| Downloads | **Modal** (`apps/modal`) |
| Cookies + finished audio | **Vercel Blob** |

1. Create a Neon database; run `bun run db:migrate` with `DATABASE_URL` set.
2. In the Vercel project (Root Directory = `apps/web`), create a **Blob** store (sets `BLOB_READ_WRITE_TOKEN`).
3. Deploy Modal (see [`apps/modal/README.md`](apps/modal/README.md)); copy the wake URL.
4. Vercel env:

```bash
DATABASE_URL=              # Neon
COOKIE_ENCRYPTION_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
BLOB_READ_WRITE_TOKEN=     # from Vercel Blob store
PROCESS_BACKEND=modal
MODAL_JOB_URL=             # Modal wake endpoint
MODAL_WEBHOOK_SECRET=      # same value as in Modal secret
```

5. Clerk: production instance URLs + Google `drive.file` scope as above.

If Modal becomes painful later, swap the worker to **Fly Machines start/stop** and keep Vercel/Neon/Blob — only `PROCESS_BACKEND` / wake URL change.

## Production (Droplet / Compose) — optional

All-in-one on a VM (~4GB / 2 vCPU). Shared `DATA_DIR` volume; no Blob/Modal required.

```bash
cp .env.example .env
docker compose up -d --build
```

Point DNS at the droplet and set your domain in `docker/caddy/Caddyfile`.

## Notes

- Package manager is Bun — no pnpm/npm/yarn
- Sources: **YouTube + SoundCloud** (direct) and **Spotify** (catalog only — mirrored via scored YouTube/SoundCloud match, never Spotify audio)
- Playlists supported (max 100 tracks); Spotify mirrors require match score ≥ 78
- Media: local `DATA_DIR` or Vercel Blob — never under `public/`
- Cookies encrypted at rest (`COOKIE_ENCRYPTION_KEY`)
- SoundCloud preview streams fail closed
- Cancel kills the active yt-dlp/ffmpeg process group (local/pg-boss worker)
