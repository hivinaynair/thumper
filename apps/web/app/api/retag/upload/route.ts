import { randomUUID } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { queryFromAudioFilename } from "@thumper/pipeline/retag-search";
import {
  abortBrowserUpload,
  assertOwnedUploadKey,
  completeBrowserUpload,
  createBrowserUpload,
  hasObjectStorage,
  putBytes,
  userStorageKey,
} from "@thumper/pipeline/storage";
import {
  isRetagInput,
  RETAG_INPUT_LABEL,
  retagInputExtension,
  safeUploadName,
} from "@thumper/shared";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

/** Tell the client whether to use direct R2 upload or local multipart. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    mode: hasObjectStorage() ? "object" : "local",
    maxBytes: MAX_BYTES,
  });
}

/**
 * Two modes:
 * - JSON body → R2 presign handshake (client PUTs large WAVs directly)
 * - multipart → local/server putBytes (dev without R2, or small files)
 */
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    if (!hasObjectStorage()) {
      return NextResponse.json({ error: "Object storage is not configured" }, { status: 503 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    try {
      return NextResponse.json(await handleObjectUpload(userId, body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 400 });
    }
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
  if (!isRetagInput(name, file.type)) {
    return NextResponse.json(
      { error: `Only ${RETAG_INPUT_LABEL} files are supported` },
      { status: 400 },
    );
  }

  if (file.size <= 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 500 MB)" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const key = userStorageKey(userId, "uploads", randomUUID(), safeUploadName(name));
  // Keep the browser's type when it gave a real one; the extension carries the
  // format downstream either way.
  await putBytes(key, buf, {
    contentType: file.type || "application/octet-stream",
  });

  return NextResponse.json({
    inputStorageKey: key,
    filename: name,
    sizeBytes: buf.byteLength,
    searchQuery: queryFromAudioFilename(name),
  });
}

async function handleObjectUpload(userId: string, body: Record<string, unknown>) {
  const action = body.action;
  if (action === "create") {
    const filename = String(body.filename ?? "upload.wav");
    const size = Number(body.size);
    const type = String(body.contentType ?? "");
    if (!isRetagInput(filename, type)) {
      throw new Error(`Only ${RETAG_INPUT_LABEL} files are supported`);
    }
    if (!retagInputExtension(filename) && !type) {
      throw new Error(`Only ${RETAG_INPUT_LABEL} files are supported`);
    }
    if (!Number.isFinite(size) || size <= 0) throw new Error("Empty file");
    if (size > MAX_BYTES) throw new Error("File too large (max 500 MB)");

    const key = userStorageKey(userId, "uploads", randomUUID(), safeUploadName(filename));
    const session = await createBrowserUpload({
      key,
      contentType: type || "application/octet-stream",
      sizeBytes: size,
    });
    return {
      ...session,
      filename,
      searchQuery: queryFromAudioFilename(filename),
    };
  }

  if (action === "complete") {
    const key = String(body.key ?? "");
    const uploadId = String(body.uploadId ?? "");
    assertOwnedUploadKey(userId, key);
    const parts = Array.isArray(body.parts)
      ? body.parts.map((part) => {
          const row = part as { partNumber?: unknown; etag?: unknown };
          return { partNumber: Number(row.partNumber), etag: String(row.etag ?? "") };
        })
      : [];
    if (!uploadId || parts.some((part) => !part.partNumber || !part.etag)) {
      throw new Error("Incomplete multipart payload");
    }
    await completeBrowserUpload({ key, uploadId, parts });
    const filename = key.split("/").pop() || key;
    return {
      inputStorageKey: key,
      filename,
      searchQuery: queryFromAudioFilename(filename),
    };
  }

  if (action === "abort") {
    const key = String(body.key ?? "");
    const uploadId = String(body.uploadId ?? "");
    assertOwnedUploadKey(userId, key);
    if (!uploadId) throw new Error("uploadId required");
    await abortBrowserUpload({ key, uploadId });
    return { ok: true };
  }

  throw new Error("Unknown upload action");
}
