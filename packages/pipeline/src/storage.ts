import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { planUploadParts, safeUserId, UPLOAD_PART_SIZE } from "@thumper/shared";
import { assertPathInside, dataRoot, userRoot } from "./paths";

const R2_ENV = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;

export { planUploadParts, UPLOAD_PART_SIZE };

const PRESIGN_UPLOAD_SECONDS = 3600;
const PRESIGN_DOWNLOAD_SECONDS = 900;

export function hasObjectStorage(): boolean {
  return R2_ENV.every((name) => Boolean(process.env[name]?.trim()));
}

export { safeUserId };

/** Object key / relative path under the user prefix. */
export function userStorageKey(userId: string, ...parts: string[]): string {
  return ["users", safeUserId(userId), ...parts].join("/");
}

export function storageKeyForUser(userId: string, relativePath: string): string {
  if (relativePath.includes("/")) {
    return relativePath.startsWith("users/") ? relativePath : userStorageKey(userId, relativePath);
  }
  return userStorageKey(userId, relativePath);
}

export function assertOwnedUploadKey(userId: string, key: string): void {
  const expected = `users/${safeUserId(userId)}/uploads/`;
  if (!key.startsWith(expected) || key.includes("..")) {
    throw new Error("Invalid upload path");
  }
}

function r2Config(): {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
} {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET are required",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint: process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

function s3(): S3Client {
  const cfg = r2Config();
  return new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    // AWS SDK v3 default checksums break R2 presigned PUT/UploadPart.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function bucket(): string {
  return r2Config().bucket;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = "name" in err ? String(err.name) : "";
  if (name === "NotFound" || name === "NoSuchKey") return true;
  const status =
    "$metadata" in err &&
    typeof err.$metadata === "object" &&
    err.$metadata &&
    "httpStatusCode" in err.$metadata
      ? err.$metadata.httpStatusCode
      : undefined;
  return status === 404;
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

export type BrowserUploadPart = { partNumber: number; url: string };

export type BrowserUploadSession =
  | { strategy: "put"; key: string; url: string }
  | { strategy: "multipart"; key: string; uploadId: string; parts: BrowserUploadPart[] };

export async function createBrowserUpload(params: {
  key: string;
  contentType: string;
  sizeBytes: number;
}): Promise<BrowserUploadSession> {
  const plan = planUploadParts(params.sizeBytes);
  const client = s3();
  const Bucket = bucket();

  if (plan.strategy === "put") {
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket,
        Key: params.key,
        ContentType: params.contentType,
      }),
      { expiresIn: PRESIGN_UPLOAD_SECONDS },
    );
    return { strategy: "put", key: params.key, url };
  }

  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket,
      Key: params.key,
      ContentType: params.contentType,
    }),
  );
  if (!created.UploadId) throw new Error("R2 did not return an upload id");

  const parts = await Promise.all(
    Array.from({ length: plan.partCount }, async (_, index) => {
      const partNumber = index + 1;
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket,
          Key: params.key,
          UploadId: created.UploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: PRESIGN_UPLOAD_SECONDS },
      );
      return { partNumber, url };
    }),
  );

  return { strategy: "multipart", key: params.key, uploadId: created.UploadId, parts };
}

export async function completeBrowserUpload(params: {
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
}): Promise<void> {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: params.key,
      UploadId: params.uploadId,
      MultipartUpload: {
        Parts: params.parts
          .slice()
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }),
  );
}

export async function abortBrowserUpload(params: { key: string; uploadId: string }): Promise<void> {
  await s3().send(
    new AbortMultipartUploadCommand({
      Bucket: bucket(),
      Key: params.key,
      UploadId: params.uploadId,
    }),
  );
}

export async function presignDownloadUrl(
  key: string,
  options?: {
    contentDisposition?: string;
    contentType?: string;
    expiresIn?: number;
  },
): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: options?.contentDisposition,
      ResponseContentType: options?.contentType,
      ResponseCacheControl: "private, no-store",
    }),
    { expiresIn: options?.expiresIn ?? PRESIGN_DOWNLOAD_SECONDS },
  );
}

export async function putBytes(
  key: string,
  data: Buffer | Uint8Array,
  options?: {
    contentType?: string;
  },
): Promise<StoredObjectMeta> {
  if (hasObjectStorage()) {
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: Buffer.from(data),
        ContentType: options?.contentType,
      }),
    );
    return { key, size: data.byteLength, updatedAt: new Date() };
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

  if (hasObjectStorage()) {
    const { createReadStream } = await import("node:fs");
    const upload = new Upload({
      client: s3(),
      params: {
        Bucket: bucket(),
        Key: key,
        Body: createReadStream(localFilePath),
        ContentType: options?.contentType,
      },
      partSize: UPLOAD_PART_SIZE,
      queueSize: 2,
    });
    await upload.done();
    return { key, size: Number(stat.size), updatedAt: new Date() };
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
  if (hasObjectStorage()) {
    try {
      const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  try {
    return await fs.readFile(localPathFromKey(key));
  } catch {
    return null;
  }
}

export async function headObject(key: string): Promise<StoredObjectMeta | null> {
  if (hasObjectStorage()) {
    try {
      const meta = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
      return {
        key,
        size: meta.ContentLength ?? 0,
        updatedAt: meta.LastModified ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
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
  if (hasObjectStorage()) {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
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

  if (hasObjectStorage()) {
    const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    if (!result.Body) throw new Error(`Missing stored object: ${key}`);
    // Streamed, not buffered: retag/stems inputs run to 500MB and this is the
    // hot path on a container that also has to hold ffmpeg's working set.
    await pipeline(
      Readable.fromWeb(result.Body.transformToWebStream() as NodeReadableStream),
      createWriteStream(destPath),
    );
    return;
  }

  const src = localPathFromKey(key);
  if (path.resolve(src) === path.resolve(destPath)) return;
  await fs.copyFile(src, destPath);
}

/** Resolve bytes for zip assembly (object stream) or a local absolute path. */
export async function resolveDownloadTarget(
  userId: string,
  relativePath: string,
): Promise<
  | {
      kind: "object";
      stream: ReadableStream<Uint8Array>;
      size: number;
      contentType: string;
    }
  | { kind: "file"; absolutePath: string }
  | null
> {
  const key = storageKeyForUser(userId, relativePath);

  if (hasObjectStorage()) {
    try {
      const result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      if (!result.Body) return null;
      return {
        kind: "object",
        stream: result.Body.transformToWebStream(),
        size: result.ContentLength ?? 0,
        contentType: result.ContentType || "application/octet-stream",
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  const absolute = assertPathInside(userRoot(userId), path.join(userRoot(userId), relativePath));
  try {
    await fs.stat(absolute);
    return { kind: "file", absolutePath: absolute };
  } catch {
    return null;
  }
}
