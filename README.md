# Thumper

Private friends-and-family DJ audio harvest tool. Turborepo monorepo:

- `apps/web` — Next.js 16 + Clerk BFF/UI
- `apps/worker` — pg-boss consumer (yt-dlp / FFmpeg), concurrency 1
- `apps/extension` — Chrome MV3 cookie sync (Load unpacked from `apps/extension/dist`)
- `packages/shared` — zod DTOs / URL helpers
- `packages/db` — Drizzle schema (jobs = UI source of truth)
- `packages/pipeline` — download / convert / cookies / Drive

## Quick start (local)

```bash
cp .env.example .env
# fill Clerk keys + COOKIE_ENCRYPTION_KEY

docker compose up -d postgres
pnpm install
pnpm --filter web exec -- cp .env.example .env.local   # or symlink
pnpm --filter worker exec -- cp .env.example .env

# Clerk: enable invite-only; add Google OAuth with drive.file for Drive delivery
pnpm dev
```

- Web: http://localhost:3000  
- Worker: separate process via `pnpm dev` filter  
- Extension: `pnpm --filter extension build` → Chrome → Load unpacked → `apps/extension/dist`

## Production (Droplet)

~4GB / 2 vCPU recommended. Compose runs `web` + `worker` + `postgres` + `caddy`.

```bash
cp .env.example .env
docker compose up -d --build
```

Point DNS at the droplet and set your domain in `docker/caddy/Caddyfile`.

## Notes

- Media lives under `DATA_DIR/users/{userId}/` — never under `public/`
- Cookies encrypted at rest (`COOKIE_ENCRYPTION_KEY`)
- SoundCloud preview streams fail closed
- Spotify resolves via embed metadata + YouTube search (confirm match when unsure)
- Cancel kills the active yt-dlp/ffmpeg process group
