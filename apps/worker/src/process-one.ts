import { createClerkClient } from "@clerk/backend";
import { createDb, jobs } from "@thumper/db";
import { runDownloadJob } from "@thumper/pipeline";
import {
  detectSourceKind,
  oauthScopesIncludeDrive,
  type DownloadJobPayload,
} from "@thumper/shared";
import { eq } from "drizzle-orm";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export async function processJobById(jobId: string): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  requireEnv("COOKIE_ENCRYPTION_KEY");
  const clerkSecret = requireEnv("CLERK_SECRET_KEY");

  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = "/tmp/thumper-data";
  }

  const db = createDb(databaseUrl);
  const clerk = createClerkClient({ secretKey: clerkSecret });

  async function getGoogleAccessToken(userId: string): Promise<string | null> {
    try {
      const res = await clerk.users.getUserOauthAccessToken(userId, "google");
      const entry = res.data[0];
      if (!entry?.token) return null;
      const scopes = entry.scopes ?? [];
      if (scopes.length > 0 && !oauthScopesIncludeDrive(scopes)) return null;
      return entry.token;
    } catch (err) {
      log.warn({ err, userId }, "Failed to fetch Google OAuth token");
      return null;
    }
  }

  async function updateJob(
    id: string,
    patch: Parameters<Parameters<typeof runDownloadJob>[0]["update"]>[0],
  ) {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status) values.status = patch.status;
    if (patch.stage) values.stage = patch.stage;
    if (patch.progress !== undefined) values.progress = patch.progress;
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.artist !== undefined) values.artist = patch.artist;
    if (patch.matchedUrl !== undefined) values.matchedUrl = patch.matchedUrl;
    if (patch.error !== undefined) values.error = patch.error;
    if (patch.result !== undefined) values.result = patch.result;
    if (
      patch.status === "completed" ||
      patch.status === "failed" ||
      patch.status === "cancelled"
    ) {
      values.completedAt = new Date();
    }
    await db.update(jobs).set(values).where(eq(jobs.id, id));
  }

  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw new Error(`Job not found: ${jobId}`);

  const payload: DownloadJobPayload = {
    jobId: row.id,
    userId: row.userId,
    url: row.matchedUrl ?? row.sourceUrl,
    audioFormat: row.audioFormat,
    destination: row.destination,
    titleHint: row.title ?? undefined,
    artistHint: row.artist ?? undefined,
  };

  const ac = new AbortController();

  async function runOne(p: DownloadJobPayload): Promise<void> {
    log.info({ jobId: p.jobId }, "Job started");
    try {
      await runDownloadJob({
        db,
        payload: p,
        signal: ac.signal,
        update: (patch) => updateJob(p.jobId, patch),
        getGoogleAccessToken,
        enqueueChildTracks: async (tracks) => {
          const childIds: string[] = [];
          for (const track of tracks) {
            const kind = detectSourceKind(track.url) ?? detectSourceKind(p.url);
            if (kind !== "youtube" && kind !== "soundcloud") continue;

            const [child] = await db
              .insert(jobs)
              .values({
                userId: p.userId,
                sourceUrl: track.spotifyUrl ?? track.url,
                matchedUrl: track.url,
                sourceKind: kind,
                audioFormat: p.audioFormat,
                destination: p.destination,
                title: track.title,
                artist: track.artist,
                status: "queued",
                stage: "queued",
                progress: 0,
              })
              .returning();
            if (!child) continue;
            childIds.push(child.id);

            await runOne({
              jobId: child.id,
              userId: p.userId,
              url: track.url,
              audioFormat: p.audioFormat,
              destination: p.destination,
              titleHint: track.title,
              artistHint: track.artist,
              parentJobId: p.jobId,
              spotifyUrl: track.spotifyUrl,
            });
          }
          return childIds;
        },
      });
    } finally {
      log.info({ jobId: p.jobId }, "Job finished");
    }
  }

  await runOne(payload);
}
