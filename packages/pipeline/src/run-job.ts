import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@thumper/db";
import { files, jobs } from "@thumper/db";
import {
  detectSourceKind,
  sanitizeFilename,
  type AudioFormat,
  type DeliveryDestination,
  type DownloadJobPayload,
} from "@thumper/shared";
import { convertAudio } from "./convert";
import { materializeCookieFile } from "./cookies";
import { downloadMedia, dumpJson } from "./download";
import { uploadToDrive } from "./drive";
import { assertPathInside, userRoot } from "./paths";
import { ProcessCancelledError } from "./process";
import {
  buildYoutubeSearchQuery,
  durationMatchFilter,
  fetchSpotifyTrackMeta,
} from "./spotify";
import { getYtDlpPath } from "./paths";
import { runCommandOk } from "./process";

export type ProgressUpdater = (patch: {
  status?: "running" | "cancelling" | "cancelled" | "completed" | "failed";
  stage?:
    | "resolving"
    | "downloading"
    | "converting"
    | "delivering"
    | "cleanup"
    | "done"
    | "error";
  progress?: number;
  title?: string;
  artist?: string;
  matchedUrl?: string;
  error?: string;
  result?: {
    fileId?: string;
    relativePath?: string;
    driveFileId?: string;
    driveUrl?: string;
    qualityLabel?: string;
  };
}) => Promise<void>;

export type RunJobDeps = {
  db: Db;
  payload: DownloadJobPayload;
  signal: AbortSignal;
  update: ProgressUpdater;
  getGoogleAccessToken?: (userId: string) => Promise<string | null>;
};

function extFor(format: AudioFormat): string {
  return format === "alac" ? "m4a" : format;
}

function mimeFor(format: AudioFormat): string {
  if (format === "flac") return "audio/flac";
  if (format === "wav") return "audio/wav";
  return "audio/mp4";
}

async function ensureNotCancelled(signal: AbortSignal, db: Db, jobId: string) {
  if (signal.aborted) throw new ProcessCancelledError();
  const [row] = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (row?.status === "cancelling" || row?.status === "cancelled") {
    throw new ProcessCancelledError();
  }
}

async function resolveDownloadUrl(
  payload: DownloadJobPayload,
  signal: AbortSignal,
  update: ProgressUpdater,
): Promise<{ url: string; title?: string; artist?: string; soundcloud: boolean }> {
  if (payload.confirmedMatchUrl) {
    await update({ matchedUrl: payload.confirmedMatchUrl });
    return {
      url: payload.confirmedMatchUrl,
      title: payload.titleHint,
      artist: payload.artistHint,
      soundcloud: false,
    };
  }

  const kind = detectSourceKind(payload.url);
  if (kind === "spotify") {
    const meta = await fetchSpotifyTrackMeta(payload.url);
    if (!meta) throw new Error("Could not read Spotify metadata");
    await update({
      title: meta.title,
      artist: meta.artists.join(", "),
      progress: 10,
    });

    const query = buildYoutubeSearchQuery(meta);
    const filter = durationMatchFilter(meta.durationMs);
    const args = ["--flat-playlist", "--print", "%(id)s", "--no-warnings"];
    if (filter) args.push("--match-filter", filter);
    args.push(query);
    const { stdout } = await runCommandOk(getYtDlpPath(), args, { signal });
    const ids = stdout
      .split("\n")
      .map((l: string) => l.trim())
      .filter(Boolean);
    if (!ids[0]) {
      throw new Error(
        "No YouTube match for Spotify track — confirm a match in the UI",
      );
    }
    const matchedUrl = `https://www.youtube.com/watch?v=${ids[0]}`;
    await update({ matchedUrl, progress: 15 });
    return {
      url: matchedUrl,
      title: meta.title,
      artist: meta.artists.join(", "),
      soundcloud: false,
    };
  }

  if (kind === "soundcloud") {
    return {
      url: payload.url,
      title: payload.titleHint,
      artist: payload.artistHint,
      soundcloud: true,
    };
  }

  return {
    url: payload.url,
    title: payload.titleHint,
    artist: payload.artistHint,
    soundcloud: false,
  };
}

