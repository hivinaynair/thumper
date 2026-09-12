import { auth } from "@clerk/nextjs/server";
import { jobs } from "@thumper/db";
import { headObject, safeUserId } from "@thumper/pipeline/storage";
import {
  CreateStemJobInputSchema,
  GOOGLE_DRIVE_TOKEN_ERROR,
  QUEUE_NAME_DOWNLOAD,
} from "@thumper/shared";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getBoss } from "../../../../lib/boss";
import { getDb } from "../../../../lib/db";
import { userHasGoogleDriveAccess } from "../../../../lib/google-drive";
import { wakeModalStemJob } from "../../../../lib/wake-modal";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateStemJobInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const input = parsed.data;

  const expectedPrefix = `users/${safeUserId(userId)}/`;
  if (
    !input.inputStorageKey.startsWith(expectedPrefix) ||
    input.inputStorageKey.includes("..")
  ) {
    return NextResponse.json(
      { error: "Invalid inputStorageKey" },
      { status: 400 },
    );
  }

  const meta = await headObject(input.inputStorageKey);
  if (!meta) {
    return NextResponse.json(
      { error: "Uploaded audio not found — upload again" },
      { status: 404 },
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

  // Stem jobs have no catalog URL, but `jobs.source_url` is NOT NULL. Record
  // where the audio actually came from instead of inventing a fake track URL.
  const uploadedName =
    input.inputStorageKey.split("/").pop() || input.inputStorageKey;
  const displayTitle =
    input.titleHint ?? uploadedName.replace(/\.[a-z0-9]+$/i, "");

  const db = getDb();
  const [job] = await db
    .insert(jobs)
    .values({
      userId,
      sourceUrl: `upload://${uploadedName}`,
      audioFormat: "flac",
      destination: input.destination,
      title: displayTitle,
      artist: input.artistHint,
      status: "queued",
      stage: "queued",
      progress: 0,
      result: {
        stems: true,
        inputStorageKey: input.inputStorageKey,
      },
    })
    .returning();

  if (!job) {
    return NextResponse.json(
      { error: "Failed to create job" },
      { status: 500 },
    );
  }

  const backend = (process.env.PROCESS_BACKEND ?? "pgboss").toLowerCase();

  if (backend === "modal") {
    try {
      await wakeModalStemJob(job.id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to wake Modal stem worker";
      await db
        .update(jobs)
        .set({
          status: "failed",
          stage: "error",
          error: message,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } else {
    const boss = await getBoss();
    await boss.createQueue(QUEUE_NAME_DOWNLOAD);
    const bossId =
      (await boss.send(QUEUE_NAME_DOWNLOAD, { jobId: job.id })) ?? null;
    await db
      .update(jobs)
      .set({ pgBossId: bossId, updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
  }

  return NextResponse.json({ job }, { status: 201 });
}
