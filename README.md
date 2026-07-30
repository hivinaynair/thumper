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

# Clerk: enable invite-only; add Google OAuth with drive.file for Drive delivery
bun run dev
```

- Web: http://localhost:3000  
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
- Sources: **YouTube + SoundCloud** only (tracks and playlists/sets, max 100 tracks)
- Media lives under `DATA_DIR/users/{userId}/` — never under `public/`
- Cookies encrypted at rest (`COOKIE_ENCRYPTION_KEY`)
- SoundCloud preview streams fail closed
- Cancel kills the active yt-dlp/ffmpeg process group
