import fs from "node:fs/promises";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@thumper/db";
import { files, jobs } from "@thumper/db";
import {
  detectSourceKind,
  GOOGLE_DRIVE_TOKEN_ERROR,
  isPlaylistUrl,
  MAX_PLAYLIST_TRACKS,
  sanitizeFilename,
  trackDisplayName,
  type AudioFormat,
  type DeliveryDestination,
  type DownloadJobPayload,
} from "@thumper/shared";
import { findFallbackArtworkUrl } from "./artwork-fallback";
import {
  isClubReady,
  isQualityGateError,
  QualityGateError,
  verifyForDj,
  type DjVerdict,
} from "./audio-verify";
import { FILE_TTL_MS } from "./cleanup";
import { convertAudio } from "./convert";
import { materializeCookieFile } from "./cookies";
import {
  downloadMedia,
  dumpJson,
  isSoundCloudPreviewError,
  isSoundCloudUnavailableError,
  probeSoundCloudFreeDownload,
  SoundCloudPreviewError,
} from "./download";
import { ensurePlaylistFolder, uploadToDrive } from "./drive";
import { downloadHypedditGate } from "./hypeddit";
import {
  matchSpotifyTrackToMirror,
  matchTrackToYoutube,
  mirrorSpotifyTracks,
  normalizeTrackForMatch,
} from "./match";
import {
  artistNamesFromInfo,
  downloadArtworkFile,
  fetchSoundCloudTags,
  resolveTrackTags,
  splitArtistNames,
} from "./metadata";
import { assertPathInside, userRoot } from "./paths";
import { expandPlaylistEntries, type PlaylistEntry } from "./playlist";
import { ProcessCancelledError } from "./process";
import {
  isManualDownloadRequiredError,
  ManualDownloadRequiredError,
  resolveSoundCloudPurchase,
} from "./soundcloud-purchase";
import { fetchSpotifyCatalog, type SpotifyTrackMeta } from "./spotify";
import { putLocalFile, useBlobStorage, userStorageKey } from "./storage";
import { randomUUID } from "node:crypto";

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
  /**
   * Overwrites the job's stored result wholesale — it is not merged into what
   * is already there. Every terminal write must therefore be self-contained,
   * restating any flag it wants to survive.
   */
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
    djTier?: "master" | "club" | "marginal" | "unsuitable";
    djHeadline?: string;
    warnings?: string[];
    sourceCodec?: string;
    sourceBitrateKbps?: number | null;
    cutoffHz?: number;
    /** yt-dlp format id actually fetched, e.g. "251", "download". */
    sourceFormatId?: string;
    /**
     * True when SoundCloud served the artist free-download / original upload
     * (`format_id=download`), not a streamed AAC/Opus transcode.
     */
    soundcloudOriginal?: boolean;
    /** True when this job retagged an uploaded audio file → FLAC. */
    retag?: boolean;
    inputStorageKey?: string;
    hypedditOriginal?: boolean;
    manualDownloadUrl?: string;
    manualDownloadTitle?: string | null;
    gateEmail?: string;
    gateName?: string;
    freeDownloadsOnly?: boolean;
    clubReadyOnly?: boolean;
    qualityRejected?: boolean;
  };
}) => Promise<void>;

export type EnqueueChildContext = {
  /** Pre-created `Thumper/<playlist>/` folder for Drive uploads. */
  driveFolderId?: string;
};

export type RunJobDeps = {
  db: Db;
  payload: DownloadJobPayload;
  signal: AbortSignal;
  update: ProgressUpdater;
  getGoogleAccessToken?: (userId: string) => Promise<string | null>;
  enqueueChildTracks?: (
    tracks: PlaylistEntry[],
    context?: EnqueueChildContext,
  ) => Promise<string[]>;
};

// FLAC is the only output format; both stay parameterised so adding another
// target later is a one-line change rather than a hunt through call sites.
function extFor(format: AudioFormat): string {
  return format;
}

function mimeFor(_format: AudioFormat): string {
  return "audio/flac";
}

