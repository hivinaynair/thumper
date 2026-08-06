import { getYtDlpPath } from "./paths";
import { fetchSoundCloudOEmbed } from "./metadata";
import { runCommandOk, type SpawnOptions } from "./process";

export type SoundCloudSearchHit = {
  url: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  durationSec: number;
};

/**
 * Turn an uploaded WAV filename into a SoundCloud search query.
 * Handles `Artist - Title.wav`, underscores, and trailing quality tags.
 */
export function queryFromWavFilename(filename: string): string {
  const base = filename
    .replace(/^.*[/\\]/, "")
    .replace(/\.wav$/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Drop common SoundCloud free-download suffixes that poison search.
  return base
    .replace(/\s*[\(\[]?(free\s*download|hq|wav|aiff|flac)[\)\]]?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSearchLines(stdout: string): Omit<SoundCloudSearchHit, "artworkUrl">[] {
  const out: Omit<SoundCloudSearchHit, "artworkUrl">[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [url, title, uploader, duration] = trimmed.split("\t");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (!/soundcloud\.com/i.test(url)) continue;
    const durationSec = Number.parseFloat(duration ?? "");
    out.push({
      url,
      title: title && title !== "NA" ? title : "",
      artist: uploader && uploader !== "NA" ? uploader : "",
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    });
  }
  return out;
}

/**
 * Search SoundCloud via yt-dlp `scsearchN:` and attach oEmbed artwork for the
 * top hits so the UI can show a confirmable thumbnail.
 */
export async function searchSoundCloudTracks(
  query: string,
  options: SpawnOptions & { limit?: number } = {},
): Promise<SoundCloudSearchHit[]> {
  const cleaned = query.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const limit = Math.min(Math.max(options.limit ?? 2, 1), 8);
  const { stdout } = await runCommandOk(
    getYtDlpPath(),
    [
      "--flat-playlist",
      "--skip-download",
      "--no-warnings",
      "--print",
      "%(webpage_url)s\t%(title)s\t%(uploader)s\t%(duration)s",
      `scsearch${limit}:${cleaned}`,
    ],
    { signal: options.signal },
  );

  const raw = parseSearchLines(stdout).slice(0, limit);
  const hits: SoundCloudSearchHit[] = [];

  for (const row of raw) {
    const oembed = await fetchSoundCloudOEmbed(row.url, {
      signal: options.signal,
    });
    hits.push({
      url: row.url,
      title: oembed?.title || row.title,
      artist: oembed?.artist || row.artist,
      artworkUrl: oembed?.artworkUrl,
      durationSec: row.durationSec,
    });
  }

  return hits;
}
