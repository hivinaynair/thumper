import { auth } from "@clerk/nextjs/server";
import {
  queryFromAudioFilename,
  searchSoundCloudTracks,
} from "@thumper/pipeline/retag-search";
import { NextResponse } from "next/server";
import { wakeModalSearch } from "../../../../lib/wake-modal";

export const runtime = "nodejs";
export const maxDuration = 120;

type SearchBody = {
  query?: string;
  filename?: string;
};

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SearchBody;
  try {
    body = (await req.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const query =
    body.query?.trim() ||
    (body.filename ? queryFromAudioFilename(body.filename) : "") ||
    "";
  if (!query) {
    return NextResponse.json(
      { error: "query or filename required" },
      { status: 400 },
    );
  }

  const backend = (process.env.PROCESS_BACKEND ?? "pgboss").toLowerCase();

  try {
    if (backend === "modal") {
      const candidates = await wakeModalSearch(query);
      return NextResponse.json({ query, candidates });
    }

    const candidates = await searchSoundCloudTracks(query, { limit: 2 });
    return NextResponse.json({ query, candidates });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `SoundCloud search failed: ${message}` },
      { status: 502 },
    );
  }
}
