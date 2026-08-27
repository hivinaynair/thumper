# syntax=docker/dockerfile:1

FROM oven/bun:1.3-debian AS base
USER root

ARG DENO_VERSION=2.6.10
ENV DENO_INSTALL=/usr/local

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg ca-certificates chromium curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deno.land/install.sh | sh -s "v${DENO_VERSION}" \
    && deno --version \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U \
        pip "yt-dlp[default]" mutagen

COPY scripts/chromium-worker /usr/local/bin/chromium-worker
RUN groupadd --system --gid 922 chromium-worker \
    && useradd --system --uid 922 --gid chromium-worker \
        --home-dir /var/lib/chromium --create-home \
        --shell /usr/sbin/nologin chromium-worker \
    && chmod 0755 /usr/local/bin/chromium-worker \
    && install -d -o 922 -g 922 -m 0700 /var/lib/chromium/xdg /var/lib/chromium/tmp

ENV PATH="/opt/venv/bin:/usr/local/bin:$PATH"
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium-worker
ENV PUPPETEER_RUN_UID=922
ENV PUPPETEER_RUN_GID=922
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock turbo.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/extension/package.json apps/extension/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN bun install --frozen-lockfile

FROM deps AS source
COPY . .

FROM source AS web-build
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN bunx turbo run build --filter=web

FROM source AS worker-build
RUN bunx turbo run build --filter=worker

FROM base AS web
ENV NODE_ENV=production
ENV PORT=3004
ENV DATA_DIR=/data
# check this if it is needed(if not needed remove it as it as required for the docker build)
COPY --from=web-build /app /app
RUN mkdir -p /data && chown -R bun:bun /data
WORKDIR /app/apps/web
EXPOSE 3004
USER bun
CMD ["bun", "x", "next", "start", "-p", "3004"]

FROM base AS worker
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV YT_DLP_PATH=/opt/venv/bin/yt-dlp
# check this if it is needed(if not needed remove it as it as required for the docker build)
COPY --from=worker-build /app /app
RUN mkdir -p /data && chown -R root:root /data && chmod 0700 /data
WORKDIR /app/apps/worker
USER root
CMD ["/bin/sh", "-c", "umask 077 && exec bun run start"]
