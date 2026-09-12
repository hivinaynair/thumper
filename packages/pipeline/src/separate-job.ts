import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@thumper/db";
import { files, jobs } from "@thumper/db";
import {
  GOOGLE_DRIVE_TOKEN_ERROR,
  STEM_MODEL_DEFAULT,
  type StemJobPayload,
  type StemRole,
  sanitizeFilename,
  stemRoleLabel,
  trackDisplayName,
} from "@thumper/shared";
import { eq } from "drizzle-orm";
import { FILE_TTL_MS } from "./cleanup";
import { completeDeliveryTransaction } from "./delivery-artifact";
import { deleteDriveFile, uploadToDrive } from "./drive";
import { assertPathInside, userRoot } from "./paths";
import { ProcessCancelledError } from "./process";
import type { ProgressUpdater } from "./run-job";
import { separateStems } from "./separate";
import {
  deleteObjectStrict,
  hasBlobStorage,
  materializeObject,
  putLocalFile,
  userStorageKey,
} from "./storage";

export type RunSeparateJobDeps = {
  db: Db;
  payload: StemJobPayload;
  signal: AbortSignal;
  update: ProgressUpdater;
  getGoogleAccessToken?: (userId: string) => Promise<string | null>;
};

/** Order is the order stems are listed in the UI. */
const STEM_ORDER: readonly StemRole[] = ["instrumental", "vocals"];

/** Separation owns the 10→70 band; delivery takes it from there. */
const PROGRESS_START = 10;
const PROGRESS_END = 70;

/**
 * Unlike the retag path there are two outputs, so cleanup tracks a list. Kept
 * local rather than widening `cleanupRetagPaths`, which is single-slot by
 * design and shared with the download path.
 */
export type StemCleanupState = {
  outputPaths: string[];
  retainOutputs: boolean;
  cleaned: boolean;
};

export async function cleanupStemPaths(params: {
  workDir: string;
  state: StemCleanupState;
  removeOutput: (filePath: string) => Promise<void>;
  removeWorkDir: (dirPath: string) => Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  if (!params.state.retainOutputs) {
    for (const filePath of params.state.outputPaths) {
      try {
        await params.removeOutput(filePath);
      } catch (err) {
        errors.push(err);
      }
    }
  }
  try {
    await params.removeWorkDir(params.workDir);
  } catch (err) {
    errors.push(err);
  }
  if (errors.length > 0) throw errors[0];
}

async function ensureNotCancelled(signal: AbortSignal, db: Db, jobId: string) {
  if (signal.aborted) throw new ProcessCancelledError();
  const [row] = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!row || row.status === "cancelling" || row.status === "cancelled") {
    throw new ProcessCancelledError();
  }
}

/** Name stems off the hints when we have them, else the uploaded filename. */
export function stemBaseName(payload: StemJobPayload): string {
  const fromHints =
    payload.titleHint || payload.artistHint
      ? trackDisplayName(payload.artistHint, payload.titleHint)
      : "";
  if (fromHints.trim()) return sanitizeFilename(fromHints);
  const raw = path.basename(payload.inputStorageKey);
  const withoutExt = raw.replace(/\.[a-z0-9]+$/i, "");
  return sanitizeFilename(withoutExt || "track");
}

/**
 * Split an uploaded file into instrumental + vocals.
 *
 * One inference pass emits both stems, so both are always produced and stored
 * — there is no cheaper "instrumental only" path to take.
 */
export async function runSeparateJob(deps: RunSeparateJobDeps): Promise<void> {
  const { payload } = deps;
  const workDir = assertPathInside(
    userRoot(payload.userId),
    path.join(userRoot(payload.userId), "work", payload.jobId),
  );
  const outDir = assertPathInside(
    userRoot(payload.userId),
    path.join(userRoot(payload.userId), "downloads"),
  );
  const cleanupState: StemCleanupState = {
    outputPaths: [],
    retainOutputs: false,
    cleaned: false,
  };

  try {
    return await runSeparateJobCore(deps, workDir, outDir, cleanupState);
  } finally {
    if (!cleanupState.cleaned) {
      await cleanupStemPaths({
        workDir,
        state: cleanupState,
        removeOutput: (filePath) => fs.rm(filePath, { force: true }),
        removeWorkDir: (dirPath) => fs.rm(dirPath, { recursive: true, force: true }),
      }).catch(() => {
        /* cleanup failures must not mask the original error */
      });
    }
  }
}

