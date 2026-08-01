import { auth } from "@clerk/nextjs/server";
import { jobs } from "@thumper/db";
import { QUEUE_NAME_DOWNLOAD } from "@thumper/shared";
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";
import { getBoss } from "../../../../lib/boss";

type Ctx = { params: Promise<{ id: string }> };

type JobResult = {
  playlist?: boolean;
  childJobIds?: string[];
};

export async function GET(_req: Request, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const db = getDb();

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .limit(1);

  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ job });
}

async function cancelBossJobs(
  rows: Array<{ pgBossId: string | null }>,
): Promise<void> {
  const ids = rows.map((r) => r.pgBossId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  try {
    const boss = await getBoss();
    await Promise.all(
      ids.map((bossId) =>
        boss.cancel(QUEUE_NAME_DOWNLOAD, bossId).catch(() => undefined),
      ),
    );
  } catch {
    /* queue may be unavailable — DB status is what the worker polls */
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const db = getDb();

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .limit(1);

  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = (job.result ?? {}) as JobResult;
  const childIds = Array.isArray(result.childJobIds)
    ? result.childJobIds.filter((childId) => typeof childId === "string")
    : [];

  // A finished playlist parent still owns running children — cancelling it
  // must stop those tracks. Lone completed/failed/cancelled jobs are no-ops.
  const parentTerminal =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled";
  if (parentTerminal && childIds.length === 0) {
    return NextResponse.json({ job });
  }

  const targetIds = parentTerminal ? childIds : [id, ...childIds];
  if (targetIds.length === 0) {
    return NextResponse.json({ job });
  }

  const active = await db
    .select({
      id: jobs.id,
      pgBossId: jobs.pgBossId,
      status: jobs.status,
    })
    .from(jobs)
    .where(
      and(eq(jobs.userId, userId), inArray(jobs.id, targetIds)),
    );

  const toCancel = active.filter(
    (row) =>
      row.status !== "completed" &&
      row.status !== "failed" &&
      row.status !== "cancelled",
  );

  if (toCancel.length === 0) {
    return NextResponse.json({ ok: true, cancelled: 0 });
  }

  const cancelIds = toCancel.map((row) => row.id);
  await db
    .update(jobs)
    .set({ status: "cancelling", updatedAt: new Date() })
    .where(inArray(jobs.id, cancelIds));

  await cancelBossJobs(toCancel);

  return NextResponse.json({ ok: true, cancelled: cancelIds.length });
}
