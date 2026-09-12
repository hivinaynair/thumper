import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { safeUserId } from "@thumper/shared";
import { del, get, head, put } from "@vercel/blob";
import { assertPathInside, dataRoot, userRoot } from "./paths";

export function hasBlobStorage(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

export { safeUserId };

/** Object key / relative path under the user prefix. */
export function userStorageKey(userId: string, ...parts: string[]): string {
  return ["users", safeUserId(userId), ...parts].join("/");
}

function blobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is required");
  return token;
}

function localPathFromKey(key: string): string {
  const absolute = path.join(dataRoot(), ...key.split("/"));
  return assertPathInside(dataRoot(), absolute);
}

export type StoredObjectMeta = {
  key: string;
  size: number;
  updatedAt: Date | null;
  url?: string;
  downloadUrl?: string;
};

export async function putBytes(
  key: string,
  data: Buffer | Uint8Array,
  options?: {
    contentType?: string;
  },
): Promise<StoredObjectMeta> {
  if (hasBlobStorage()) {
    const blob = await put(key, Buffer.from(data), {
      access: "private",
      token: blobToken(),
      contentType: options?.contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return {
      key,
      size: data.byteLength,
      updatedAt: new Date(),
      url: blob.url,
      downloadUrl: blob.downloadUrl,
    };
  }

  const file = localPathFromKey(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, { mode: 0o600 });
  return { key, size: data.byteLength, updatedAt: new Date() };
}

export async function putLocalFile(
  key: string,
  localFilePath: string,
  options?: {
    contentType?: string;
  },
): Promise<StoredObjectMeta> {
  const stat = await fs.stat(localFilePath);

  if (hasBlobStorage()) {
    const { createReadStream } = await import("node:fs");
    const blob = await put(key, createReadStream(localFilePath), {
      access: "private",
      token: blobToken(),
      contentType: options?.contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      multipart: stat.size > 4 * 1024 * 1024,
    });
    return {
      key,
      size: Number(stat.size),
      updatedAt: new Date(),
      url: blob.url,
      downloadUrl: blob.downloadUrl,
    };
  }

  // Local mode: already on disk under DATA_DIR — copy if needed
  const dest = localPathFromKey(key);
  if (path.resolve(localFilePath) !== path.resolve(dest)) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(localFilePath, dest);
  }
  return { key, size: Number(stat.size), updatedAt: stat.mtime };
}

export async function readBytes(key: string): Promise<Buffer | null> {
  if (hasBlobStorage()) {
    const result = await get(key, {
      access: "private",
      token: blobToken(),
    });
    if (result?.statusCode !== 200) return null;
    const ab = await new Response(result.stream).arrayBuffer();
    return Buffer.from(ab);
  }

  try {
    return await fs.readFile(localPathFromKey(key));
  } catch {
    return null;
  }
}

export async function headObject(key: string): Promise<StoredObjectMeta | null> {
  if (hasBlobStorage()) {
    try {
      const meta = await head(key, { token: blobToken() });
      return {
        key,
        size: meta.size,
        updatedAt: meta.uploadedAt ?? null,
        url: meta.url,
        downloadUrl: meta.downloadUrl,
      };
    } catch {
      return null;
    }
  }

  try {
    const stat = await fs.stat(localPathFromKey(key));
    if (!stat.isFile() || stat.size <= 0) return null;
    return { key, size: stat.size, updatedAt: stat.mtime };
  } catch {
    return null;
  }
}

export async function deleteObjectStrict(key: string): Promise<void> {
  if (hasBlobStorage()) {
    await del(key, { token: blobToken() });
    return;
  }

  await fs.unlink(localPathFromKey(key));
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await deleteObjectStrict(key);
  } catch {
    /* missing ok */
  }
}

/** Copy a stored object to a local path for ffmpeg / yt-dlp. */
export async function materializeObject(key: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  if (hasBlobStorage()) {
    const result = await get(key, { access: "private", token: blobToken() });
    if (result?.statusCode !== 200) throw new Error(`Missing stored object: ${key}`);
    // Streamed, not buffered: retag/stems inputs run to 500MB and this is the
    // hot path on a container that also has to hold ffmpeg's working set.
    await pipeline(
      Readable.fromWeb(result.stream as unknown as NodeReadableStream),
      createWriteStream(destPath),
    );
    return;
  }

  const src = localPathFromKey(key);
  if (path.resolve(src) === path.resolve(destPath)) return;
  await fs.copyFile(src, destPath);
}

/** Resolve a downloadable URL for browser delivery (blob) or local absolute path. */
export async function resolveDownloadTarget(
  userId: string,
  relativePath: string,
): Promise<
  | {
      kind: "blob";
      stream: ReadableStream<Uint8Array>;
      size: number;
      contentType: string;
    }
  | { kind: "file"; absolutePath: string }
  | null
> {
  const key = relativePath.includes("/")
    ? relativePath.startsWith("users/")
      ? relativePath
      : userStorageKey(userId, relativePath)
    : userStorageKey(userId, relativePath);

  if (hasBlobStorage()) {
    const result = await get(key, {
      access: "private",
      token: blobToken(),
    });
    if (result?.statusCode !== 200) return null;
    return {
      kind: "blob",
      stream: result.stream,
      size: result.blob.size,
      contentType: result.blob.contentType,
    };
  }

  const absolute = assertPathInside(userRoot(userId), path.join(userRoot(userId), relativePath));
  try {
    await fs.stat(absolute);
    return { kind: "file", absolutePath: absolute };
  } catch {
    return null;
  }
}
