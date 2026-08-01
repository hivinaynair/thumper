import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
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
