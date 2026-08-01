import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectSourceKind } from "@thumper/shared";
import { dumpJson } from "./download";
import {
  fetchSpotifyCatalog,
  fetchSpotifyTrackArtworkUrl,
} from "./spotify";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type TrackTags = {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  date?: string;
  artworkUrl?: string;
  source: "spotify" | "soundcloud" | "hint";
};

type SoundCloudOEmbed = {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
  description?: string;
};

// Slashes need spaces around them (AC/DC is one band) and " and " must not be
// followed by an article ("Florence and the Machine"). U+FF0C is what yt-dlp
// substitutes for commas when it flattens its `artists` list.
const ARTIST_SEPARATOR =
  /\s*[,，、;]\s*|\s*&\s*|\s+\/\s+|\s+(?:x|vs\.?|feat\.?|ft\.?|featuring|with)\s+|\s+and\s+(?!the\s)/i;

/**
 * SoundCloud display names often trail emoji ("MARY DROPPINZ ☔"). Those
 * characters break ytsearch queries and never appear on YouTube Topic
 * channels, so a perfect track match scores as a miss.
 */
export function stripDecorative(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Artist credits arrive as one string ("Oppidan and Hans Glader"), but the
 * mirror matcher scores each artist separately — an unsplit credit compares
 * badly against a channel named after just one of them, which is what sank the
 * YouTube fallback for collaborations.
 */
export function splitArtistNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(ARTIST_SEPARATOR)
    .map((name) => stripDecorative(name))
    .filter(Boolean);
}

/**
 * Artist names out of a yt-dlp info dict. Prefers the real credit (`artists`)
 * over the channel that uploaded it, since a label or aggregator account says
 * nothing useful about who made the track.
 */
export function artistNamesFromInfo(info: Record<string, unknown>): string[] {
  const credited = Array.isArray(info.artists)
    ? info.artists.flatMap((a) =>
        typeof a === "string" ? splitArtistNames(a) : [],
      )
    : [];
  if (credited.length) return credited;

  const fallback = [info.artist, info.uploader, info.creator].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return splitArtistNames(fallback);
}

/**
 * The oEmbed endpoint 404s on the `api-v2.soundcloud.com/tracks/<id>` URLs
 * yt-dlp emits for unhydrated playlist entries, but answers for the `api.`
 * form. That matters most for DRM/geo-blocked tracks: oEmbed is then the only
 * metadata source left, since extraction itself is refused.
 */
export function soundCloudOEmbedTarget(url: string): string {
  return url.replace(
    /^https?:\/\/api-v2\.soundcloud\.com\/tracks\/(\d+).*$/i,
    "https://api.soundcloud.com/tracks/$1",
  );
}

