import type { Db } from "@thumper/db";
import { jobs } from "@thumper/db";
import { inArray } from "drizzle-orm";
import { ProcessCancelledError } from "./process";

/**
 * Throw if the job should stop: the signal aborted, the row (or its playlist
 * parent) is cancelling/cancelled, or either row has been deleted.
 *
 * A deleted row counts as cancelled — "Clear finished" removes jobs while a
 * worker may still be running one, and continuing would write updates and
 * upload files for a job nobody is watching. Passing `parentJobId` also stops
 * playlist children when the parent is cancelled mid-download.
 */
export async function ensureNotCancelled(
  signal: AbortSignal,
  db: Db,
  jobId: string,
  parentJobId?: string,
): Promise<void> {
  if (signal.aborted) throw new ProcessCancelledError();

  const ids = parentJobId ? [jobId, parentJobId] : [jobId];
  const rows = await db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.id, ids));

  if (rows.some((row) => row.status === "cancelling" || row.status === "cancelled")) {
    throw new ProcessCancelledError();
  }
  if (!rows.some((row) => row.id === jobId)) throw new ProcessCancelledError();
  if (parentJobId && !rows.some((row) => row.id === parentJobId)) {
    throw new ProcessCancelledError();
  }
}
