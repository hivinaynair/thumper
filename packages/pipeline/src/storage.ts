import { del, get, head, put } from "@vercel/blob";
import fs from "node:fs/promises";
import path from "node:path";
import { assertPathInside, dataRoot, userRoot } from "./paths";

export function useBlobStorage(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

export function safeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

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
  if (useBlobStorage()) {
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

  if (useBlobStorage()) {
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
  if (useBlobStorage()) {
    const result = await get(key, {
      access: "private",
      token: blobToken(),
    });
    if (!result || result.statusCode !== 200) return null;
    const ab = await new Response(result.stream).arrayBuffer();
    return Buffer.from(ab);
  }

  try {
    return await fs.readFile(localPathFromKey(key));
  } catch {
    return null;
  }
}

export async function headObject(
  key: string,
): Promise<StoredObjectMeta | null> {
  if (useBlobStorage()) {
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

export async function deleteObject(key: string): Promise<void> {
  if (useBlobStorage()) {
    try {
      await del(key, { token: blobToken() });
    } catch {
      /* missing ok */
    }
    return;
  }

  try {
    await fs.unlink(localPathFromKey(key));
  } catch {
    /* missing ok */
  }
}

/** Copy a stored object to a local path for ffmpeg / yt-dlp. */
export async function materializeObject(
  key: string,
  destPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  if (useBlobStorage()) {
    const data = await readBytes(key);
    if (!data) throw new Error(`Missing stored object: ${key}`);
    await fs.writeFile(destPath, data);
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

  if (useBlobStorage()) {
    const result = await get(key, {
      access: "private",
      token: blobToken(),
    });
    if (!result || result.statusCode !== 200) return null;
    return {
      kind: "blob",
      stream: result.stream,
      size: result.blob.size,
      contentType: result.blob.contentType,
    };
  }

  const absolute = assertPathInside(
    userRoot(userId),
    path.join(userRoot(userId), relativePath),
  );
  try {
    await fs.stat(absolute);
    return { kind: "file", absolutePath: absolute };
  } catch {
    return null;
  }
}
