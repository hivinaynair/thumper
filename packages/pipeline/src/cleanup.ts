import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "@thumper/db";
import { files } from "@thumper/db";
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

  let deleted = 0;
  let failed = 0;

  for (const row of expired) {
    try {
      await deleteObject(row.relativePath);
    } catch {
      failed += 1;
      continue;
    }
    await db.delete(files).where(eq(files.id, row.id));
    deleted += 1;
  }

  return { deleted, failed };
}
