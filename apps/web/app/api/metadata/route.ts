import { auth } from "@clerk/nextjs/server";
import { detectSourceKind } from "@thumper/shared";
import { fetchSpotifyTrackMeta } from "@thumper/pipeline";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url).searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  const kind = detectSourceKind(url);
  if (kind === "spotify") {
    const meta = await fetchSpotifyTrackMeta(url);
    return NextResponse.json({ kind, meta });
  }

  return NextResponse.json({ kind, meta: null });
}
