import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@thumper/db";
import { files, jobs } from "@thumper/db";
import {
  detectSourceKind,
  MAX_PLAYLIST_TRACKS,
  sanitizeFilename,
  type AudioFormat,
  type DeliveryDestination,
  type DownloadJobPayload,
} from "@thumper/shared";
import { convertAudio } from "./convert";
import { materializeCookieFile } from "./cookies";
import { downloadMedia, dumpJson } from "./download";
import { uploadToDrive } from "./drive";
import { matchSpotifyTrackToMirror, mirrorSpotifyTracks } from "./match";
import { assertPathInside, userRoot } from "./paths";
import { expandPlaylistEntries, type PlaylistEntry } from "./playlist";
import { ProcessCancelledError } from "./process";
import { fetchSpotifyCatalog } from "./spotify";

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
    playlist?: boolean;
    trackCount?: number;
    childJobIds?: string[];
    unmatchedCount?: number;
    matchScore?: number;
  };
}) => Promise<void>;

export type RunJobDeps = {
  db: Db;
  payload: DownloadJobPayload;
  signal: AbortSignal;
  update: ProgressUpdater;
  getGoogleAccessToken?: (userId: string) => Promise<string | null>;
  enqueueChildTracks?: (tracks: PlaylistEntry[]) => Promise<string[]>;
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

async function processTrack(params: {
  deps: RunJobDeps;
  trackUrl: string;
  titleHint?: string;
  artistHint?: string;
  soundcloud: boolean;
  cookieTmp: string | null;
  workDir: string;
  outDir: string;
  matchedUrl?: string;
  matchScore?: number;
}): Promise<void> {
  const { deps, soundcloud, cookieTmp, workDir, outDir } = params;
  const { db, payload, signal, update } = deps;

  await update({
    title: params.titleHint,
    artist: params.artistHint,
    matchedUrl: params.matchedUrl ?? params.trackUrl,
    stage: "downloading",
    progress: 20,
  });
  await ensureNotCancelled(signal, db, payload.jobId);

  const downloaded = await downloadMedia({
    url: params.trackUrl,
    workDir,
    cookiePath: cookieTmp,
    soundcloud,
    signal,
  });

  if (soundcloud) {
    try {
      const info = await dumpJson(params.trackUrl, cookieTmp, signal);
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

  const title = params.titleHint ?? downloaded.title ?? "track";
  const artist = params.artistHint;
  await update({ title, artist, stage: "converting", progress: 55 });
  await ensureNotCancelled(signal, db, payload.jobId);

  const filename = `${sanitizeFilename(
    artist ? `${artist} - ${title}` : title,
  )}.${extFor(payload.audioFormat)}`;
  const outPath = assertPathInside(outDir, path.join(outDir, filename));

  const { qualityLabel } = await convertAudio({
    inputPath: downloaded.filePath,
    outputPath: outPath,
    target: payload.audioFormat,
    title,
    artist,
    signal,
  });

  await update({ stage: "delivering", progress: 80 });
  await ensureNotCancelled(signal, db, payload.jobId);

  const stat = await fs.stat(outPath);
  const relativePath = path.relative(userRoot(payload.userId), outPath);

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
      filePath: outPath,
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

  await update({ stage: "cleanup", progress: 95 });
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
      matchScore: params.matchScore,
    },
  });
}

