const SPOTIFY_EMBED_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type SpotifyTrackMeta = {
  title: string;
  artists: string[];
  durationMs?: number;
  spotifyUrl?: string;
  artworkUrl?: string;
};

export type SpotifyCatalog = {
  type: "track" | "album" | "playlist";
  id: string;
  title: string;
  tracks: SpotifyTrackMeta[];
  artworkUrl?: string;
};

type SpotifyEmbedEntity = {
  name?: string;
  title?: string;
  duration?: number;
  durationMs?: number;
  artists?: Array<{ name: string } | string>;
  subtitle?: string;
  visualIdentity?: {
    image?: Array<{ url?: string; maxHeight?: number; maxWidth?: number }>;
  };
  trackList?: Array<{
    title: string;
    subtitle?: string;
    duration?: number;
    uri?: string;
  }>;
};

function parseEmbedUrl(url: string): { type: string; id: string } | null {
  const match = url.match(
    /spotify\.com\/(playlist|album|track)\/([a-zA-Z0-9]+)/,
  );
  if (!match?.[1] || !match[2]) return null;
  return { type: match[1], id: match[2] };
}

function artistsFromEntity(entity: SpotifyEmbedEntity): string[] {
  if (Array.isArray(entity.artists)) {
    return entity.artists
      .map((a) => (typeof a === "string" ? a : a.name))
      .filter(Boolean);
  }
  if (typeof entity.subtitle === "string") {
    return entity.subtitle.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function artworkFromEntity(entity: SpotifyEmbedEntity): string | undefined {
  const images = entity.visualIdentity?.image ?? [];
  if (images.length === 0) return undefined;
  const best = [...images].sort(
    (a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0),
  )[0];
  return best?.url || undefined;
}

async function fetchSpotifyEmbedEntity(
  url: string,
  signal?: AbortSignal,
): Promise<{ parsed: { type: string; id: string }; entity: SpotifyEmbedEntity } | null> {
  const parsed = parseEmbedUrl(url);
  if (!parsed) return null;
  if (!["track", "album", "playlist"].includes(parsed.type)) return null;

  const res = await fetch(
    `https://open.spotify.com/embed/${parsed.type}/${parsed.id}?utm_source=oembed`,
    { headers: { "User-Agent": SPOTIFY_EMBED_UA }, signal },
  );
  if (!res.ok) return null;
  const html = await res.text();
  const nextData = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/,
  )?.[1];
  if (!nextData) return null;

  const entity = JSON.parse(nextData)?.props?.pageProps?.state?.data
    ?.entity as SpotifyEmbedEntity | undefined;
  if (!entity) return null;
  return { parsed, entity };
}

export async function fetchSpotifyTrackArtworkUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const hit = await fetchSpotifyEmbedEntity(url, signal);
  if (!hit) return null;
  return artworkFromEntity(hit.entity) ?? null;
}

export async function fetchSpotifyCatalog(
  url: string,
  signal?: AbortSignal,
): Promise<SpotifyCatalog | null> {
  const hit = await fetchSpotifyEmbedEntity(url, signal);
  if (!hit) return null;
  const { parsed, entity } = hit;

  const title = String(entity.name ?? entity.title ?? "Spotify");
  const type = parsed.type as SpotifyCatalog["type"];
  const artworkUrl = artworkFromEntity(entity);

  if (type === "track") {
    const durationMs =
      typeof entity.duration === "number"
        ? entity.duration
        : typeof entity.durationMs === "number"
          ? entity.durationMs
          : undefined;
    return {
      type,
      id: parsed.id,
      title,
      artworkUrl,
      tracks: [
        {
          title,
          artists: artistsFromEntity(entity),
          durationMs,
          spotifyUrl: `https://open.spotify.com/track/${parsed.id}`,
          artworkUrl,
        },
      ],
    };
  }

  const tracks: SpotifyTrackMeta[] = (entity.trackList ?? []).map((t) => {
    const id = t.uri?.split(":").pop();
    return {
      title: t.title,
      artists: (t.subtitle ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      durationMs: typeof t.duration === "number" ? t.duration : undefined,
      spotifyUrl: id ? `https://open.spotify.com/track/${id}` : undefined,
      artworkUrl,
    };
  });

  return { type, id: parsed.id, title, artworkUrl, tracks };
}

export function buildYoutubeSearchQuery(track: SpotifyTrackMeta): string {
  const artist = track.artists[0] ?? "";
  return `ytsearch5:${artist} ${track.title} official audio`.trim();
}

export function buildSoundCloudSearchQuery(track: SpotifyTrackMeta): string {
  const artist = track.artists[0] ?? "";
  return `scsearch5:${artist} ${track.title}`.trim();
}

export function durationMatchFilter(durationMs?: number): string | undefined {
  if (!durationMs || durationMs <= 0) return undefined;
  const seconds = Math.round(durationMs / 1000);
  const margin = Math.max(30, Math.round(seconds * 0.3));
  return `duration>=${Math.max(1, seconds - margin)} & duration<=${seconds + margin}`;
}
