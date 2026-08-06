import { auth } from "@clerk/nextjs/server";
import { jobs } from "@thumper/db";
import { headObject, safeUserId } from "@thumper/pipeline";
import {
  CreateRetagJobInputSchema,
  detectSourceKind,
  QUEUE_NAME_DOWNLOAD,
} from "@thumper/shared";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getBoss } from "../../../../lib/boss";
import { getDb } from "../../../../lib/db";
import { wakeModalJob } from "../../../../lib/wake-modal";

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

  const parsed = CreateRetagJobInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const kind = detectSourceKind(input.metadataUrl);
  if (kind !== "soundcloud" && kind !== "spotify") {
    return NextResponse.json(
      { error: "metadataUrl must be a SoundCloud or Spotify track URL" },
      { status: 400 },
    );
  }

  // Uploads live under users/<id>/uploads/ — reject cross-user keys.
  const expectedPrefix = `users/${safeUserId(userId)}/`;
  if (
    !input.inputStorageKey.startsWith(expectedPrefix) ||
    input.inputStorageKey.includes("..")
  ) {
    return NextResponse.json({ error: "Invalid inputStorageKey" }, { status: 400 });
  }

  const meta = await headObject(input.inputStorageKey);
  if (!meta) {
    return NextResponse.json(
      { error: "Uploaded WAV not found — upload again" },
      { status: 404 },
    );
  }

  const db = getDb();
  const [job] = await db
    .insert(jobs)
    .values({
      userId,
      sourceUrl: input.metadataUrl,
      sourceKind: kind,
      audioFormat: "aiff",
      destination: "browser",
      title: input.titleHint,
      artist: input.artistHint,
      status: "queued",
      stage: "queued",
      progress: 0,
      result: {
        retag: true,
        inputStorageKey: input.inputStorageKey,
      },
    })
    .returning();

  if (!job) {
    return NextResponse.json({ error: "Failed to create job" }, { status: 500 });
  }

  const backend = (process.env.PROCESS_BACKEND ?? "pgboss").toLowerCase();

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
    const bossId =
      (await boss.send(QUEUE_NAME_DOWNLOAD, { jobId: job.id })) ?? null;
    await db
      .update(jobs)
      .set({ pgBossId: bossId, updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
  }

  return NextResponse.json({ job }, { status: 201 });
}
