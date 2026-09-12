import { createClerkClient } from "@clerk/backend";
import { createDb, jobs } from "@thumper/db";
import { type PlaylistEntry, runDownloadJob, sweepExpiredFiles } from "@thumper/pipeline";
import {
  type DownloadJobPayload,
  DownloadJobPayloadSchema,
  detectSourceKind,
  QUEUE_NAME_DOWNLOAD,
} from "@thumper/shared";
import { and, eq, inArray } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import pino from "pino";
import { z } from "zod";
import { makeGoogleTokenFetcher, makeUpdateJob } from "./job-store";
import { childJobResult } from "./playlist-fanout";

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

const updateJob = makeUpdateJob(db);
const getGoogleAccessToken = makeGoogleTokenFetcher(clerk, log);

async function main() {
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err: Error) => log.error({ err }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(QUEUE_NAME_DOWNLOAD);

  setInterval(async () => {
    // Only this worker's in-flight jobs are abortable, so an idle worker has
    // nothing to look up and a busy one need only read the rows it holds.
    const running = [...abortControllers.keys()];
    if (running.length === 0) return;
    try {
      const cancelling = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, "cancelling"), inArray(jobs.id, running)));
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
      if (kind !== "youtube" && kind !== "soundcloud") continue;

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
    kind: "youtube" | "soundcloud",
    context?: { driveFolderId?: string },
  ): Promise<string> {
    const result = childJobResult(parent, context);
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
        result,
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
          enqueueChildTracks: (tracks, context) => enqueueChildTracks(payload, tracks, context),
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

  log.info({ concurrency: env.WORKER_CONCURRENCY }, "Thumper worker listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
