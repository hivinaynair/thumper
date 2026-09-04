import net from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

/**
 * How long each of the host's resolved addresses gets to finish its TCP
 * handshake.
 *
 * Bun races the addresses (happy eyeballs) and allows only 250ms apiece by
 * default. A cold Modal container reaching Neon needs longer, and once every
 * address misses its window the socket rejects with an aggregated ETIMEDOUT —
 * sub-second, so `connect_timeout` below never gets to apply and an immediate
 * retry lands in the same window. Wide enough to absorb a SYN retransmit,
 * tight enough that an unroutable address family still falls back quickly.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

export function createDb(connectionString: string) {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);

  // Neon (and Modal cold starts) need TLS + a longer connect window; without
  // this the worker can ETIMEDOUT on the first query and leave jobs "queued".
  const client = postgres(connectionString, {
    max: 10,
    ssl: "require",
    connect_timeout: 30,
    idle_timeout: 20,
  });
  return drizzle(client, { schema });
}
