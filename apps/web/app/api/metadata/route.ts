import { auth } from "@clerk/nextjs/server";
import { detectSourceKind, isSupportedSource } from "@thumper/shared";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url).searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  if (!isSupportedSource(url)) {
    return NextResponse.json(
      { error: "Only YouTube, SoundCloud, or Spotify are supported" },
      { status: 400 },
    );
  }

  return NextResponse.json({ kind: detectSourceKind(url), meta: null });
}
