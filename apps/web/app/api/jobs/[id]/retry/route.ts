import { auth } from "@clerk/nextjs/server";
import { jobs } from "@thumper/db";
import { getCookieStatus } from "@thumper/pipeline/cookies";
import { QUEUE_NAME_DOWNLOAD } from "@thumper/shared";
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getBoss } from "../../../../../lib/boss";
import {
  jobsToRetry,
  missingCookiesForRetry,
} from "../../../../../lib/cookie-retry";
import { getDb } from "../../../../../lib/db";
import {
  downloadPayloadFromJob,
  playlistContextForChild,
  requeueFields,
  type JobResultMeta,
} from "../../../../../lib/retry-job";
import { wakeModalJob } from "../../../../../lib/wake-modal";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const db = getDb();

  const [target] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const childIds = Array.isArray(
    (target.result as JobResultMeta | null)?.childJobIds,
  )
    ? ((target.result as JobResultMeta).childJobIds ?? []).filter(
        (childId) => typeof childId === "string",
      )
    : [];

  const children =
    childIds.length === 0
      ? []
      : await db
          .select()
          .from(jobs)
          .where(and(eq(jobs.userId, userId), inArray(jobs.id, childIds)));

  const catalog = [target, ...children];
  const targets = jobsToRetry(target, catalog);
  if (targets.length === 0) {
    return NextResponse.json(
      { error: "Nothing to retry with new cookies" },
      { status: 409 },
    );
  }

  const cookies = await getCookieStatus(userId);
  const missing = missingCookiesForRetry(targets, cookies);
  if (missing) {
    return NextResponse.json({ error: missing }, { status: 400 });
  }

  const targetIds = targets.map((row) => row.id);
  const now = new Date();
  await db
    .update(jobs)
    .set({ ...requeueFields(), updatedAt: now })
    .where(and(eq(jobs.userId, userId), inArray(jobs.id, targetIds)));

  const backend = (process.env.PROCESS_BACKEND ?? "pgboss").toLowerCase();
  const woken: string[] = [];
  const failures: string[] = [];

  for (const row of catalog.filter((job) => targetIds.includes(job.id))) {
    const ctxForChild = playlistContextForChild(row.id, catalog);
    try {
      if (backend === "modal") {
        await wakeModalJob(row.id);
      } else {
        const boss = await getBoss();
        await boss.createQueue(QUEUE_NAME_DOWNLOAD);
        const payload = downloadPayloadFromJob({
          id: row.id,
          userId: row.userId,
          sourceUrl: row.sourceUrl,
          matchedUrl: row.matchedUrl,
          title: row.title,
          artist: row.artist,
          audioFormat: row.audioFormat,
          destination: row.destination,
          result: {
            ...(row.result as JobResultMeta | null),
            ...(ctxForChild.driveFolderId
              ? { driveFolderId: ctxForChild.driveFolderId }
              : {}),
          },
        });
        const bossId = await boss.send(QUEUE_NAME_DOWNLOAD, {
          ...payload,
          ...(ctxForChild.parentJobId
            ? { parentJobId: ctxForChild.parentJobId }
            : {}),
        });
        await db
          .update(jobs)
          .set({ pgBossId: bossId ?? null, updatedAt: new Date() })
          .where(eq(jobs.id, row.id));
      }
      woken.push(row.id);
    } catch (err) {
      failures.push(row.id);
      await db
        .update(jobs)
        .set({
          status: "failed",
          stage: "error",
          error:
            err instanceof Error ? err.message : "Failed to wake worker",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, row.id));
    }
  }

  if (woken.length === 0) {
    return NextResponse.json(
      {
        error:
          failures.length > 0
            ? "Failed to wake worker for retry"
            : "Nothing to retry with new cookies",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    retried: woken.length,
    failedToWake: failures.length,
  });
}