export async function runDownloadJob(deps: RunJobDeps): Promise<void> {
  const { db, payload, signal, update } = deps;
  const workDir = path.join(userRoot(payload.userId), "tmp", payload.jobId);
  const outDir = path.join(userRoot(payload.userId), "downloads");
  let cookieTmp: string | null = null;
  let rawPath: string | null = null;
  let outPath: string | null = null;

  try {
    await update({ status: "running", stage: "resolving", progress: 5 });
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });

    const kind = detectSourceKind(payload.url);
    const cookieProvider =
      kind === "soundcloud"
        ? "soundcloud"
        : kind === "patreon"
          ? "patreon"
          : "youtube";
    cookieTmp = await materializeCookieFile(payload.userId, cookieProvider);

    await ensureNotCancelled(signal, db, payload.jobId);
    const resolved = await resolveDownloadUrl(payload, signal, update);

    await update({ stage: "downloading", progress: 20 });
    await ensureNotCancelled(signal, db, payload.jobId);

    const downloaded = await downloadMedia({
      url: resolved.url,
      workDir,
      cookiePath: cookieTmp,
      soundcloud: resolved.soundcloud,
      signal,
    });
    rawPath = downloaded.filePath;

    // Optional duration sanity for SC previews via dump
    if (resolved.soundcloud) {
      try {
        const info = await dumpJson(resolved.url, cookieTmp, signal);
        const duration = Number(info.duration ?? 0);
        if (duration > 0 && duration <= 35) {
          throw new Error(
            "SoundCloud track appears to be preview-only (≤35s). Upload a full-access cookie or pick another source.",
          );
        }
      } catch (err) {
        if (err instanceof ProcessCancelledError) throw err;
        if (err instanceof Error && err.message.includes("preview-only")) {
          throw err;
        }
      }
    }

    const title = resolved.title ?? downloaded.title ?? "track";
    const artist = resolved.artist;
    await update({
      title,
      artist,
      stage: "converting",
      progress: 55,
    });
    await ensureNotCancelled(signal, db, payload.jobId);

    const filename = `${sanitizeFilename(
      artist ? `${artist} - ${title}` : title,
    )}.${extFor(payload.audioFormat)}`;
    outPath = assertPathInside(outDir, path.join(outDir, filename));

    const { qualityLabel } = await convertAudio({
      inputPath: downloaded.filePath,
      outputPath: outPath,
      target: payload.audioFormat,
      title,
      artist,
      signal: signal,
    });

    await update({ stage: "delivering", progress: 80 });
    await ensureNotCancelled(signal, db, payload.jobId);

    const finalOutPath = outPath;
    const stat = await fs.stat(finalOutPath);
    const relativePath = path.relative(userRoot(payload.userId), finalOutPath);

    const [fileRow] = await db
      .insert(files)
      .values({
        userId: payload.userId,
        jobId: payload.jobId,
        relativePath,
        filename,
        mime: mimeFor(payload.audioFormat),
        sizeBytes: Number(stat.size),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning();

    let driveFileId: string | undefined;
    let driveUrl: string | undefined;

    const wantsDrive =
      payload.destination === "drive" || payload.destination === "both";
    if (wantsDrive) {
      const token = await deps.getGoogleAccessToken?.(payload.userId);
      if (!token) {
        throw new Error(
          "Google Drive selected but no Google token with drive.file — reconnect Google in account settings",
        );
      }
      const uploaded = await uploadToDrive({
        accessToken: token,
        filePath: finalOutPath,
        filename,
        mimeType: mimeFor(payload.audioFormat),
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

    await update({
      stage: "cleanup",
      progress: 95,
    });

    await update({
      status: "completed",
      stage: "done",
      progress: 100,
      result: {
        fileId: fileRow?.id,
        relativePath,
        driveFileId,
        driveUrl,
        qualityLabel,
      },
    });
  } catch (err) {
    if (err instanceof ProcessCancelledError) {
      await update({
        status: "cancelled",
        stage: "error",
        error: "Cancelled",
      });
      return;
    }
    const message = err instanceof Error ? err.message : "Job failed";
    await update({
      status: "failed",
      stage: "error",
      error: message,
    });
    throw err;
  } finally {
    if (cookieTmp) {
      await fs.unlink(cookieTmp).catch(() => undefined);
    }
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    // Keep outPath for browser delivery; TTL cleanup removes later
    void rawPath;
    void outPath;
  }
}

export type { AudioFormat, DeliveryDestination };
