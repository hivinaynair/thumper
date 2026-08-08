import { createClerkClient } from "@clerk/backend";
import { createDb, jobs } from "@thumper/db";
import {
  ProcessCancelledError,
  runDownloadJob,
  runRetagJob,
} from "@thumper/pipeline";
import {
  detectSourceKind,
  oauthScopesIncludeDrive,
  type DownloadJobPayload,
  type RetagJobPayload,
} from "@thumper/shared";
import { eq, inArray } from "drizzle-orm";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export async function processJobById(jobId: string): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  requireEnv("COOKIE_ENCRYPTION_KEY");
  const clerkSecret = requireEnv("CLERK_SECRET_KEY");

  if (!process.env.DATA_DIR) {
    process.env.DATA_DIR = "/tmp/thumper-data";
  }

  const db = createDb(databaseUrl);
  const clerk = createClerkClient({ secretKey: clerkSecret });

  async function getGoogleAccessToken(userId: string): Promise<string | null> {
    try {
      const res = await clerk.users.getUserOauthAccessToken(userId, "google");
      const entry = res.data[0];
      if (!entry?.token) return null;
      const scopes = entry.scopes ?? [];
      if (scopes.length > 0 && !oauthScopesIncludeDrive(scopes)) return null;
      return entry.token;
    } catch (err) {
      log.warn({ err, userId }, "Failed to fetch Google OAuth token");
      return null;
    }
  }

  async function updateJob(
    id: string,
    patch: Parameters<Parameters<typeof runDownloadJob>[0]["update"]>[0],
  ) {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status) values.status = patch.status;
    if (patch.stage) values.stage = patch.stage;
    if (patch.progress !== undefined) values.progress = patch.progress;
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.artist !== undefined) values.artist = patch.artist;
    if (patch.matchedUrl !== undefined) values.matchedUrl = patch.matchedUrl;
    if (patch.error !== undefined) values.error = patch.error;
    if (patch.result !== undefined) values.result = patch.result;
    if (
      patch.status === "completed" ||
      patch.status === "failed" ||
      patch.status === "cancelled"
    ) {
      values.completedAt = new Date();
    }
    await db.update(jobs).set(values).where(eq(jobs.id, id));
  }

  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw new Error(`Job not found: ${jobId}`);

  const retagMeta = row.result as
    | { retag?: boolean; inputStorageKey?: string; clubReadyOnly?: boolean }
    | null
    | undefined;
  const isRetag = Boolean(retagMeta?.retag && retagMeta.inputStorageKey);

  // One controller for the parent + every inline child. The cancel API flips
  // the parent to "cancelling"; this poll turns that into an abort so the
  // current yt-dlp/ffmpeg child dies and the playlist loop stops.
  // Also abort if the parent row is gone (Clear finished) or already terminal —
  // otherwise a zombie Modal loop keeps inserting orphan children forever.
  const ac = new AbortController();
  const cancelPoll = setInterval(() => {
    void (async () => {
      try {
        const [current] = await db
          .select({ status: jobs.status })
          .from(jobs)
          .where(eq(jobs.id, jobId))
          .limit(1);
        if (!current || (current.status !== "queued" && current.status !== "running")) {
          ac.abort();
        }
      } catch (err) {
        log.warn({ err, jobId }, "cancel poll failed");
      }
    })();
  }, 1000);

  async function markJobsCancelled(ids: string[]): Promise<void> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    await db
      .update(jobs)
      .set({
        status: "cancelled",
        stage: "error",
        error: "Cancelled",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(jobs.id, unique));
  }

  if (isRetag) {
    const retagPayload: RetagJobPayload = {
      jobId: row.id,
      userId: row.userId,
      inputStorageKey: retagMeta!.inputStorageKey!,
      metadataUrl: row.sourceUrl,
      titleHint: row.title ?? undefined,
      artistHint: row.artist ?? undefined,
      destination: row.destination,
      clubReadyOnly: Boolean(retagMeta?.clubReadyOnly),
    };
    try {
      log.info({ jobId }, "Retag job started");
      await runRetagJob({
        db,
        payload: retagPayload,
        signal: ac.signal,
        update: (patch) => updateJob(jobId, patch),
        getGoogleAccessToken,
      });
    } finally {
      clearInterval(cancelPoll);
      log.info({ jobId }, "Retag job finished");
    }
    return;
  }

  const gateMeta = row.result as
    | {
        gateEmail?: string;
        gateName?: string;
        freeDownloadsOnly?: boolean;
        clubReadyOnly?: boolean;
      }
    | null
    | undefined;

  const payload: DownloadJobPayload = {
    jobId: row.id,
    userId: row.userId,
    url: row.matchedUrl ?? row.sourceUrl,
    // The DB enum still carries the retired values ("aiff", "wav", "alac") for
    // rows written before FLAC became the only output. Retrying one of those
    // now produces FLAC.
    audioFormat: "flac",
    destination: row.destination,
    titleHint: row.title ?? undefined,
    artistHint: row.artist ?? undefined,
    gateEmail: gateMeta?.gateEmail,
    gateName: gateMeta?.gateName,
    freeDownloadsOnly: Boolean(gateMeta?.freeDownloadsOnly),
    clubReadyOnly: Boolean(gateMeta?.clubReadyOnly),
  };

  async function runOne(p: DownloadJobPayload): Promise<void> {
    log.info({ jobId: p.jobId }, "Job started");
    try {
      await runDownloadJob({
        db,
        payload: p,
        signal: ac.signal,
        update: (patch) => updateJob(p.jobId, patch),
        getGoogleAccessToken,
        enqueueChildTracks: async (tracks, context) => {
          const childIds: string[] = [];
          let failed = 0;
          // SoundCloud rate-limits (~429) when a set is hammered back-to-back
          // from a datacenter IP. A short gap between tracks keeps most of the
          // playlist alive without much wall-clock cost.
          const TRACK_GAP_MS = 2_000;
          for (const [index, track] of tracks.entries()) {
            if (ac.signal.aborted) {
              throw new ProcessCancelledError();
            }
            const kind = detectSourceKind(track.url) ?? detectSourceKind(p.url);
            if (kind !== "youtube" && kind !== "soundcloud") continue;

            if (index > 0 && TRACK_GAP_MS > 0) {
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, TRACK_GAP_MS);
                const onAbort = () => {
                  clearTimeout(timer);
                  reject(new ProcessCancelledError());
                };
                if (ac.signal.aborted) {
                  onAbort();
                  return;
                }
                ac.signal.addEventListener("abort", onAbort, { once: true });
              });
            }

            const [child] = await db
              .insert(jobs)
              .values({
                userId: p.userId,
                sourceUrl: track.spotifyUrl ?? track.url,
                matchedUrl: track.url,
                sourceKind: kind,
                audioFormat: p.audioFormat,
                destination: p.destination,
                title: track.title,
                artist: track.artist,
                status: "queued",
                stage: "queued",
                progress: 0,
                ...((p.gateEmail || p.freeDownloadsOnly || p.clubReadyOnly)
                  ? {
                      result: {
                        ...(p.gateEmail
                          ? { gateEmail: p.gateEmail, gateName: p.gateName }
                          : {}),
                        ...(p.freeDownloadsOnly
                          ? { freeDownloadsOnly: true }
                          : {}),
                        ...(p.clubReadyOnly ? { clubReadyOnly: true } : {}),
                      },
                    }
                  : {}),
              })
              .returning();
            if (!child) continue;
            childIds.push(child.id);

            // Publish child ids as we go so a mid-playlist Cancel can cascade
            // via the API even before the parent finishes.
            await updateJob(p.jobId, {
              result: {
                playlist: true,
                trackCount: tracks.length,
                childJobIds: [...childIds],
                ...(p.gateEmail
                  ? { gateEmail: p.gateEmail, gateName: p.gateName }
                  : {}),
                ...(p.freeDownloadsOnly ? { freeDownloadsOnly: true } : {}),
                ...(p.clubReadyOnly ? { clubReadyOnly: true } : {}),
              },
            });

            // One track a source refuses to hand over — DRM, geo-block, a dead
            // upload — must not take the rest of the playlist with it. Cancel
            // is different: stop the whole set.
            try {
              await runOne({
                jobId: child.id,
                userId: p.userId,
                url: track.url,
                audioFormat: p.audioFormat,
                destination: p.destination,
                titleHint: track.title,
                artistHint: track.artist,
                parentJobId: p.jobId,
                spotifyUrl: track.spotifyUrl,
                driveFolderId: context?.driveFolderId,
                gateEmail: p.gateEmail,
                gateName: p.gateName,
                freeDownloadsOnly: p.freeDownloadsOnly,
                clubReadyOnly: p.clubReadyOnly,
              });
            } catch (err) {
              if (
                err instanceof ProcessCancelledError ||
                ac.signal.aborted
              ) {
                await markJobsCancelled([child.id]);
                throw err instanceof ProcessCancelledError
                  ? err
                  : new ProcessCancelledError();
              }
              failed += 1;
              log.warn(
                { err, jobId: child.id, url: track.url },
                "Playlist track failed — continuing with the rest",
              );
            }
          }
          if (failed) {
            log.info(
              { jobId: p.jobId, failed, total: childIds.length },
              "Playlist finished with failures",
            );
          }
          return childIds;
        },
      });
    } finally {
      log.info({ jobId: p.jobId }, "Job finished");
    }
  }

  try {
    await runOne(payload);
  } finally {
    clearInterval(cancelPoll);
  }
}
