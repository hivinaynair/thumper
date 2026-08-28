import { createClerkClient } from "@clerk/backend";
import { createDb, jobs } from "@thumper/db";
import {
  ensurePlaylistFolder,
  runDownloadJob,
  runRetagJob,
} from "@thumper/pipeline";
import {
  detectSourceKind,
  oauthScopesIncludeDrive,
  type DownloadJobPayload,
  type RetagJobPayload,
} from "@thumper/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";
import {
  enqueuePlaylistChildren,
  fanoutIdsFromCompletedParent,
  writeFanoutChildIds,
} from "./playlist-fanout";

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

  async function playlistContextForJob(
    childId: string,
    userId: string,
  ): Promise<{
    parentJobId?: string;
    playlistTitle?: string;
    driveFolderId?: string;
  }> {
    const [parent] = await db
      .select({
        id: jobs.id,
        title: jobs.title,
        result: jobs.result,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, userId),
          sql`jsonb_exists(${jobs.result}->'childJobIds', ${childId})`,
        ),
      )
      .limit(1);
    if (!parent) return {};
    const folder = (
      parent.result as { driveFolderId?: string } | null | undefined
    )?.driveFolderId;
    return {
      parentJobId: parent.id,
      playlistTitle: parent.title ?? undefined,
      ...(folder ? { driveFolderId: folder } : {}),
    };
  }

  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw new Error(`Job not found: ${jobId}`);

  const retagMeta = row.result as
    | { retag?: boolean; inputStorageKey?: string; clubReadyOnly?: boolean }
    | null
    | undefined;
  const isRetag = Boolean(retagMeta?.retag && retagMeta.inputStorageKey);

  // Abort this container when the row leaves queued/running — Cancel, a
  // finished job, or Clear deleting the row. Playlist children run in their
  // own containers; each one polls itself (and ensureNotCancelled also watches
  // parentJobId).
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
        parentJobId?: string;
        gateEmail?: string;
        gateName?: string;
        freeDownloadsOnly?: boolean;
        clubReadyOnly?: boolean;
        driveFolderId?: string;
      }
    | null
    | undefined;

  const playlistCtx = await playlistContextForJob(row.id, row.userId);
  let driveFolderId = gateMeta?.driveFolderId ?? playlistCtx.driveFolderId;
  if (
    !driveFolderId &&
    playlistCtx.playlistTitle &&
    (row.destination === "drive" || row.destination === "both")
  ) {
    const token = await getGoogleAccessToken(row.userId);
    if (token) {
      driveFolderId = await ensurePlaylistFolder({
        accessToken: token,
        playlistName: playlistCtx.playlistTitle,
      });
    }
  }

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
    ...(gateMeta?.parentJobId || playlistCtx.parentJobId
      ? { parentJobId: gateMeta?.parentJobId ?? playlistCtx.parentJobId }
      : {}),
    ...(driveFolderId ? { driveFolderId } : {}),
    ...(detectSourceKind(row.sourceUrl) === "spotify"
      ? { spotifyUrl: row.sourceUrl }
      : {}),
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
          return enqueuePlaylistChildren({
            parent: p,
            tracks,
            context,
            signal: ac.signal,
            insertChild: async ({ kind, track, result }) => {
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
                  result,
                })
                .returning();
              return child ? { id: child.id } : null;
            },
            publishChildIds: async (childIds) => {
              await updateJob(p.jobId, {
                result: {
                  playlist: true,
                  trackCount: tracks.length,
                  childJobIds: childIds,
                  ...(context?.driveFolderId
                    ? { driveFolderId: context.driveFolderId }
                    : {}),
                  ...(p.gateEmail
                    ? { gateEmail: p.gateEmail, gateName: p.gateName }
                    : {}),
                  ...(p.freeDownloadsOnly ? { freeDownloadsOnly: true } : {}),
                  ...(p.clubReadyOnly ? { clubReadyOnly: true } : {}),
                },
              });
            },
            cancelChildren: markJobsCancelled,
            onInsertError: (err, url) => {
              log.warn(
                { err, url, parentJobId: p.jobId },
                "Failed to queue playlist track — continuing",
              );
            },
          });
        },
      });
    } finally {
      log.info({ jobId: p.jobId }, "Job finished");
    }
  }

  try {
    await runOne(payload);
    const [done] = await db
      .select({ status: jobs.status, result: jobs.result })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    const childIds = done ? fanoutIdsFromCompletedParent(done) : [];
    if (childIds.length > 0) {
      await writeFanoutChildIds(jobId, childIds);
    }
  } finally {
    clearInterval(cancelPoll);
  }
}
