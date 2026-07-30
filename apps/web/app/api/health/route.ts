import { createDb } from "@thumper/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET() {
  const checks: Record<string, unknown> = {
    ok: true,
    service: "thumper-web",
    processBackend: process.env.PROCESS_BACKEND ?? "pgboss",
    blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()),
  };

  try {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL missing");
    const db = createDb(url);
    await db.execute(sql`select 1`);
    checks.database = "ok";
  } catch (err) {
    checks.ok = false;
    checks.database = err instanceof Error ? err.message : "fail";
  }

  return NextResponse.json(checks, { status: checks.ok ? 200 : 503 });
}