async function ensureNotCancelled(
  signal: AbortSignal,
  db: Db,
  jobId: string,
  parentJobId?: string,
) {
  if (signal.aborted) throw new ProcessCancelledError();
  const ids = parentJobId ? [jobId, parentJobId] : [jobId];
  const rows = await db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.id, ids));
  // Cancelling the playlist parent must stop every child mid-download.
  if (
    rows.some((row) => row.status === "cancelling" || row.status === "cancelled")
  ) {
    throw new ProcessCancelledError();
  }
  // Parent deleted (e.g. Clear finished) while Modal is still expanding —
  // treat as cancel so we stop spawning orphan tracks.
  if (parentJobId && !rows.some((row) => row.id === parentJobId)) {
    throw new ProcessCancelledError();
  }
}

/**
 * Verification is advisory — never fail a job because analysis broke. A null
 * verdict means "could not measure", which only the club-ready-only gate reacts
 * to. Cancellation still propagates.
 */
async function safeVerifyForDj(
  filePath: string,
  signal: AbortSignal,
  artistOriginal = false,
): Promise<DjVerdict | null> {
  try {
    return await verifyForDj(filePath, { signal, artistOriginal });
  } catch (err) {
    if (err instanceof ProcessCancelledError) throw err;
    return null;
  }
}

function qualityGateError(
  verdict: DjVerdict | null,
  source: string,
): QualityGateError {
  return verdict
    ? new QualityGateError({
        tier: verdict.tier,
        cutoffHz: verdict.analysis.cutoffHz,
        source,
      })
    : new QualityGateError({ tier: null, source });
}

/**
 * Unlock a Hypeddit Free Download gate, store the file, then retag → FLAC
 * using the SoundCloud track URL for metadata/artwork.
 */
