import type { createClerkClient } from "@clerk/backend";
import type { Db } from "@thumper/db";
import { jobs } from "@thumper/db";
import type { ProgressUpdater } from "@thumper/pipeline";
import { oauthScopesIncludeDrive } from "@thumper/shared";
import { eq } from "drizzle-orm";
import type pino from "pino";

type ClerkClient = ReturnType<typeof createClerkClient>;
type JobPatch = Parameters<ProgressUpdater>[0];

/**
 * Apply a pipeline progress patch to the job row.
 *
 * Shared by the pg-boss worker and the one-shot Modal entrypoint — the two
 * paths must record progress identically, so they cannot each own a copy.
 * Only known columns are written; `completedAt` is stamped on terminal states.
 */
export function makeUpdateJob(db: Db) {
  return async function updateJob(jobId: string, patch: JobPatch): Promise<void> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status) values.status = patch.status;
    if (patch.stage) values.stage = patch.stage;
    if (patch.progress !== undefined) values.progress = patch.progress;
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.artist !== undefined) values.artist = patch.artist;
    if (patch.matchedUrl !== undefined) values.matchedUrl = patch.matchedUrl;
    if (patch.error !== undefined) values.error = patch.error;
    if (patch.result !== undefined) values.result = patch.result;
    if (patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled") {
      values.completedAt = new Date();
    }
    await db.update(jobs).set(values).where(eq(jobs.id, jobId));
  };
}

/** Fetch the user's Google OAuth token, or null when it is absent or lacks Drive scope. */
export function makeGoogleTokenFetcher(clerk: ClerkClient, log: pino.Logger) {
  return async function getGoogleAccessToken(userId: string): Promise<string | null> {
    try {
      const res = await clerk.users.getUserOauthAccessToken(userId, "google");
      const entry = res.data[0];
      if (!entry?.token) {
        log.warn({ userId }, "No Google OAuth token for user");
        return null;
      }
      const scopes = entry.scopes ?? [];
      if (scopes.length > 0 && !oauthScopesIncludeDrive(scopes)) {
        log.warn({ userId, scopes }, "Google token missing drive.file scope");
        return null;
      }
      return entry.token;
    } catch (err) {
      log.warn({ err, userId }, "Failed to fetch Google OAuth token");
      return null;
    }
  };
}