async function runSeparateJobCore(
  deps: RunSeparateJobDeps,
  workDir: string,
  outDir: string,
  cleanupState: StemCleanupState,
): Promise<void> {
  const { db, payload, signal, update } = deps;
  const destination = payload.destination ?? "browser";
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  try {
    await update({
      status: "running",
      stage: "resolving",
      progress: 5,
    });
    await ensureNotCancelled(signal, db, payload.jobId);

    // Extension is a hint only — the separator probes the real codec.
    const keyExt = path.extname(payload.inputStorageKey).replace(/^\./, "").toLowerCase() || "wav";
    const inputPath = path.join(
      workDir,
      `input_${randomUUID()}.${keyExt === "bin" ? "wav" : keyExt}`,
    );
    await materializeObject(payload.inputStorageKey, inputPath);

    const baseName = stemBaseName(payload);
    await update({
      title: payload.titleHint ?? baseName,
      artist: payload.artistHint,
      stage: "separating",
      progress: PROGRESS_START,
    });
    await ensureNotCancelled(signal, db, payload.jobId);

    // tqdm ticks far faster than we want to write rows; only move on whole
    // percent changes.
    let lastReported = PROGRESS_START;
    const stemDir = path.join(workDir, "stems");
    const separated = await separateStems({
      inputPath,
      outDir: stemDir,
      model: STEM_MODEL_DEFAULT,
      signal,
      onProgress: (fraction) => {
        const next = Math.round(PROGRESS_START + fraction * (PROGRESS_END - PROGRESS_START));
        if (next <= lastReported) return;
        lastReported = next;
        void update({ progress: next }).catch(() => {
          /* progress is advisory — never fail the job on it */
        });
      },
    });

    await update({ stage: "delivering", progress: 80 });
    await ensureNotCancelled(signal, db, payload.jobId);

    // Move each stem out of the work dir under its final name.
    const staged: Array<{ role: StemRole; outPath: string; filename: string }> = [];
    for (const role of STEM_ORDER) {
      const filename = `${baseName} (${stemRoleLabel(role)}).flac`;
      const outPath = assertPathInside(outDir, path.join(outDir, filename));
      await fs.rename(separated.paths[role], outPath).catch(async (err) => {
        // rename fails across devices; fall back to copy.
        if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
        await fs.copyFile(separated.paths[role], outPath);
        await fs.rm(separated.paths[role], { force: true });
      });
      cleanupState.outputPaths.push(outPath);
      staged.push({ role, outPath, filename });
    }

    const blobMode = hasBlobStorage();
    const skipObjectStore = blobMode && destination === "drive";
    const wantsDrive = destination === "drive" || destination === "both";

    await completeDeliveryTransaction({
      create: async (registerCleanup) => {
        const token = wantsDrive ? await deps.getGoogleAccessToken?.(payload.userId) : null;
        if (wantsDrive && !token) throw new Error(GOOGLE_DRIVE_TOKEN_ERROR);

        const delivered: NonNullable<Parameters<ProgressUpdater>[0]["result"]>["stemFiles"] = [];

        for (const { role, outPath, filename } of staged) {
          const stat = await fs.stat(outPath);
          let relativePath = path.relative(userRoot(payload.userId), outPath);

          if (!blobMode) {
            registerCleanup(() => fs.rm(outPath, { force: true }));
          }

          if (blobMode && !skipObjectStore) {
            const key = userStorageKey(payload.userId, "downloads", randomUUID(), filename);
            await putLocalFile(key, outPath, { contentType: "audio/flac" });
            registerCleanup(() => deleteObjectStrict(key));
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
          if (fileRow) {
            registerCleanup(async () => {
              await db.delete(files).where(eq(files.id, fileRow.id));
            });
          }

          let driveFileId: string | undefined;
          let driveUrl: string | undefined;
          if (wantsDrive && token) {
            const uploaded = await uploadToDrive({
              accessToken: token,
              filePath: outPath,
              filename,
              mimeType: "audio/flac",
              folderId: payload.driveFolderId,
            });
            driveFileId = uploaded.fileId;
            driveUrl = uploaded.webViewLink;
            registerCleanup(() => deleteDriveFile({ accessToken: token, fileId: uploaded.fileId }));
            if (fileRow) {
              await db.update(files).set({ driveFileId, driveUrl }).where(eq(files.id, fileRow.id));
            }
          }

          if (fileRow) {
            delivered.push({
              fileId: fileRow.id,
              role,
              filename,
              mime: "audio/flac",
              sizeBytes: Number(stat.size),
              ...(driveFileId ? { driveFileId } : {}),
              ...(driveUrl ? { driveUrl } : {}),
            });
          }
        }

        return delivered;
      },
      beforeComplete: async () => {
        // In local mode the downloads dir *is* the object store, so the stems
        // must survive cleanup.
        cleanupState.retainOutputs = !blobMode;
        await cleanupStemPaths({
          workDir,
          state: cleanupState,
          removeOutput: (filePath) => fs.rm(filePath, { force: true }),
          removeWorkDir: (dirPath) => fs.rm(dirPath, { recursive: true, force: true }),
        });
        cleanupState.cleaned = true;
      },
      complete: async (stemFiles) => {
        await update({ stage: "cleanup", progress: 95 });
        await update({
          status: "completed",
          stage: "done",
          progress: 100,
          result: {
            stems: true,
            stemModel: separated.model,
            stemFiles,
            inputStorageKey: payload.inputStorageKey,
          },
        });
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
