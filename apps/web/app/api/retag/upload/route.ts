import { auth } from "@clerk/nextjs/server";
import {
  putBytes,
  queryFromWavFilename,
  userStorageKey,
} from "@thumper/pipeline";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart form data with a WAV file" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  const name = file.name || "upload.wav";
  if (!/\.wav$/i.test(name) && file.type !== "audio/wav" && file.type !== "audio/x-wav") {
    return NextResponse.json(
      { error: "Only WAV files are supported" },
      { status: 400 },
    );
  }

  if (file.size <= 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 500 MB)" },
      { status: 400 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const key = userStorageKey(
    userId,
    "uploads",
    randomUUID(),
    name.replace(/[^\w.\- ()]+/g, "_"),
  );
  await putBytes(key, buf, { contentType: "audio/wav" });

  return NextResponse.json({
    inputStorageKey: key,
    filename: name,
    sizeBytes: buf.byteLength,
    searchQuery: queryFromWavFilename(name),
  });
}