/** Title / artist / artwork from SoundCloud's public oEmbed endpoint. */
export async function fetchSoundCloudOEmbed(
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<{
  title?: string;
  artist?: string;
  artworkUrl?: string;
} | null> {
  const oembedUrl = new URL("https://soundcloud.com/oembed");
  oembedUrl.searchParams.set("format", "json");
  oembedUrl.searchParams.set("url", soundCloudOEmbedTarget(url));

  const res = await fetch(oembedUrl, {
    headers: { "User-Agent": UA },
    signal: options.signal,
  });
  if (!res.ok) return null;

  const data = (await res.json()) as SoundCloudOEmbed;
  const rawTitle = String(data.title ?? "").trim();
  const artist = data.author_name?.trim() || undefined;

  // oEmbed titles read "Track by Uploader". Strip that suffix using the
  // uploader we were given rather than the first " by " in the string, so
  // "Taken by the Tide by Oppidan" survives.
  let title = rawTitle || undefined;
  if (title && artist && title.toLowerCase().endsWith(` by ${artist.toLowerCase()}`)) {
    title = title.slice(0, -(artist.length + 4)).trim() || undefined;
  }

  const artworkUrl = data.thumbnail_url
    ? data.thumbnail_url.replace(/^http:\/\//i, "https://")
    : undefined;

  if (!title && !artist && !artworkUrl) return null;
  return { title, artist, artworkUrl };
}

export async function fetchSoundCloudTags(
  url: string,
  options: { cookiePath?: string | null; signal?: AbortSignal } = {},
): Promise<TrackTags | null> {
  let title: string | undefined;
  let artist: string | undefined;
  let artworkUrl: string | undefined;
  let genre: string | undefined;
  let album: string | undefined;
  let date: string | undefined;

  try {
    const embed = await fetchSoundCloudOEmbed(url, { signal: options.signal });
    title = embed?.title;
    artist = embed?.artist;
    artworkUrl = embed?.artworkUrl;
  } catch {
    /* fall through to yt-dlp dump */
  }

  try {
    const info = await dumpJson(url, options.cookiePath ?? null, options.signal);
    if (!title) title = String(info.title ?? info.track ?? "").trim() || undefined;
    if (!artist) artist = artistNamesFromInfo(info).join(", ") || undefined;
    if (!artworkUrl) {
      const thumb =
        (typeof info.thumbnail === "string" && info.thumbnail) ||
        (Array.isArray(info.thumbnails) &&
          [...info.thumbnails]
            .reverse()
            .find((t) => typeof t?.url === "string")?.url) ||
        null;
      if (typeof thumb === "string" && thumb) {
        artworkUrl = thumb.replace(/^http:\/\//i, "https://");
      }
    }
    const rawGenre =
      (typeof info.genre === "string" && info.genre) ||
      (Array.isArray(info.genres) &&
        info.genres.find((g): g is string => typeof g === "string")) ||
      "";
    if (rawGenre.trim()) genre = rawGenre.trim();
    if (typeof info.album === "string" && info.album.trim()) {
      album = info.album.trim();
    }
    const upload = info.upload_date ?? info.release_date;
    if (typeof upload === "string" && /^\d{8}$/.test(upload)) {
      date = `${upload.slice(0, 4)}-${upload.slice(4, 6)}-${upload.slice(6, 8)}`;
    }
  } catch {
    /* best effort */
  }

  if (!title && !artist && !artworkUrl) return null;
  return {
    title,
    artist,
    album,
    genre,
    date,
    artworkUrl,
    source: "soundcloud",
  };
}

export async function fetchSpotifyTags(
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<TrackTags | null> {
  const catalog = await fetchSpotifyCatalog(url);
  if (!catalog || catalog.tracks.length === 0) return null;
  const track = catalog.tracks[0]!;
  const artworkUrl = await fetchSpotifyTrackArtworkUrl(url, options.signal);
  return {
    title: track.title,
    artist: track.artists.join(", ") || undefined,
    album: catalog.type === "album" ? catalog.title : undefined,
    date: undefined,
    artworkUrl: artworkUrl ?? undefined,
    source: "spotify",
  };
}

/**
 * Prefer Spotify or SoundCloud for tags/artwork — never YouTube.
 * `catalogUrl` should be the original Spotify/SoundCloud page when audio was mirrored.
 */
export async function resolveTrackTags(params: {
  catalogUrl?: string | null;
  downloadUrl?: string | null;
  titleHint?: string;
  artistHint?: string;
  cookiePath?: string | null;
  signal?: AbortSignal;
}): Promise<TrackTags> {
  const candidates = [params.catalogUrl, params.downloadUrl].filter(
    (u): u is string => Boolean(u),
  );

  for (const url of candidates) {
    const kind = detectSourceKind(url);
    if (kind === "spotify") {
      const tags = await fetchSpotifyTags(url, { signal: params.signal });
      if (tags) {
        return {
          ...tags,
          title: tags.title ?? params.titleHint,
          artist: tags.artist ?? params.artistHint,
        };
      }
    }
    if (kind === "soundcloud") {
      const tags = await fetchSoundCloudTags(url, {
        cookiePath: params.cookiePath,
        signal: params.signal,
      });
      if (tags) {
        return {
          ...tags,
          title: tags.title ?? params.titleHint,
          artist: tags.artist ?? params.artistHint,
        };
      }
    }
  }

  return {
    title: params.titleHint,
    artist: params.artistHint,
    source: "hint",
  };
}

export async function downloadArtworkFile(params: {
  artworkUrl: string;
  workDir: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  try {
    const res = await fetch(params.artworkUrl, {
      headers: { "User-Agent": UA },
      signal: params.signal,
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 100) return null;
    const ctype = res.headers.get("content-type") ?? "";
    const ext = ctype.includes("png")
      ? "png"
      : ctype.includes("webp")
        ? "webp"
        : "jpg";
    const filePath = path.join(
      params.workDir,
      `cover_${randomUUID()}.${ext}`,
    );
    await fs.writeFile(filePath, buf);
    return filePath;
  } catch {
    return null;
  }
}
