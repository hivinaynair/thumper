import { auth } from "@clerk/nextjs/server";
import { files } from "@thumper/db";
import { resolveDownloadTarget } from "@thumper/pipeline/storage";
import { ZipArchive } from "archiver";
import { and, asc, eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";
import { uniqueZipNames } from "./names";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Zip every finished file in the queue. `files` rows cascade-delete with their
 * job, so "everything this user owns" is exactly "everything still in the list".
 *
 * `?jobId=` narrows to one job — used by stem separation, which is the only
 * job shape that produces more than one file (instrumental + vocals).
 * The userId predicate is kept alongside it so a guessed jobId leaks nothing.
 */
export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobId = new URL(req.url).searchParams.get("jobId")?.trim();

  const db = getDb();
  const rows = await db
    .select()
    .from(files)
    .where(
      jobId
        ? and(eq(files.userId, userId), eq(files.jobId, jobId))
        : eq(files.userId, userId),
    )
    .orderBy(asc(files.createdAt));

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No files to download" },
      { status: 404 },
    );
  }

  const names = uniqueZipNames(rows.map((row) => row.filename));

  // Store-only: FLAC is already compressed, so deflate would burn CPU for ~0%.
  const archive = new ZipArchive({ store: true });
  // A file that vanished from storage shouldn't kill the whole archive.
  archive.on("warning", () => {});

  void (async () => {
    try {
      for (const [index, row] of rows.entries()) {
        const target = await resolveDownloadTarget(userId, row.relativePath);
        if (!target) continue;
        const name = names[index]!;
        if (target.kind === "blob") {
          archive.append(
            Readable.fromWeb(target.stream as NodeWebReadableStream),
            { name },
          );
        } else {
          archive.append(createReadStream(target.absolutePath), { name });
        }
      }
      await archive.finalize();
    } catch (err) {
      archive.abort();
      archive.destroy(err instanceof Error ? err : new Error("Zip failed"));
    }
  })();

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(Readable.toWeb(archive) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="thumper-${stamp}.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}
