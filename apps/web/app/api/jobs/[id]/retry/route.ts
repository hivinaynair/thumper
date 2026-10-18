import { auth } from "@clerk/nextjs/server";
import { jobs } from "@thumper/db";
import { getCookieStatus } from "@thumper/pipeline/cookies";
import { mapWithConcurrency, QUEUE_NAME_DOWNLOAD } from "@thumper/shared";
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getBoss } from "../../../../../lib/boss";
import { jobsToRetry, splitByCookieReadiness } from "../../../../../lib/cookie-retry";
import { getDb } from "../../../../../lib/db";
import {
  clearedFailureResult,
  downloadPayloadFromJob,
  type JobResultMeta,
  playlistContextForChild,
  requeueFields,
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

  const childIds = Array.isArray((target.result as JobResultMeta | null)?.childJobIds)
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
    return NextResponse.json({ error: "Nothing to retry with new cookies" }, { status: 409 });
  }

  const cookies = await getCookieStatus(userId);
  const { ready, blocked, reason } = splitByCookieReadiness(targets, cookies);
  if (ready.length === 0) {
    return NextResponse.json({ error: reason ?? "Nothing to retry" }, { status: 400 });
  }

  const targetIds = ready.map((row) => row.id);

  const backend = (process.env.PROCESS_BACKEND ?? "pgboss").toLowerCase();
  const retryTargets = catalog.filter((job) => targetIds.includes(job.id));

  // One queue handle for the whole retry rather than one per child.
  const boss = backend === "modal" ? null : await getBoss();
  if (boss) await boss.createQueue(QUEUE_NAME_DOWNLOAD);

  // Waking is a round trip each; a playlist retry would otherwise serialise
  // dozens of them into one serverless request.
  const outcomes = await mapWithConcurrency(retryTargets, 8, async (row) => {
    const ctxForChild = playlistContextForChild(row.id, catalog);
    // Per row rather than one bulk update, because the stale failure flags
    // being cleared differ per row. Before the enqueue, never after: a worker
    // that picks the job up must never find it still marked failed.
    await db
      .update(jobs)
      .set({
        ...requeueFields(),
        result: clearedFailureResult(row.result as Record<string, unknown> | null),
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.userId, userId), eq(jobs.id, row.id)));
    try {
      if (boss) {
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
            ...(ctxForChild.driveFolderId ? { driveFolderId: ctxForChild.driveFolderId } : {}),
          },
        });
        const bossId = await boss.send(QUEUE_NAME_DOWNLOAD, {
          ...payload,
          ...(ctxForChild.parentJobId ? { parentJobId: ctxForChild.parentJobId } : {}),
        });
        await db
          .update(jobs)
          .set({ pgBossId: bossId ?? null, updatedAt: new Date() })
          .where(eq(jobs.id, row.id));
      } else {
        await wakeModalJob(row.id);
      }
      return true;
    } catch (err) {
      await db
        .update(jobs)
        .set({
          status: "failed",
          stage: "error",
          error: err instanceof Error ? err.message : "Failed to wake worker",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, row.id));
      return false;
    }
  });

  const woken = outcomes.filter(Boolean).length;
  const failures = outcomes.length - woken;

  if (woken === 0) {
    return NextResponse.json(
      {
        error:
          failures > 0 ? "Failed to wake worker for retry" : "Nothing to retry with new cookies",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    retried: woken,
    failedToWake: failures,
    skipped: blocked.length,
    skippedReason: blocked.length > 0 ? reason : null,
  });
}
