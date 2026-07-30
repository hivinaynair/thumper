import { MAX_PLAYLIST_TRACKS } from "@thumper/shared";
import { getYtDlpPath } from "./paths";
import { runCommandOk, type SpawnOptions } from "./process";

export type PlaylistEntry = {
  url: string;
  title?: string;
  artist?: string;
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

  return { title: playlistTitle, entries: unique };
}
