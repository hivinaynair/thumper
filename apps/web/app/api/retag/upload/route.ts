import { auth } from "@clerk/nextjs/server";
import {
  handleUpload,
  type HandleUploadBody,
} from "@vercel/blob/client";
import {
  putBytes,
  queryFromWavFilename,
  safeUserId,
  useBlobStorage,
  userStorageKey,
} from "@thumper/pipeline";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

function isWav(name: string, type: string): boolean {
  return (
    /\.wav$/i.test(name) || type === "audio/wav" || type === "audio/x-wav"
  );
}

function sanitizeName(name: string): string {
  return name.replace(/[^\w.\- ()]+/g, "_");
}

/** Tell the client whether to use direct Blob upload or local multipart. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    mode: useBlobStorage() ? "blob" : "local",
    maxBytes: MAX_BYTES,
  });
}

/**
 * Two modes:
 * - JSON body → Vercel Blob `handleUpload` (client uploads large WAVs directly)
 * - multipart → local/server putBytes (dev without Blob, or small files)
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  // Client token handshake for @vercel/blob/client upload()
  if (contentType.includes("application/json")) {
    if (!useBlobStorage()) {
      return NextResponse.json(
        { error: "Blob storage is not configured" },
        { status: 503 },
      );
    }

    let body: HandleUploadBody;
    try {
      body = (await req.json()) as HandleUploadBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    try {
      const json = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          const expected = `users/${safeUserId(userId)}/uploads/`;
          if (!pathname.startsWith(expected) || pathname.includes("..")) {
            throw new Error("Invalid upload path");
          }
          if (!/\.wav$/i.test(pathname)) {
            throw new Error("Only WAV files are supported");
          }
          return {
            allowedContentTypes: [
              "audio/wav",
              "audio/x-wav",
              "audio/wave",
              "application/octet-stream",
            ],
            maximumSizeInBytes: MAX_BYTES,
            addRandomSuffix: false,
            allowOverwrite: true,
            tokenPayload: JSON.stringify({ userId }),
          };
        },
      });
      return NextResponse.json(json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  // Local / small multipart upload through the API
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
  if (!isWav(name, file.type)) {
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
    sanitizeName(name),
  );
  await putBytes(key, buf, { contentType: "audio/wav" });

  return NextResponse.json({
    inputStorageKey: key,
    filename: name,
    sizeBytes: buf.byteLength,
    searchQuery: queryFromWavFilename(name),
  });
}
