import { createClerkClient } from "@clerk/backend";
import { createDb, jobs } from "@thumper/db";
import { runDownloadJob } from "@thumper/pipeline";
import {
  DownloadJobPayloadSchema,
  QUEUE_NAME_DOWNLOAD,
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
    if (!entry?.token) return null;
    const scopes = new Set(entry.scopes ?? []);
    if (
      scopes.size > 0 &&
      ![...scopes].some((s) => s.includes("drive.file") || s.includes("drive"))
    ) {
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
  patch: Parameters<
    Parameters<typeof runDownloadJob>[0]["update"]
  >[0],
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
  if (patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled") {
    values.completedAt = new Date();
  }
  await db.update(jobs).set(values).where(eq(jobs.id, jobId));
}

async function main() {
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err: Error) => log.error({ err }, "pg-boss error"));
  await boss.start();

  await boss.createQueue(QUEUE_NAME_DOWNLOAD);

  // Poll for cancel requests
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
        });
      } finally {
        abortControllers.delete(payload.jobId);
        log.info({ jobId: payload.jobId }, "Job finished");
      }
    },
  );

  log.info(
    { concurrency: env.WORKER_CONCURRENCY },
    "Thumper worker listening",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
