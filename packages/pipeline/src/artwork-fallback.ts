import { MIN_MATCH_SCORE, scoreMirrorCandidate } from "./match";
import { splitArtistNames } from "./metadata";
import { searchSoundCloudTracks } from "./retag-search";
import type { SpotifyTrackMeta } from "./spotify";

/**
 * Cover art for a track whose own source has none — a YouTube upload with a
 * 16:9 video frame instead of a sleeve.
 *
 * Reuses the SoundCloud search and the mirror scorer rather than trusting the
 * first hit: the whole risk here is stapling some other release's artwork onto
 * the file, so a candidate under MIN_MATCH_SCORE is dropped and the track keeps
 * no artwork at all. Returns null freely — this is a nicety, not a requirement.
 */
export async function findFallbackArtworkUrl(params: {
  title: string;
  artist?: string;
  durationSec?: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  const query = [params.artist, params.title].filter(Boolean).join(" ").trim();
  if (!query) return null;

  try {
    const hits = await searchSoundCloudTracks(query, {
      limit: 4,
      signal: params.signal,
    });
    const track: SpotifyTrackMeta = {
      title: params.title,
      artists: splitArtistNames(params.artist),
      ...(params.durationSec ? { durationMs: params.durationSec * 1000 } : {}),
    };

    let best: { score: number; artworkUrl: string } | null = null;
    for (const hit of hits) {
      if (!hit.artworkUrl) continue;
      const scored = scoreMirrorCandidate(track, {
        url: hit.url,
        title: hit.title,
        uploader: hit.artist,
        durationSec: hit.durationSec,
        views: 0,
        source: "soundcloud",
      });
      if (scored.score < MIN_MATCH_SCORE) continue;
      if (!best || scored.score > best.score) {
        best = { score: scored.score, artworkUrl: hit.artworkUrl };
      }
    }
    return best?.artworkUrl ?? null;
  } catch {
    return null;
  }
}
