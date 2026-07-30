# Thumper

Private friends-and-family DJ audio harvest tool. Turborepo monorepo (**Bun only**):

- `apps/web` — Next.js 16 + Clerk BFF/UI
- `apps/worker` — pg-boss consumer (yt-dlp / FFmpeg), concurrency 1
- `apps/extension` — Chrome MV3 cookie sync (Load unpacked from `apps/extension/dist`)
- `packages/shared` — zod DTOs / URL helpers
- `packages/db` — Drizzle schema (jobs = UI source of truth)
- `packages/pipeline` — download / convert / cookies / Drive

Requires [Bun](https://bun.sh) ≥ 1.3.

## Quick start (local)

```bash
cp .env.example .env
# fill Clerk keys + COOKIE_ENCRYPTION_KEY

docker compose up -d postgres
bun install
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env

# Local worker needs yt-dlp + ffmpeg on PATH (Homebrew on macOS)
brew install yt-dlp ffmpeg

# Clerk: enable invite-only; Google OAuth with custom credentials +
# https://www.googleapis.com/auth/drive.file scope for Drive delivery.
# After changing scopes, reconnect Google from the account menu.
bun run dev
```

- Web: http://localhost:3004  
- Worker: started via `bun run dev` (turbo filter)  
- Extension: `bun run --filter extension build` → Chrome → Load unpacked → `apps/extension/dist`

## Production (Droplet)

~4GB / 2 vCPU recommended. Compose runs `web` + `worker` + `postgres` + `caddy`.

```bash
cp .env.example .env
docker compose up -d --build
```

Point DNS at the droplet and set your domain in `docker/caddy/Caddyfile`.

## Notes

- Package manager is Bun — no pnpm/npm/yarn
- Sources: **YouTube + SoundCloud** (direct) and **Spotify** (catalog only — mirrored via scored YouTube/SoundCloud match, never Spotify audio)
- Playlists supported (max 100 tracks); Spotify mirrors require match score ≥ 78
- Media lives under `DATA_DIR/users/{userId}/` — never under `public/`
- Cookies encrypted at rest (`COOKIE_ENCRYPTION_KEY`)
- SoundCloud preview streams fail closed
- Cancel kills the active yt-dlp/ffmpeg process group
