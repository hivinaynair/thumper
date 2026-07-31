import { MAX_PLAYLIST_TRACKS } from "@thumper/shared";
import { fetchSoundCloudOEmbed } from "./metadata";
import { getYtDlpPath } from "./paths";
import { runCommandOk, type SpawnOptions } from "./process";

export type PlaylistEntry = {
  url: string;
  title?: string;
  artist?: string;
  /** Original Spotify track URL when this entry was mirrored. */
  spotifyUrl?: string;
};

/**
 * Expand a YouTube / SoundCloud playlist (or single URL) via yt-dlp flat mode.
 * Returns 1 entry for a single track; many for a playlist/set.
 */
export async function expandPlaylistEntries(
  url: string,
  options: SpawnOptions & { cookiePath?: string | null } = {},
): Promise<{ title?: string; entries: PlaylistEntry[] }> {
  const args = [
    "--flat-playlist",
    "--skip-download",
    "--no-warnings",
    "--print",
    "%(webpage_url)s\t%(title)s\t%(uploader)s\t%(playlist_title)s",
  ];
  if (options.cookiePath) {
    args.push("--cookies", options.cookiePath);
  }
  args.push(url);

  const { stdout } = await runCommandOk(getYtDlpPath(), args, options);
  const entries: PlaylistEntry[] = [];
  let playlistTitle: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [entryUrl, title, artist, plTitle] = trimmed.split("\t");
    if (!entryUrl || !/^https?:\/\//i.test(entryUrl)) continue;
    if (plTitle && plTitle !== "NA") playlistTitle = plTitle;
    entries.push({
      url: entryUrl,
      title: title && title !== "NA" ? title : undefined,
      artist: artist && artist !== "NA" ? artist : undefined,
    });
    if (entries.length >= MAX_PLAYLIST_TRACKS) break;
  }

  // Dedupe by URL (YouTube list= pages can be noisy)
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  return {
    title: playlistTitle,
    entries: await nameSoundCloudEntries(unique, { signal: options.signal }),
  };
}

/** Cap on concurrent oEmbed lookups — polite, and fast enough for 100 tracks. */
const NAME_LOOKUP_CONCURRENCY = 6;

/**
 * Flat expansion of a SoundCloud set names nothing: every entry comes back with
 * `NA` for title and uploader, and everything past the first handful is a bare
 * `api-v2.soundcloud.com/tracks/<id>` URL. So the per-track job has nothing to
 * search YouTube with when SoundCloud refuses the audio, and nothing to show
 * the user but a raw API URL. oEmbed answers for these even when extraction is
 * geo-blocked, so name them here — best effort, never fatal to the playlist.
 */
export async function nameSoundCloudEntries(
  entries: PlaylistEntry[],
  options: {
    signal?: AbortSignal;
    lookup?: (
      url: string,
    ) => Promise<{ title?: string; artist?: string } | null>;
  } = {},
): Promise<PlaylistEntry[]> {
  const lookup =
    options.lookup ??
    ((url: string) => fetchSoundCloudOEmbed(url, { signal: options.signal }));

  const pending = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        !entry.title && /^https?:\/\/[^/]*soundcloud\.com\//i.test(entry.url),
    );
  if (pending.length === 0) return entries;

  const named = [...entries];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(NAME_LOOKUP_CONCURRENCY, pending.length) },
    async () => {
      while (cursor < pending.length) {
        const next = pending[cursor++];
        if (!next || options.signal?.aborted) return;
        try {
          const meta = await lookup(next.entry.url);
          if (!meta?.title) continue;
          named[next.index] = {
            ...next.entry,
            title: meta.title,
            artist: next.entry.artist ?? meta.artist,
          };
        } catch {
          /* an unnamed entry is still downloadable — keep the playlist */
        }
      }
    },
  );
  await Promise.all(workers);

  return named;
}
