import { auth } from "@clerk/nextjs/server";
import { jobs } from "@thumper/db";
import {
  CreateJobInputSchema,
  detectSourceKind,
  isSupportedSource,
  QUEUE_NAME_DOWNLOAD,
} from "@thumper/shared";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getBoss } from "../../../lib/boss";
import { getDb } from "../../../lib/db";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();

  const rows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.userId, userId))
    .orderBy(desc(jobs.createdAt))
    .limit(100);

  return NextResponse.json({ jobs: rows });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    return NextResponse.json({ error: "Failed to create job" }, { status: 500 });
  }

  const boss = await getBoss();
  await boss.createQueue(QUEUE_NAME_DOWNLOAD);
  const bossId = await boss.send(QUEUE_NAME_DOWNLOAD, {
    jobId: job.id,
    userId,
    url: input.url,
    audioFormat: input.audioFormat,
    destination: input.destination,
    titleHint: input.titleHint,
    artistHint: input.artistHint,
  });

  await db
    .update(jobs)
    .set({ pgBossId: bossId ?? null, updatedAt: new Date() })
    .where(eq(jobs.id, job.id));

  return NextResponse.json({ job: { ...job, pgBossId: bossId } }, { status: 201 });
}
