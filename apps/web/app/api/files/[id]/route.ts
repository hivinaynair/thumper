import { auth } from "@clerk/nextjs/server";
import { files } from "@thumper/db";
import { resolveDownloadTarget } from "@thumper/pipeline/storage";
import { and, eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const db = getDb();

  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.userId, userId)))
    .limit(1);

  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const target = await resolveDownloadTarget(userId, file.relativePath);
  if (!target) {
    return NextResponse.json({ error: "File missing" }, { status: 404 });
  }

  if (target.kind === "blob") {
    return new NextResponse(target.stream, {
      headers: {
        "Content-Type":
          target.contentType || file.mime || "application/octet-stream",
        "Content-Length": String(target.size),
        "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  try {
    const stream = createReadStream(target.absolutePath);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": file.mime ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing" }, { status: 404 });
  }
}
