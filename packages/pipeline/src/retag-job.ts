import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@thumper/db";
import { files, jobs } from "@thumper/db";
import {
  GOOGLE_DRIVE_TOKEN_ERROR,
  sanitizeFilename,
  trackDisplayName,
  type RetagJobPayload,
} from "@thumper/shared";
import { FILE_TTL_MS } from "./cleanup";
import { convertAudio } from "./convert";
import { uploadToDrive } from "./drive";
import { findFallbackArtworkUrl } from "./artwork-fallback";
import { downloadArtworkFile, resolveTrackTags } from "./metadata";
import { assertPathInside, userRoot } from "./paths";
import { ProcessCancelledError } from "./process";
import {
  materializeObject,
  putLocalFile,
  useBlobStorage,
  userStorageKey,
} from "./storage";
import type { ProgressUpdater } from "./run-job";

export type RunRetagJobDeps = {
  db: Db;
  payload: RetagJobPayload;
  signal: AbortSignal;
  update: ProgressUpdater;
  getGoogleAccessToken?: (userId: string) => Promise<string | null>;
};

async function ensureNotCancelled(
  signal: AbortSignal,
  db: Db,
  jobId: string,
) {
  if (signal.aborted) throw new ProcessCancelledError();
  const [row] = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (
    !row ||
    row.status === "cancelling" ||
    row.status === "cancelled"
  ) {
    throw new ProcessCancelledError();
  }
}

/**
 * Convert an already-uploaded WAV to tagged AIFF using SoundCloud/Spotify
 * metadata. Skips yt-dlp download entirely.
 */
export async function runRetagJob(deps: RunRetagJobDeps): Promise<void> {
  const { db, payload, signal, update } = deps;
  const destination = payload.destination ?? "browser";
  const workDir = assertPathInside(
    userRoot(payload.userId),
    path.join(userRoot(payload.userId), "work", payload.jobId),
  );
  const outDir = assertPathInside(
    userRoot(payload.userId),
    path.join(userRoot(payload.userId), "downloads"),
  );
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  try {
    await update({
      status: "running",
      stage: "resolving",
      progress: 10,
      matchedUrl: payload.metadataUrl,
    });
    await ensureNotCancelled(signal, db, payload.jobId);

    const tags = await resolveTrackTags({
      catalogUrl: payload.metadataUrl,
      titleHint: payload.titleHint,
      artistHint: payload.artistHint,
      signal,
    });

    const title = tags.title ?? payload.titleHint ?? "track";
    const artist = tags.artist ?? payload.artistHint;
    await update({
      title,
      artist,
      stage: "converting",
      progress: 35,
    });
    await ensureNotCancelled(signal, db, payload.jobId);

    // Extension is a hint only — convertAudio probes the real codec. Hypeddit
    // gates may hand back wav or mp3; manual retag uploads stay WAV.
    const keyExt =
      path.extname(payload.inputStorageKey).replace(/^\./, "").toLowerCase() ||
      "wav";
    const inputPath = path.join(
      workDir,
      `input_${randomUUID()}.${keyExt === "bin" ? "wav" : keyExt}`,
    );
    await materializeObject(payload.inputStorageKey, inputPath);

    let artworkPath: string | null = null;
    if (tags.artworkUrl) {
      artworkPath = await downloadArtworkFile({
        artworkUrl: tags.artworkUrl,
        workDir,
        squareCrop: tags.artworkNeedsSquareCrop,
        signal,
      });
    }

    // Hypeddit originals arrive with whatever the artist bothered to embed, and
    // the SoundCloud page they came from often has no usable art either. Same
    // recovery the download path uses: search SoundCloud and take the cover off
    // a hit that clears the match scorer.
    if (!artworkPath) {
      const fallbackUrl = await findFallbackArtworkUrl({
        title,
        ...(artist ? { artist } : {}),
        signal,
      });
      if (fallbackUrl) {
        artworkPath = await downloadArtworkFile({
          artworkUrl: fallbackUrl,
          workDir,
          signal,
        });
      }
    }

    const filename = `${sanitizeFilename(
      trackDisplayName(artist, title),
    )}.flac`;
    const outPath = assertPathInside(outDir, path.join(outDir, filename));

    const { qualityLabel } = await convertAudio({
      inputPath,
      outputPath: outPath,
      target: "flac",
      title,
      artist,
      album: tags.album,
      genre: tags.genre,
      date: tags.date,
      artworkPath,
      signal,
    });

    await update({ stage: "delivering", progress: 80 });
    await ensureNotCancelled(signal, db, payload.jobId);

    const stat = await fs.stat(outPath);
    let relativePath = path.relative(userRoot(payload.userId), outPath);
    const blobMode = useBlobStorage();
    const skipObjectStore = blobMode && destination === "drive";

    if (blobMode && !skipObjectStore) {
      const key = userStorageKey(
        payload.userId,
        "downloads",
        randomUUID(),
        filename,
      );
      await putLocalFile(key, outPath, { contentType: "audio/flac" });
      relativePath = key;
    }

    const [fileRow] = skipObjectStore
      ? []
      : await db
          .insert(files)
          .values({
            userId: payload.userId,
            jobId: payload.jobId,
            relativePath,
            filename,
            mime: "audio/flac",
            sizeBytes: Number(stat.size),
            expiresAt: new Date(Date.now() + FILE_TTL_MS),
          })
          .returning();

    let driveFileId: string | undefined;
    let driveUrl: string | undefined;
    const wantsDrive = destination === "drive" || destination === "both";
    if (wantsDrive) {
      const token = await deps.getGoogleAccessToken?.(payload.userId);
      if (!token) throw new Error(GOOGLE_DRIVE_TOKEN_ERROR);
      const uploaded = await uploadToDrive({
        accessToken: token,
        filePath: outPath,
        filename,
        mimeType: "audio/flac",
      });
      driveFileId = uploaded.fileId;
      driveUrl = uploaded.webViewLink;
      if (fileRow) {
        await db
          .update(files)
          .set({ driveFileId, driveUrl })
          .where(eq(files.id, fileRow.id));
      }
    }

    await update({ stage: "cleanup", progress: 95 });

    if (blobMode) {
      await fs.unlink(outPath).catch(() => undefined);
    }
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);

    await update({
      status: "completed",
      stage: "done",
      progress: 100,
      result: {
        retag: true,
        inputStorageKey: payload.inputStorageKey,
        fileId: fileRow?.id,
        relativePath: skipObjectStore ? undefined : relativePath,
        driveFileId,
        driveUrl,
        qualityLabel,
        ...(payload.hypedditOriginal ? { hypedditOriginal: true } : {}),
        ...(payload.clubReadyOnly ? { clubReadyOnly: true } : {}),
      },
    });
  } catch (err) {
    if (err instanceof ProcessCancelledError) {
      await update({
        status: "cancelled",
        stage: "error",
        error: "Cancelled",
        progress: 100,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await update({
      status: "failed",
      stage: "error",
      error: message,
      progress: 100,
    });
    throw err;
  }
}