export async function runDownloadJob(deps: RunJobDeps): Promise<void> {
  const { db, payload, signal, update } = deps;
  const workDir = path.join(userRoot(payload.userId), "tmp", payload.jobId);
  const outDir = path.join(userRoot(payload.userId), "downloads");
  let cookieTmp: string | null = null;

  try {
    await update({ status: "running", stage: "resolving", progress: 5 });
    await fs.mkdir(workDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });

    const kind = detectSourceKind(payload.url);
    if (kind !== "youtube" && kind !== "soundcloud" && kind !== "spotify") {
      throw new Error(
        "Only YouTube, SoundCloud, and Spotify (mirror) URLs are supported",
      );
    }

    // ——— Spotify catalog → mirror to YT/SC ———
    if (kind === "spotify") {
      await ensureNotCancelled(signal, db, payload.jobId);
      const catalog = await fetchSpotifyCatalog(payload.url);
      if (!catalog || catalog.tracks.length === 0) {
        throw new Error("Could not read Spotify catalog metadata");
      }

      await update({
        title: catalog.title,
        progress: 15,
      });

      const tracks = catalog.tracks.slice(0, MAX_PLAYLIST_TRACKS);

      if (tracks.length > 1) {
        if (!deps.enqueueChildTracks) {
          throw new Error("Playlist expand requires worker enqueue support");
        }
        await update({ progress: 25 });
        const { matched, failed } = await mirrorSpotifyTracks(tracks, {
          signal,
        });
        if (matched.length === 0) {
          throw new Error(
            `No confident YouTube/SoundCloud mirrors found for ${tracks.length} Spotify tracks (need score ≥ 78)`,
          );
        }
        const childJobIds = await deps.enqueueChildTracks(matched);
        await update({
          status: "completed",
          stage: "done",
          progress: 100,
          title: catalog.title,
          result: {
            playlist: true,
            trackCount: childJobIds.length,
            childJobIds,
            unmatchedCount: failed.length,
          },
        });
        return;
      }

      // Single Spotify track
      const track = tracks[0]!;
      const mirror = await matchSpotifyTrackToMirror(track, { signal });
      if (!mirror) {
        throw new Error(
          `No confident mirror for “${track.artists[0] ?? "?"} – ${track.title}” on YouTube/SoundCloud`,
        );
      }

      const mirrorKind = detectSourceKind(mirror.url);
      cookieTmp = await materializeCookieFile(
        payload.userId,
        mirrorKind === "soundcloud" ? "soundcloud" : "youtube",
      );

      await processTrack({
        deps,
        trackUrl: mirror.url,
        titleHint: mirror.title,
        artistHint: mirror.artist,
        soundcloud: mirrorKind === "soundcloud",
        cookieTmp,
        workDir,
        outDir,
        matchedUrl: mirror.url,
        matchScore: mirror.matchScore,
      });
      return;
    }

    // ——— YouTube / SoundCloud ———
    cookieTmp = await materializeCookieFile(
      payload.userId,
      kind === "soundcloud" ? "soundcloud" : "youtube",
    );
    await ensureNotCancelled(signal, db, payload.jobId);

    let trackUrl = payload.url;
    let titleHint = payload.titleHint;
    let artistHint = payload.artistHint;

    if (!payload.parentJobId && deps.enqueueChildTracks) {
      const expanded = await expandPlaylistEntries(payload.url, {
        signal,
        cookiePath: cookieTmp,
      });

      if (expanded.entries.length > 1) {
        await update({
          title: expanded.title ?? payload.titleHint ?? "Playlist",
          progress: 40,
        });
        const childJobIds = await deps.enqueueChildTracks(expanded.entries);
        await update({
          status: "completed",
          stage: "done",
          progress: 100,
          title: expanded.title ?? payload.titleHint ?? "Playlist",
          result: {
            playlist: true,
            trackCount: childJobIds.length,
            childJobIds,
          },
        });
        return;
      }

      if (expanded.entries[0]) {
        trackUrl = expanded.entries[0].url;
        titleHint = titleHint ?? expanded.entries[0].title;
        artistHint = artistHint ?? expanded.entries[0].artist;
      }
    }

    await processTrack({
      deps,
      trackUrl,
      titleHint,
      artistHint,
      soundcloud: kind === "soundcloud",
      cookieTmp,
      workDir,
      outDir,
      matchedUrl: payload.spotifyUrl ? trackUrl : undefined,
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
  }
}

export type { AudioFormat, DeliveryDestination };