async function processHypedditRetag(params: {
  deps: RunJobDeps;
  hypedditUrl: string;
  metadataUrl: string;
  titleHint?: string;
  artistHint?: string;
  workDir: string;
}): Promise<void> {
  const { deps, hypedditUrl, metadataUrl, workDir } = params;
  const { payload, signal, update } = deps;
  const email = payload.gateEmail?.trim();
  if (!email) {
    throw new Error(
      "Hypeddit Free Download needs your account email — sign in with Google and retry",
    );
  }

  await update({
    stage: "downloading",
    progress: 25,
    matchedUrl: hypedditUrl,
  });
  await ensureNotCancelled(signal, deps.db, payload.jobId, payload.parentJobId);

  const downloaded = await downloadHypedditGate({
    gateUrl: hypedditUrl,
    email,
    name: payload.gateName?.trim() || email.split("@")[0] || "DJ",
    workDir,
    signal,
  });

  // This path returns before processTrack's gate ever runs, so club-ready-only
  // has to be enforced here or Hypeddit tracks ship unchecked. Verify now:
  // these are frequently 320 kbps MP3s about to be rewrapped as FLAC, after
  // which every container-level check will happily report "lossless".
  // Unlike the main path there is no YouTube mirror, so a rejection fails outright.
  // A Hypeddit gate is the artist handing over their own file, so it is
  // eligible for "master" — but only eligible: the spectral checks still have
  // to agree, which is what catches a 320 kbps MP3 dressed up as WAV.
  if (payload.clubReadyOnly) {
    const verdict = await safeVerifyForDj(downloaded.filePath, signal, true);
    if (!verdict || !isClubReady(verdict.tier)) {
      await fs.unlink(downloaded.filePath).catch(() => undefined);
      throw qualityGateError(verdict, "The Hypeddit Free Download");
    }
  }

  const contentType =
    downloaded.ext === "wav"
      ? "audio/wav"
      : downloaded.ext === "mp3"
        ? "audio/mpeg"
        : downloaded.ext === "flac"
          ? "audio/flac"
          : downloaded.ext === "aiff" || downloaded.ext === "aif"
            ? "audio/aiff"
            : "application/octet-stream";

  const inputStorageKey = userStorageKey(
    payload.userId,
    "uploads",
    `${randomUUID()}.${downloaded.ext}`,
  );
  await putLocalFile(inputStorageKey, downloaded.filePath, { contentType });

  // Dynamic import avoids a circular module graph with retag-job → run-job types.
  const { runRetagJob } = await import("./retag-job");
  await runRetagJob({
    db: deps.db,
    payload: {
      jobId: payload.jobId,
      userId: payload.userId,
      inputStorageKey,
      metadataUrl,
      titleHint: params.titleHint,
      artistHint: params.artistHint,
      destination: payload.destination,
      hypedditOriginal: true,
      clubReadyOnly: payload.clubReadyOnly,
    },
    signal,
    update,
    getGoogleAccessToken: deps.getGoogleAccessToken,
  });
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
  /** Spotify / SoundCloud URL used for tags + artwork (never YouTube). */
  catalogUrl?: string | null;
  /**
   * SoundCloud source cascade: free-download original → YouTube mirror → SC
   * stream. Set false when already on the YouTube path.
   */
  preferYoutube?: boolean;
  /** Prevent infinite SC→YT→… loops after a failed / skipped YT prefer. */
  allowYoutubeFallback?: boolean;
  /**
   * Overrides the source name in gate errors when this run is a retry of
   * another source — otherwise a SoundCloud job fails citing "YouTube".
   */
  qualitySourceLabel?: string;
}): Promise<void> {
  const { deps, soundcloud, workDir, outDir } = params;
  const { db, payload, signal, update } = deps;
  const cookieTmp = params.cookieTmp;

  // SoundCloud playlist/track priority:
  // 0) Free Download purchase_url → Hypeddit unlock → retag AIFF
  //    (other store/gate links → fail flagged for manual download)
  // 1) artist free-download / original upload (best possible)
  // 2) confident YouTube mirror (Premium Opus beats SC AAC stream)
  // 3) SoundCloud stream (remixes/bootlegs with no YT upload)
  //
  // YouTube is loudness-normalized (~−14 LUFS), so peaks look quieter than
  // club masters — convert.ts peak-normalizes lossy sources to 0 dBFS so DJ
  // waveforms stay full-height without giving up YT's better stream quality.
  if (soundcloud) {
    await update({ stage: "resolving", progress: 12 });
    const purchase = await resolveSoundCloudPurchase({
      trackUrl: params.trackUrl,
      cookiePath: cookieTmp,
      signal,
    });
    if (purchase.kind === "other" && purchase.url) {
      throw new ManualDownloadRequiredError(purchase.url, purchase.title);
    }
    if (purchase.kind === "hypeddit" && purchase.url) {
      await processHypedditRetag({
        deps,
        hypedditUrl: purchase.url,
        metadataUrl: params.catalogUrl ?? params.trackUrl,
        titleHint: params.titleHint,
        artistHint: params.artistHint,
        workDir,
      });
      return;
    }
    if (payload.freeDownloadsOnly) {
      // No Hypeddit gate, but the artist may still expose the original upload
      // directly (`format_id=download`) — that is a free download too, and the
      // format selector takes it ahead of any stream.
      const hasFreeDownload = await probeSoundCloudFreeDownload(
        params.trackUrl,
        cookieTmp,
        signal,
      );
      if (!hasFreeDownload) {
        throw new Error(
          "No free download on this track — no Hypeddit gate and no artist original. Turn Free downloads only off to mirror it from YouTube.",
        );
      }
    }
  }

  let youtubeAlreadyTried = false;

  /**
   * True when a SoundCloud failure still has an untried YouTube mirror left.
   * Free-downloads-only excludes itself: a mirror is by definition not the
   * artist's free download, so falling back to one would quietly deliver the
   * thing the switch exists to refuse.
   */
  const canTryYoutubeMirror = () =>
    soundcloud &&
    !payload.freeDownloadsOnly &&
    !youtubeAlreadyTried &&
    params.allowYoutubeFallback !== false;

  const tryYoutubeMirror = (reason: FallbackReason) =>
    fallbackSoundCloudToYoutube({
      deps,
      trackUrl: params.trackUrl,
      titleHint: params.titleHint,
      artistHint: params.artistHint,
      scCookieTmp: cookieTmp,
      workDir,
      outDir,
      matchScore: params.matchScore,
      catalogUrl: params.catalogUrl ?? params.trackUrl,
      reason,
    });

  // SoundCloud is worth using only when it hands over a free download — the
  // artist's original upload or a Hypeddit gate, which is what the switch
  // declares. Its streams top out at 128 kbps MP3 / 160 kbps AAC, strictly
  // worse than YouTube Premium's ~280 kbps Opus, so everything else mirrors.
  if (soundcloud && !payload.freeDownloadsOnly && params.preferYoutube !== false) {
    await update({ stage: "resolving", progress: 18 });
    const ytResult = await trySoundCloudViaYoutubeFirst({
      deps,
      trackUrl: params.trackUrl,
      titleHint: params.titleHint,
      artistHint: params.artistHint,
      scCookieTmp: cookieTmp,
      workDir,
      outDir,
      catalogUrl: params.catalogUrl ?? params.trackUrl,
    });
    if (ytResult === "downloaded") return;
    // Deliberately no SoundCloud-stream fallback: a stream would be worse than
    // what we just failed to get, so the job fails instead of quietly
    // delivering the lower-quality copy.
    throw new Error(
      "No confident YouTube mirror for this SoundCloud track, and its stream is lower quality than a mirror. Tick “Free downloads only” if the artist offers a free download.",
    );
  }

  await update({
    title: params.titleHint,
    artist: params.artistHint,
    matchedUrl: params.matchedUrl ?? params.trackUrl,
    stage: "downloading",
    progress: 20,
  });
  await ensureNotCancelled(signal, db, payload.jobId, payload.parentJobId);

  let downloaded;
  try {
    downloaded = await downloadMedia({
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
          await fs.unlink(downloaded.filePath).catch(() => undefined);
          throw new SoundCloudPreviewError(
            "SoundCloud track appears to be preview-only (≤35s). Falling back to YouTube when possible.",
          );
        }
      } catch (err) {
        if (err instanceof ProcessCancelledError) throw err;
        if (isSoundCloudPreviewError(err)) throw err;
      }
    }
  } catch (err) {
    if (canTryYoutubeMirror() && isSoundCloudUnavailableError(err)) {
      await tryYoutubeMirror(
        isSoundCloudPreviewError(err) ? "preview-only" : "blocked",
      );
      return;
    }
    throw err;
  }

  const tags = await resolveTrackTags({
    catalogUrl: params.catalogUrl,
    // YouTube is consulted last and only answers for Topic channels, so a
    // Spotify/SoundCloud catalogUrl still wins whenever we have one.
    downloadUrl: params.trackUrl,
    titleHint: params.titleHint ?? downloaded.title,
    artistHint: params.artistHint,
    cookiePath: cookieTmp,
    signal,
  });

  const title = tags.title ?? params.titleHint ?? downloaded.title ?? "track";
  const artist = tags.artist ?? params.artistHint;
  await update({ title, artist, stage: "converting", progress: 55 });
  await ensureNotCancelled(signal, db, payload.jobId, payload.parentJobId);

  // Verify the *downloaded source*, before conversion. Once it has been
  // rewrapped as ALAC/FLAC every container-level check says "lossless", so this
  // is the last moment the truth is visible.
  const sourceLabel =
    params.qualitySourceLabel ??
    (soundcloud ? "SoundCloud’s stream" : "The YouTube audio");
  // Only the artist's own upload can be a master. `format_id=download` is the
  // SoundCloud free download; everything else here is a stream or a mirror.
  const isArtistOriginal =
    soundcloud &&
    typeof downloaded.formatId === "string" &&
    downloaded.formatId.toLowerCase() === "download";
  const verdict = await safeVerifyForDj(
    downloaded.filePath,
    signal,
    isArtistOriginal,
  );

  // Both "measured and too lossy" and "could not measure at all" are rejections
  // here: an unmeasurable file is not evidence of a good one, and the switch
  // promises a floor. Both take the same road — mirror first, then fail.
  if (payload.clubReadyOnly && (!verdict || !isClubReady(verdict.tier))) {
    await fs.unlink(downloaded.filePath).catch(() => undefined);
    // A SoundCloud stream that flunks is often fine on YouTube: Premium Opus
    // beats SC's AAC, and an unreadable SC stream is often just broken.
    if (canTryYoutubeMirror()) {
      await tryYoutubeMirror("low-quality");
      return;
    }
    throw qualityGateError(verdict, sourceLabel);
  }

  const warnings = [...(verdict?.warnings ?? [])];
  if (downloaded.anonymousFallback) {
    warnings.unshift(
      "Downloaded without your account — YouTube capped this at 128 kbps AAC. Re-sync your cookies to get Premium quality.",
    );
  }

  let artworkPath: string | null = null;
  if (tags.artworkUrl) {
    artworkPath = await downloadArtworkFile({
      artworkUrl: tags.artworkUrl,
      workDir,
      squareCrop: tags.artworkNeedsSquareCrop,
      signal,
    });
  }
  // A YouTube upload whose thumbnail turned out to be a video frame has no
  // sleeve of its own. Look the release up on SoundCloud rather than shipping
  // a track with no cover — the scorer there refuses a doubtful match.
  if (!artworkPath && title) {
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
  )}.${extFor(payload.audioFormat)}`;
  const outPath = assertPathInside(outDir, path.join(outDir, filename));

  const { qualityLabel } = await convertAudio({
    inputPath: downloaded.filePath,
    outputPath: outPath,
    target: payload.audioFormat,
    title,
    artist,
    album: tags.album,
    genre: tags.genre,
    date: tags.date,
    artworkPath,
    cutoffHz: verdict?.analysis.cutoffHz,
    signal,
  });

  await update({ stage: "delivering", progress: 80 });
  await ensureNotCancelled(signal, db, payload.jobId, payload.parentJobId);

  const stat = await fs.stat(outPath);
  let relativePath = path.relative(userRoot(payload.userId), outPath);

  const blobMode = useBlobStorage();
  // Drive-only jobs don't need an object-store copy: Drive holds the durable
  // artifact, and without a file row the UI shows no Download button. Skipping
  // it avoids storing a full duplicate of every track.
  const skipObjectStore = blobMode && payload.destination === "drive";

  if (blobMode && !skipObjectStore) {
    const key = userStorageKey(
      payload.userId,
      "downloads",
      randomUUID(),
      filename,
    );
    await putLocalFile(key, outPath, {
      contentType: mimeFor(payload.audioFormat),
    });
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
          mime: mimeFor(payload.audioFormat),
          sizeBytes: Number(stat.size),
          expiresAt: new Date(Date.now() + FILE_TTL_MS),
        })
        .returning();

  let driveFileId: string | undefined;
  let driveUrl: string | undefined;

  const wantsDrive =
    payload.destination === "drive" || payload.destination === "both";
  if (wantsDrive) {
    const token = await deps.getGoogleAccessToken?.(payload.userId);
    if (!token) {
      throw new Error(GOOGLE_DRIVE_TOKEN_ERROR);
    }
    const uploaded = await uploadToDrive({
      accessToken: token,
      filePath: outPath,
      filename,
      mimeType: mimeFor(payload.audioFormat),
      folderId: payload.driveFolderId,
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

  // In blob mode the converted file on disk is now redundant — either it's in
  // the object store, or the job was Drive-only and Google has it. Local/disk
  // deployments keep it, since there `outDir` *is* the storage.
  if (blobMode) {
    await fs.unlink(outPath).catch(() => undefined);
  }
  const sourceFormatId = downloaded.formatId;
  const soundcloudOriginal =
    soundcloud &&
    typeof sourceFormatId === "string" &&
    sourceFormatId.toLowerCase() === "download";

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
      djTier: verdict?.tier,
      djHeadline: verdict?.headline,
      warnings: warnings.length ? warnings : undefined,
      sourceCodec: verdict?.analysis.codec ?? downloaded.acodec,
      sourceBitrateKbps: verdict?.analysis.bitrateKbps ?? downloaded.abr ?? null,
      cutoffHz: verdict?.analysis.cutoffHz,
      sourceFormatId,
      soundcloudOriginal: soundcloudOriginal || undefined,
      ...(payload.clubReadyOnly ? { clubReadyOnly: true } : {}),
    },
  });
}

async function resolveSoundCloudMeta(params: {
  trackUrl: string;
  titleHint?: string;
  artistHint?: string;
  cookieTmp: string | null;
  signal: AbortSignal;
}): Promise<SpotifyTrackMeta> {
  let title = params.titleHint?.trim() || "";
  let artist = params.artistHint?.trim() || "";
  let durationMs: number | undefined;

  // Prefer yt-dlp credits over oEmbed author_name — label pages (UKF) set
  // author to the channel while `artist`/`artists` still carry "WINK, borne".
  try {
    const info = await dumpJson(
      params.trackUrl,
      params.cookieTmp,
      params.signal,
    );
    const credited = artistNamesFromInfo(info);
    if (credited.length) artist = credited.join(", ");
    const dumpedTitle = String(info.title ?? info.track ?? "").trim();
    if (dumpedTitle) title = dumpedTitle;
    const durationSec = Number(info.duration ?? 0);
    // A 30s "duration" is SoundCloud's snippet, not the track. Passing it on
    // would make every full-length mirror look like the wrong song.
    if (Number.isFinite(durationSec) && durationSec > 35) {
      durationMs = Math.round(durationSec * 1000);
    }
  } catch {
    /* best-effort metadata for YouTube search */
  }

  // oEmbed answers for DRM-protected and geo-blocked tracks, where the yt-dlp
  // dump above fails outright — without it the mirror search runs on "track"
  // and never matches anything.
  if (!title || !artist) {
    try {
      const tags = await fetchSoundCloudTags(params.trackUrl, {
        cookiePath: params.cookieTmp,
        signal: params.signal,
      });
      if (!title) title = tags?.title?.trim() ?? "";
      if (!artist) artist = tags?.artist?.trim() ?? "";
    } catch {
      /* best-effort metadata for YouTube search */
    }
  }

  if (!title) title = "track";

  // Normalize before YouTube search: split collabs, parse "Artist - Song"
  // titles, and drop label-as-artist credits (UKF / nested label pages).
  return normalizeTrackForMatch({
    title,
    artists: splitArtistNames(artist),
    durationMs,
  });
}

type YoutubePreferResult =
  | "downloaded"
  | "no_mirror"
  | "no_cookies"
  | "youtube_failed";

/**
 * Prefer YouTube (Premium Opus) when SoundCloud has no free-download master
 * but a confident YouTube mirror exists. Tags/artwork stay on the SC URL.
 * SC progressive/HLS AAC is usually worse than YT for DJ use.
 */
async function trySoundCloudViaYoutubeFirst(params: {
  deps: RunJobDeps;
  trackUrl: string;
  titleHint?: string;
  artistHint?: string;
  scCookieTmp: string | null;
  workDir: string;
  outDir: string;
  catalogUrl?: string | null;
}): Promise<YoutubePreferResult> {
  const { deps, workDir, outDir } = params;
  const { payload, signal, update } = deps;

  await update({ stage: "resolving", progress: 22 });
  await ensureNotCancelled(
    signal,
    deps.db,
    payload.jobId,
    payload.parentJobId,
  );

  const meta = await resolveSoundCloudMeta({
    trackUrl: params.trackUrl,
    titleHint: params.titleHint,
    artistHint: params.artistHint,
    cookieTmp: params.scCookieTmp,
    signal,
  });

  const mirror = await matchTrackToYoutube(meta, { signal });
  if (!mirror) return "no_mirror";

  const ytCookieTmp = await materializeCookieFile(payload.userId, "youtube");
  if (!ytCookieTmp) return "no_cookies";

  try {
    await update({
      title: meta.title,
      artist: meta.artists.join(", ") || undefined,
      matchedUrl: mirror.url,
      stage: "downloading",
      progress: 30,
    });

    await processTrack({
      deps,
      trackUrl: mirror.url,
      titleHint: meta.title,
      artistHint: meta.artists.join(", ") || undefined,
      soundcloud: false,
      cookieTmp: ytCookieTmp,
      workDir,
      outDir,
      matchedUrl: mirror.url,
      matchScore: mirror.matchScore,
      catalogUrl: params.catalogUrl ?? params.trackUrl,
      preferYoutube: false,
      allowYoutubeFallback: false,
    });
    return "downloaded";
  } catch (err) {
    if (err instanceof ProcessCancelledError) throw err;
    // Matched YouTube but download failed (bot wall, formats) — try SoundCloud.
    return "youtube_failed";
  } finally {
    await fs.unlink(ytCookieTmp).catch(() => undefined);
  }
}

/** Why SoundCloud couldn't serve usable audio — used only for the error text. */
type FallbackReason = "preview-only" | "blocked" | "low-quality";

/**
 * Retry a SoundCloud track from its YouTube mirror.
 *
 * The inner `processTrack` runs with `allowYoutubeFallback: false`, which is
 * what bounds this to a single hop — every caller relies on that, so it must
 * stay.
 */
async function fallbackSoundCloudToYoutube(params: {
  deps: RunJobDeps;
  trackUrl: string;
  titleHint?: string;
  artistHint?: string;
  scCookieTmp: string | null;
  workDir: string;
  outDir: string;
  matchScore?: number;
  catalogUrl?: string | null;
  reason: FallbackReason;
}): Promise<void> {
  const { deps, workDir, outDir } = params;
  const { payload, signal, update } = deps;

  await update({
    stage: "resolving",
    progress: 25,
  });
  await ensureNotCancelled(
    signal,
    deps.db,
    payload.jobId,
    payload.parentJobId,
  );

  const meta = await resolveSoundCloudMeta({
    trackUrl: params.trackUrl,
    titleHint: params.titleHint,
    artistHint: params.artistHint,
    cookieTmp: params.scCookieTmp,
    signal,
  });

  const mirror = await matchTrackToYoutube(meta, { signal });
  if (!mirror) {
    const because =
      params.reason === "preview-only"
        ? "SoundCloud only has a preview (often geo-blocked or Go+)"
        : params.reason === "low-quality"
          ? "SoundCloud's audio isn't club-ready"
          : "SoundCloud audio is unavailable (DRM or region-locked)";
    throw new Error(
      `${because} and no confident YouTube mirror found for “${meta.artists[0] ?? "?"} – ${meta.title}”`,
    );
  }

  const ytCookieTmp = await materializeCookieFile(payload.userId, "youtube");
  if (!ytCookieTmp) {
    throw new Error(
      `SoundCloud couldn’t serve “${meta.artists[0] ?? "?"} – ${meta.title}” and YouTube cookies aren’t synced — sync YouTube from a signed-in browser, then retry (Modal’s IP needs them to pass the bot check).`,
    );
  }
  try {
    await update({
      title: meta.title,
      artist: meta.artists.join(", ") || undefined,
      matchedUrl: mirror.url,
      stage: "downloading",
      progress: 30,
    });

    await processTrack({
      deps,
      trackUrl: mirror.url,
      titleHint: meta.title,
      artistHint: meta.artists.join(", ") || undefined,
      soundcloud: false,
      cookieTmp: ytCookieTmp,
      workDir,
      outDir,
      matchedUrl: mirror.url,
      matchScore: mirror.matchScore,
      catalogUrl: params.catalogUrl ?? params.trackUrl,
      preferYoutube: false,
      allowYoutubeFallback: false,
      qualitySourceLabel:
        params.reason === "low-quality"
          ? "The YouTube mirror of this SoundCloud track"
          : undefined,
    });
  } finally {
    await fs.unlink(ytCookieTmp).catch(() => undefined);
  }
}

/**
 * Create `Thumper/<playlist>/` once for Drive destinations. Child track jobs
 * receive the folder id so concurrent uploads don't race into duplicates.
 */
async function resolvePlaylistDriveFolder(params: {
  deps: RunJobDeps;
  playlistName: string;
}): Promise<string | undefined> {
  const { payload } = params.deps;
  if (payload.destination !== "drive" && payload.destination !== "both") {
    return undefined;
  }
  const token = await params.deps.getGoogleAccessToken?.(payload.userId);
  if (!token) return undefined;
  return ensurePlaylistFolder({
    accessToken: token,
    playlistName: params.playlistName,
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

    // Child jobs are enqueued by the worker and skip the API route's Drive
    // check, so verify here too — before downloading and converting anything.
    if (payload.destination === "drive" || payload.destination === "both") {
      const token = await deps.getGoogleAccessToken?.(payload.userId);
      if (!token) throw new Error(GOOGLE_DRIVE_TOKEN_ERROR);
    }

    // ——— Spotify catalog → mirror to YT/SC ———
    if (kind === "spotify") {
      await ensureNotCancelled(signal, db, payload.jobId, payload.parentJobId);
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
        const driveFolderId = await resolvePlaylistDriveFolder({
          deps,
          playlistName: catalog.title,
        });
        const childJobIds = await deps.enqueueChildTracks(matched, {
          driveFolderId,
        });
        await ensureNotCancelled(
          signal,
          db,
          payload.jobId,
          payload.parentJobId,
        );
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
        catalogUrl: track.spotifyUrl ?? payload.url,
      });
      return;
    }

    // ——— YouTube / SoundCloud ———
    cookieTmp = await materializeCookieFile(
      payload.userId,
      kind === "soundcloud" ? "soundcloud" : "youtube",
    );
    await ensureNotCancelled(signal, db, payload.jobId, payload.parentJobId);

    let trackUrl = payload.url;
    let titleHint = payload.titleHint;
    let artistHint = payload.artistHint;

    // Single tracks skip yt-dlp expand so Hypeddit / purchase_url resolution
    // is not blocked by SoundCloud client_id scrape failures in the worker.
    if (
      !payload.parentJobId &&
      deps.enqueueChildTracks &&
      isPlaylistUrl(payload.url)
    ) {
      // yt-dlp raises SoundCloud's DRM / geo errors during extraction, so they
      // land here rather than in processTrack's catch. Swallow those and carry
      // on: processTrack will hit the same error inside its own try, where the
      // YouTube fallback can pick it up.
      let expanded: { title?: string; entries: PlaylistEntry[] } = {
        entries: [],
      };
      try {
        expanded = await expandPlaylistEntries(payload.url, {
          signal,
          cookiePath: cookieTmp,
        });
      } catch (err) {
        if (err instanceof ProcessCancelledError) throw err;
        if (!isSoundCloudUnavailableError(err)) throw err;
      }

      if (expanded.entries.length > 1) {
        const playlistTitle =
          expanded.title ?? payload.titleHint ?? "Playlist";
        await update({
          title: playlistTitle,
          progress: 40,
        });
        const driveFolderId = await resolvePlaylistDriveFolder({
          deps,
          playlistName: playlistTitle,
        });
        const childJobIds = await deps.enqueueChildTracks(expanded.entries, {
          driveFolderId,
        });
        await ensureNotCancelled(
          signal,
          db,
          payload.jobId,
          payload.parentJobId,
        );
        await update({
          status: "completed",
          stage: "done",
          progress: 100,
          title: playlistTitle,
          result: {
            playlist: true,
            trackCount: childJobIds.length,
            childJobIds,
            ...(payload.gateEmail
              ? { gateEmail: payload.gateEmail, gateName: payload.gateName }
              : {}),
            ...(payload.freeDownloadsOnly ? { freeDownloadsOnly: true } : {}),
          },
        });
        return;
      }

      // A playlist URL that expands to ≤1 entry means the expansion was
      // throttled or blocked, not that the playlist has a single track.
      // Downloading it anyway silently delivers only the first video, so fail
      // loudly instead.
      throw new Error(
        "Could not read this playlist — YouTube returned no track list. Try again in a minute, or queue the tracks individually.",
      );
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
      catalogUrl:
        payload.spotifyUrl ?? (kind === "soundcloud" ? payload.url : null),
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
    if (isManualDownloadRequiredError(err)) {
      await update({
        status: "failed",
        stage: "error",
        error: err.message,
        result: {
          manualDownloadUrl: err.manualDownloadUrl,
          manualDownloadTitle: err.purchaseTitle,
        },
      });
      throw err;
    }
    if (isQualityGateError(err)) {
      await update({
        status: "failed",
        stage: "error",
        error: err.message,
        result: {
          // Re-stated because result writes overwrite rather than merge; the
          // flag seeded at enqueue is long gone by now.
          clubReadyOnly: true,
          qualityRejected: true,
          ...(err.tier != null ? { djTier: err.tier } : {}),
          ...(err.cutoffHz != null ? { cutoffHz: err.cutoffHz } : {}),
        },
      });
      throw err;
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
    await fs
      .rm(workDir, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

export type { AudioFormat, DeliveryDestination };
