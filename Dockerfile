# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U pip yt-dlp mutagen
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/extension/package.json apps/extension/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build --filter=web --filter=worker

FROM base AS web
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
COPY --from=build /app /app
WORKDIR /app/apps/web
EXPOSE 3000
USER node
CMD ["pnpm", "exec", "next", "start", "-p", "3000"]

FROM base AS worker
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV YT_DLP_PATH=/opt/venv/bin/yt-dlp
COPY --from=build /app /app
WORKDIR /app/apps/worker
USER node
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
