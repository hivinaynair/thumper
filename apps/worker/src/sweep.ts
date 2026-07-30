/**
 * One-shot expiry sweep. Invoked on a schedule by Modal; the long-running
 * worker sweeps on its own interval instead.
 */
import { createDb } from "@thumper/db";
import { sweepExpiredFiles } from "@thumper/pipeline";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  log.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(databaseUrl);
const { deleted, failed } = await sweepExpiredFiles(db);
log.info({ deleted, failed }, "Expiry sweep finished");
process.exit(failed > 0 ? 1 : 0);
