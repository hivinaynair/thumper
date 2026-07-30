import { auth } from "@clerk/nextjs/server";
import { files } from "@thumper/db";
import { assertPathInside, userRoot } from "@thumper/pipeline";
import { and, eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const db = getDb();

  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.userId, userId)))
    .limit(1);

  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const absolute = assertPathInside(
    userRoot(userId),
    path.join(userRoot(userId), file.relativePath),
  );

  try {
    const info = await stat(absolute);
    const stream = createReadStream(absolute);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": file.mime ?? "application/octet-stream",
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing" }, { status: 404 });
  }
}
