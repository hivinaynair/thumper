import { auth } from "@clerk/nextjs/server";
import { jobs } from "@thumper/db";
import { QUEUE_NAME_DOWNLOAD } from "@thumper/shared";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";
import { getBoss } from "../../../../lib/boss";

type Ctx = { params: Promise<{ id: string }> };

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

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return NextResponse.json({ job });
  }

  await db
    .update(jobs)
    .set({ status: "cancelling", updatedAt: new Date() })
    .where(eq(jobs.id, id));

  if (job.pgBossId) {
    try {
      const boss = await getBoss();
      await boss.cancel(QUEUE_NAME_DOWNLOAD, job.pgBossId);
    } catch {
      /* may already be active */
    }
  }

  return NextResponse.json({ ok: true });
}
