import type { Db } from "@thumper/db";
import { files } from "@thumper/db";
import { mapWithConcurrency } from "@thumper/shared";
import { and, inArray, isNotNull, lt } from "drizzle-orm";
import { deleteObject } from "./storage";

/**
 * How long a delivered file survives before the sweep removes it.
 *
 * Short on purpose: the object store is a hand-off buffer for the browser
 * download, not an archive. Drive deliveries are unaffected — those files
 * never enter the store.
 */
export const FILE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Delete stored objects whose `expiresAt` has passed, then drop their rows.
 *
 * The object is deleted first: if that fails we keep the row so the next sweep
 * retries, rather than orphaning bytes with no record pointing at them.
 */
export async function sweepExpiredFiles(
  db: Db,
  now: Date = new Date(),
): Promise<{ deleted: number; failed: number }> {
  const expired = await db
    .select({
      id: files.id,
      relativePath: files.relativePath,
    })
    .from(files)
    .where(and(isNotNull(files.expiresAt), lt(files.expiresAt, now)));

  // Each delete is a round trip to the object store, so overlap them; the
  // rows whose object went are then dropped in one statement rather than N.
  const outcomes = await mapWithConcurrency(expired, 8, async (row) => {
    try {
      await deleteObject(row.relativePath);
      return row.id;
    } catch {
      return null;
    }
  });

  const deletedIds = outcomes.filter((id): id is string => id !== null);
  if (deletedIds.length > 0) {
    await db.delete(files).where(inArray(files.id, deletedIds));
  }

  return { deleted: deletedIds.length, failed: expired.length - deletedIds.length };
}
