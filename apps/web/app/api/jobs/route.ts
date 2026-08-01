import { auth } from "@clerk/nextjs/server";
import { jobs } from "@thumper/db";
import { getCookieStatus } from "@thumper/pipeline";
import {
  CreateJobInputSchema,
  detectSourceKind,
  GOOGLE_DRIVE_TOKEN_ERROR,
  isSupportedSource,
  QUEUE_NAME_DOWNLOAD,
} from "@thumper/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getBoss } from "../../../lib/boss";
import { getDb } from "../../../lib/db";
import { userHasGoogleDriveAccess } from "../../../lib/google-drive";
import { wakeModalJob } from "../../../lib/wake-modal";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export async function GET() {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();

  const rows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.userId, userId))
    .orderBy(desc(jobs.createdAt))
    .limit(100);

  return NextResponse.json({ jobs: rows });
}

/** Delete finished jobs (completed / failed / cancelled). Active jobs are kept. */
export async function DELETE() {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();

  // Never wipe a playlist parent that still has active children — clearing the
  // parent while Modal is mid-expand orphans the loop (no row left to cancel).
  const finished = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      result: jobs.result,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        inArray(jobs.status, [...TERMINAL_STATUSES]),
      ),
    );

  const active = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        inArray(jobs.status, ["queued", "running", "cancelling"]),
      ),
    );
  const activeIds = new Set(active.map((row) => row.id));

  const deletable = finished.filter((row) => {
    const childIds = (row.result as { childJobIds?: string[] } | null)
      ?.childJobIds;
    if (!Array.isArray(childIds) || childIds.length === 0) return true;
    return !childIds.some((id) => activeIds.has(id));
  });

  if (deletable.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0 });
  }

  const removed = await db
    .delete(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        inArray(
          jobs.id,
          deletable.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: jobs.id });

  return NextResponse.json({ ok: true, deleted: removed.length });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();

  const body = await req.json();
  const parsed = CreateJobInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const input = parsed.data;
  if (!isSupportedSource(input.url)) {
    return NextResponse.json(
      {
        error:
          "Only YouTube, SoundCloud, or Spotify (mirrored via YT/SC) URLs are supported",
      },
      { status: 400 },
    );
  }

  const sourceKind = detectSourceKind(input.url);
  if (
    sourceKind !== "youtube" &&
    sourceKind !== "soundcloud" &&
    sourceKind !== "spotify"
  ) {
    return NextResponse.json({ error: "Unsupported URL" }, { status: 400 });
  }

  const cookieStatus = await getCookieStatus(userId);
  if (sourceKind === "youtube" && !cookieStatus.youtube.present) {
    return NextResponse.json(
      { error: "Sync YouTube cookies before queuing YouTube downloads" },
      { status: 400 },
    );
  }
  if (sourceKind === "soundcloud" && !cookieStatus.soundcloud.present) {
    return NextResponse.json(
      { error: "Sync SoundCloud cookies before queuing SoundCloud downloads" },
      { status: 400 },
    );
  }
  if (
    sourceKind === "spotify" &&
    !cookieStatus.youtube.present &&
    !cookieStatus.soundcloud.present
  ) {
    return NextResponse.json(
      {
        error:
          "Sync YouTube or SoundCloud cookies before queuing Spotify mirrors",
      },
      { status: 400 },
    );
  }

  if (input.destination === "drive" || input.destination === "both") {
    const hasDrive = await userHasGoogleDriveAccess(userId);
    if (!hasDrive) {
      return NextResponse.json(
        { error: GOOGLE_DRIVE_TOKEN_ERROR },
        { status: 400 },
      );
    }
  }

  const recent = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.userId, userId));
  if (recent.length > 500) {
    return NextResponse.json({ error: "Job limit reached" }, { status: 429 });
  }

  const [job] = await db
    .insert(jobs)
    .values({
      userId,
      sourceUrl: input.url,
      sourceKind,
      audioFormat: input.audioFormat,
      destination: input.destination,
      title: input.titleHint,
      artist: input.artistHint,
      status: "queued",
      stage: "queued",
      progress: 0,
    })
    .returning();

  if (!job) {
    return NextResponse.json(
      { error: "Failed to create job" },
      { status: 500 },
    );
  }

  const backend = (process.env.PROCESS_BACKEND ?? "pgboss").toLowerCase();
  let bossId: string | null = null;

  if (backend === "modal") {
    try {
      await wakeModalJob(job.id);
    } catch (err) {
      await db
        .update(jobs)
        .set({
          status: "failed",
          stage: "error",
          error:
            err instanceof Error ? err.message : "Failed to wake Modal worker",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      return NextResponse.json(
        {
          error:
            err instanceof Error ? err.message : "Failed to wake Modal worker",
        },
        { status: 502 },
      );
    }
  } else {
    const boss = await getBoss();
    await boss.createQueue(QUEUE_NAME_DOWNLOAD);
    bossId =
      (await boss.send(QUEUE_NAME_DOWNLOAD, {
        jobId: job.id,
        userId,
        url: input.url,
        audioFormat: input.audioFormat,
        destination: input.destination,
        titleHint: input.titleHint,
        artistHint: input.artistHint,
      })) ?? null;

    await db
      .update(jobs)
      .set({ pgBossId: bossId, updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
  }

  return NextResponse.json(
    { job: { ...job, pgBossId: bossId } },
    { status: 201 },
  );
}
