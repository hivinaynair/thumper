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
    const oembedUrl = new URL("https://soundcloud.com/oembed");
    oembedUrl.searchParams.set("format", "json");
    oembedUrl.searchParams.set("url", url);
    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": UA },
      signal: options.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as SoundCloudOEmbed;
      const rawTitle = String(data.title ?? "").trim();
      // oEmbed titles are often "Track by Artist"
      const byMatch = rawTitle.match(/^(.*?)\s+by\s+(.+)$/i);
      if (byMatch?.[1] && byMatch[2]) {
        title = byMatch[1].trim();
        artist = byMatch[2].trim();
      } else if (rawTitle) {
        title = rawTitle;
      }
      if (!artist && data.author_name) artist = data.author_name.trim();
      if (data.thumbnail_url) {
        artworkUrl = data.thumbnail_url.replace(/^http:\/\//i, "https://");
      }
    }
  } catch {
    /* fall through to yt-dlp dump */
  }

  try {
    const info = await dumpJson(url, options.cookiePath ?? null, options.signal);
    if (!title) title = String(info.title ?? info.track ?? "").trim() || undefined;
    if (!artist) {
      artist =
        String(info.artist ?? info.uploader ?? info.creator ?? "").trim() ||
        undefined;
    }
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
    if (typeof info.genre === "string" && info.genre.trim()) {
      genre = info.genre.trim();
    }
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
