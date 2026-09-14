import { createDb } from "@thumper/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET() {
  const checks: Record<string, unknown> = {
    ok: true,
    service: "thumper-web",
    processBackend: process.env.PROCESS_BACKEND ?? "pgboss",
    objectStorage: Boolean(
      process.env.R2_ACCOUNT_ID?.trim() &&
        process.env.R2_ACCESS_KEY_ID?.trim() &&
        process.env.R2_SECRET_ACCESS_KEY?.trim() &&
        process.env.R2_BUCKET?.trim(),
    ),
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
