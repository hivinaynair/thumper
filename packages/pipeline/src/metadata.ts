import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { detectSourceKind } from "@thumper/shared";
import { dumpJson } from "./download";
import { runCommandOk } from "./process";
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
  source: "spotify" | "soundcloud" | "youtube-music" | "hint";
  /**
   * YouTube pads square cover art onto a 16:9 canvas. Set when the artwork must
   * be pillarbox-cropped before it becomes an APIC frame — and dropped if no
   * pillarbox is found, since that means a video frame rather than a cover.
   */
  artworkNeedsSquareCrop?: boolean;
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
 * SoundCloud free-download titles often trail "(free DL)" / "(Free Download)".
 * Strip those so audio tags and filenames stay clean.
 */
export function stripFreeDownloadLabel(text: string): string {
  return text
    .replace(/\s*[\(\[]\s*free\s*(?:dl|d\/l|download)\s*[\)\]]/gi, "")
    .replace(/\s*[-–—]\s*free\s*(?:dl|d\/l|download)\s*$/i, "")
    .replace(/\s+free\s*(?:dl|d\/l|download)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
 * YouTube's auto-generated artist channels are named "<artist> - Topic". That
 * suffix is a YouTube implementation detail, not part of anyone's name, and it
 * reached both the artist tag and the filename.
 */
export function stripTopicSuffix(name: string): string {
  return name.replace(/\s*[-–—]\s*Topic\s*$/i, "").trim();
}

/**
 * Drop repeats of the same credit. yt-dlp lists `artists` once per release the
 * track appears on, so a single artist arrives two or three times — often in
 * different cases — and the tag came out "Oscar Wallyn, oscar wallyn, oscar
 * wallyn". First spelling wins: it's the one with the label's own casing.
 */
export function dedupeArtistNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  if (credited.length) return dedupeArtistNames(credited);

  const fallback = [info.artist, info.uploader, info.creator].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return dedupeArtistNames(
    splitArtistNames(fallback).map(stripTopicSuffix).filter(Boolean),
  );
}

/**
 * True when a YouTube entry is a music release rather than a video upload.
 *
 * A `- Topic` channel is the clearest signal, but not the only one: labels also
 * publish to Official Artist Channels, which carry the same label-supplied
 * `album` / `artists` fields under the artist's own name. Gating on the channel
 * suffix alone silently skipped those — they came out with no artwork at all.
 */
export function isMusicEntry(info: Record<string, unknown>): boolean {
  const channel = [info.uploader, info.channel].find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (channel && /\s[-–—]\s*Topic\s*$/i.test(channel)) return true;
  if (Array.isArray(info.artists) && info.artists.length > 0) return true;
  return typeof info.album === "string" && info.album.trim().length > 0;
}

export function youtubeMusicTagsFromInfo(
  info: Record<string, unknown>,
): TrackTags | null {
  if (!isMusicEntry(info)) return null;

  const title =
    [info.track, info.title].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    )?.trim() ?? undefined;
  const artist = artistNamesFromInfo(info).join(", ") || undefined;
  if (!title && !artist) return null;

  const album =
    typeof info.album === "string" && info.album.trim()
      ? info.album.trim()
      : undefined;
  const genre =
    typeof info.genre === "string" && info.genre.trim()
      ? info.genre.trim()
      : undefined;
  const release = info.release_date ?? info.upload_date;
  const date =
    typeof release === "string" && /^\d{8}$/.test(release)
      ? `${release.slice(0, 4)}-${release.slice(4, 6)}-${release.slice(6, 8)}`
      : undefined;

  // maxresdefault is the square cover centred on a 16:9 canvas; the smaller
  // presets are re-encodes of the same padded frame, so take the biggest.
  const thumb =
    (typeof info.thumbnail === "string" && info.thumbnail) ||
    (Array.isArray(info.thumbnails) &&
      [...info.thumbnails].reverse().find((t) => typeof t?.url === "string")
        ?.url) ||
    null;

  return {
    title,
    artist,
    album,
    genre,
    date,
    artworkUrl:
      typeof thumb === "string" && thumb
        ? thumb.replace(/^http:\/\//i, "https://")
        : undefined,
    artworkNeedsSquareCrop: true,
    source: "youtube-music",
  };
}

export async function fetchYouTubeMusicTags(
  url: string,
  options: { cookiePath?: string | null; signal?: AbortSignal } = {},
): Promise<TrackTags | null> {
  try {
    const info = await dumpJson(url, options.cookiePath ?? null, options.signal);
    return youtubeMusicTagsFromInfo(info);
  } catch {
    return null;
  }
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
  if (title) title = stripFreeDownloadLabel(title) || undefined;

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
    if (title) title = stripFreeDownloadLabel(title) || undefined;
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
    if (kind === "youtube") {
      // Only Topic channels answer here; a normal upload falls through to the
      // hints, keeping the "never YouTube" rule where it earns its keep.
      const tags = await fetchYouTubeMusicTags(url, {
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
    artist: params.artistHint
      ? stripTopicSuffix(params.artistHint) || params.artistHint
      : undefined,
    source: "hint",
  };
}

/** Probe raster size. Small enough to be cheap, wide enough to resolve borders. */
const PROBE_W = 64;
const PROBE_H = 36;
/** A pillarbox is a flat fill, so its columns have essentially no variation. */
const FLAT_STDDEV = 1.5;

/**
 * Width of the uniform border on each side of a greyscale raster, in columns.
 *
 * Pure so it can be tested without ffmpeg. Returns 0 when the edges carry
 * detail, which is what a real 16:9 video frame looks like.
 */
export function pillarboxColumns(
  gray: Uint8Array,
  width = PROBE_W,
  height = PROBE_H,
): number {
  const stats = (x: number) => {
    let sum = 0;
    for (let y = 0; y < height; y++) sum += gray[y * width + x]!;
    const mean = sum / height;
    let acc = 0;
    for (let y = 0; y < height; y++) acc += (gray[y * width + x]! - mean) ** 2;
    return { mean, sd: Math.sqrt(acc / height) };
  };

  const first = stats(0);
  if (first.sd > FLAT_STDDEV) return 0;

  const flatRun = (from: number, step: number) => {
    let n = 0;
    for (let x = from; x >= 0 && x < width; x += step) {
      const s = stats(x);
      if (s.sd > FLAT_STDDEV || Math.abs(s.mean - first.mean) > 2) break;
      n++;
    }
    return n;
  };

  const left = flatRun(0, 1);
  const right = flatRun(width - 1, -1);
  // Both sides must match: a single flat edge is a dark scene, not a pillarbox.
  return Math.min(left, right);
}

/**
 * Square cover art padded onto a 16:9 canvas, cropped back — or null when the
 * image is a real video frame, which is not cover art and should not be tagged
 * as one.
 *
 * ffmpeg's own `cropdetect` cannot do this: it only strips borders darker than
 * a luma threshold, and YouTube pads with a colour sampled from the artwork.
 */
async function cropPillarboxedSquare(
  filePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // Via a temp file rather than stdout: runCommand decodes stdout as text,
  // which mangles raw pixel bytes.
  const rasterPath = `${filePath}.gray`;
  let gray: Buffer;
  try {
    await runCommandOk(
      "ffmpeg",
      [
        "-v", "error",
        "-i", filePath,
        "-vf", `scale=${PROBE_W}:${PROBE_H}`,
        "-pix_fmt", "gray",
        "-frames:v", "1",
        "-f", "rawvideo",
        "-y", rasterPath,
      ],
      { signal },
    );
    gray = await fs.readFile(rasterPath);
  } catch {
    return null;
  } finally {
    await fs.unlink(rasterPath).catch(() => undefined);
  }
  if (gray.length < PROBE_W * PROBE_H) return null;
  if (pillarboxColumns(new Uint8Array(gray)) < 2) return null;

  const out = filePath.replace(/(\.[^.]+)$/, "_sq$1");
  try {
    await runCommandOk(
      "ffmpeg",
      ["-v", "error", "-i", filePath, "-vf", "crop=ih:ih", "-y", out],
      { signal },
    );
    await fs.unlink(filePath).catch(() => undefined);
    return out;
  } catch {
    return null;
  }
}

export async function downloadArtworkFile(params: {
  artworkUrl: string;
  workDir: string;
  squareCrop?: boolean;
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
    if (!params.squareCrop) return filePath;
    const square = await cropPillarboxedSquare(filePath, params.signal);
    if (!square) await fs.unlink(filePath).catch(() => undefined);
    return square;
  } catch {
    return null;
  }
}
