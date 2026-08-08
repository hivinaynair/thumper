import { createClerkClient } from "@clerk/backend";
import { createDb, jobs } from "@thumper/db";
import {
  runDownloadJob,
  sweepExpiredFiles,
  type PlaylistEntry,
} from "@thumper/pipeline";
import {
  detectSourceKind,
  DownloadJobPayloadSchema,
  oauthScopesIncludeDrive,
  QUEUE_NAME_DOWNLOAD,
  type DownloadJobPayload,
} from "@thumper/shared";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import pino from "pino";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  COOKIE_ENCRYPTION_KEY: z.string().min(32),
  CLERK_SECRET_KEY: z.string().min(1),
  DATA_DIR: z.string().default("./data"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  LOG_LEVEL: z.string().default("info"),
});

const env = envSchema.parse(process.env);
process.env.DATA_DIR = env.DATA_DIR;
process.env.COOKIE_ENCRYPTION_KEY = env.COOKIE_ENCRYPTION_KEY;

const log = pino({ level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

const abortControllers = new Map<string, AbortController>();

async function getGoogleAccessToken(userId: string): Promise<string | null> {
  try {
    const res = await clerk.users.getUserOauthAccessToken(userId, "google");
    const entry = res.data[0];
    if (!entry?.token) {
      log.warn({ userId }, "No Google OAuth token for user");
      return null;
    }
    const scopes = entry.scopes ?? [];
    if (scopes.length > 0 && !oauthScopesIncludeDrive(scopes)) {
      log.warn({ userId, scopes }, "Google token missing drive.file scope");
      return null;
    }
    return entry.token;
  } catch (err) {
    log.warn({ err, userId }, "Failed to fetch Google OAuth token");
    return null;
  }
}

async function updateJob(
  jobId: string,
  patch: Parameters<Parameters<typeof runDownloadJob>[0]["update"]>[0],
) {
  const values: Record<string, unknown> = {
    updatedAt: new Date(),
  };
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
  await db.update(jobs).set(values).where(eq(jobs.id, jobId));
}

async function main() {
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err: Error) => log.error({ err }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(QUEUE_NAME_DOWNLOAD);

  setInterval(async () => {
    try {
      const cancelling = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.status, "cancelling"));
      for (const row of cancelling) {
        abortControllers.get(row.id)?.abort();
      }
    } catch (err) {
      log.warn({ err }, "cancel poll failed");
    }
  }, 1000).unref();

  async function enqueueChildTracks(
    parent: DownloadJobPayload,
    tracks: PlaylistEntry[],
    context?: { driveFolderId?: string },
  ): Promise<string[]> {
    const childIds: string[] = [];
    for (const track of tracks) {
      const kind = detectSourceKind(track.url) ?? detectSourceKind(parent.url);
      if (kind !== "youtube" && kind !== "soundcloud" && kind !== "bandcamp")
        continue;

      try {
        childIds.push(await enqueueChildTrack(parent, track, kind, context));
      } catch (err) {
        // A track we can't even queue shouldn't cost the user the rest of the
        // playlist; it surfaces in the parent's rollup as a missing child.
        log.warn(
          { err, url: track.url, parentJobId: parent.jobId },
          "Failed to queue playlist track — continuing",
        );
      }
    }
    return childIds;
  }

  async function enqueueChildTrack(
    parent: DownloadJobPayload,
    track: PlaylistEntry,
    kind: "youtube" | "soundcloud" | "bandcamp",
    context?: { driveFolderId?: string },
  ): Promise<string> {
    const [child] = await db
      .insert(jobs)
      .values({
        userId: parent.userId,
        sourceUrl: track.spotifyUrl ?? track.url,
        matchedUrl: track.url,
        sourceKind: kind,
        audioFormat: parent.audioFormat,
        destination: parent.destination,
        title: track.title,
        artist: track.artist,
        status: "queued",
        stage: "queued",
        progress: 0,
        ...((parent.gateEmail || parent.freeDownloadsOnly || parent.clubReadyOnly)
          ? {
              result: {
                ...(parent.gateEmail
                  ? {
                      gateEmail: parent.gateEmail,
                      gateName: parent.gateName,
                    }
                  : {}),
                ...(parent.freeDownloadsOnly
                  ? { freeDownloadsOnly: true }
                  : {}),
                ...(parent.clubReadyOnly ? { clubReadyOnly: true } : {}),
              },
            }
          : {}),
      })
      .returning();
    if (!child) throw new Error("Could not create job row for playlist track");

    const bossId = await boss.send(QUEUE_NAME_DOWNLOAD, {
      jobId: child.id,
      userId: parent.userId,
      url: track.url,
      audioFormat: parent.audioFormat,
      destination: parent.destination,
      titleHint: track.title,
      artistHint: track.artist,
      parentJobId: parent.jobId,
      spotifyUrl: track.spotifyUrl,
      driveFolderId: context?.driveFolderId,
      gateEmail: parent.gateEmail,
      gateName: parent.gateName,
      freeDownloadsOnly: parent.freeDownloadsOnly,
      clubReadyOnly: parent.clubReadyOnly,
    } satisfies DownloadJobPayload);

    await db
      .update(jobs)
      .set({ pgBossId: bossId ?? null, updatedAt: new Date() })
      .where(eq(jobs.id, child.id));

    return child.id;
  }

  await boss.work(
    QUEUE_NAME_DOWNLOAD,
    { localConcurrency: env.WORKER_CONCURRENCY },
    async (jobsBatch: Array<{ data: unknown }>) => {
      const job = jobsBatch[0];
      if (!job) return;
      const parsed = DownloadJobPayloadSchema.safeParse(job.data);
      if (!parsed.success) {
        log.error({ issues: parsed.error.issues }, "Invalid job payload");
        return;
      }
      const payload = parsed.data;
      const ac = new AbortController();
      abortControllers.set(payload.jobId, ac);

      log.info({ jobId: payload.jobId }, "Job started");
      try {
        await runDownloadJob({
          db,
          payload,
          signal: ac.signal,
          update: (patch) => updateJob(payload.jobId, patch),
          getGoogleAccessToken,
          enqueueChildTracks: (tracks, context) =>
            enqueueChildTracks(payload, tracks, context),
        });
      } finally {
        abortControllers.delete(payload.jobId);
        log.info({ jobId: payload.jobId }, "Job finished");
      }
    },
  );

  // Expired files are swept here for disk/Compose deployments. Under Modal the
  // worker is one-shot, so a scheduled function does the sweep instead.
  const sweep = async () => {
    try {
      const { deleted, failed } = await sweepExpiredFiles(db);
      if (deleted || failed) log.info({ deleted, failed }, "Expiry sweep");
    } catch (err) {
      log.warn({ err }, "Expiry sweep failed");
    }
  };
  void sweep();
  setInterval(() => void sweep(), 15 * 60 * 1000).unref();

  log.info(
    { concurrency: env.WORKER_CONCURRENCY },
    "Thumper worker listening",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
