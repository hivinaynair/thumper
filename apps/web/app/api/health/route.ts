import { createDb } from "@thumper/db";
import { getYtDlpPath } from "@thumper/pipeline";
import { sql } from "drizzle-orm";
import { spawnSync } from "node:child_process";
import { NextResponse } from "next/server";

export async function GET() {
  const checks: Record<string, unknown> = {
    ok: true,
    service: "thumper-web",
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

  try {
    const bin = getYtDlpPath();
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    checks.ytdlp = r.status === 0 ? r.stdout.trim() : "missing";
  } catch {
    checks.ytdlp = "missing";
  }

  return NextResponse.json(checks, { status: checks.ok ? 200 : 503 });
}
