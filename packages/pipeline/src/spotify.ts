export type SpotifyTrackMeta = {
  id: string;
  title: string;
  artists: string[];
  durationMs?: number;
  coverUrl?: string;
};

function embedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const type = parts[0];
    const id = parts[1]?.split("?")[0];
    if (!type || !id) return null;
    if (!["track", "album", "playlist"].includes(type)) return null;
    return `https://open.spotify.com/embed/${type}/${id}`;
  } catch {
    return null;
  }
}

function highestImage(entity: Record<string, unknown>): string | undefined {
  const visual = entity.visualIdentity as
    | { image?: Array<{ url?: string; maxWidth?: number }> }
    | undefined;
  const images = visual?.image ?? [];
  if (!images.length) return undefined;
  return [...images].sort(
    (a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0),
  )[0]?.url;
}

export async function fetchSpotifyTrackMeta(
  url: string,
): Promise<SpotifyTrackMeta | null> {
  const embed = embedUrl(url);
  if (!embed) return null;

  const res = await fetch(embed, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Thumper/1.0; +https://github.com/thumper)",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match?.[1]) return null;

  const data = JSON.parse(match[1]) as {
    props?: { pageProps?: { state?: { data?: { entity?: Record<string, unknown> } } } };
  };
  const entity = data.props?.pageProps?.state?.data?.entity;
  if (!entity) return null;

  const title = String(entity.name ?? entity.title ?? "Unknown");
  const artistsRaw = entity.artists ?? entity.subtitle;
  let artists: string[] = [];
  if (Array.isArray(artistsRaw)) {
    artists = artistsRaw.map((a) =>
      typeof a === "string" ? a : String((a as { name?: string }).name ?? ""),
    );
  } else if (typeof artistsRaw === "string") {
    artists = artistsRaw.split(",").map((s) => s.trim());
  }

  const durationMs =
    typeof entity.duration === "number"
      ? entity.duration
      : typeof entity.durationMs === "number"
        ? entity.durationMs
        : undefined;

  return {
    id: String(entity.id ?? ""),
    title,
    artists: artists.filter(Boolean),
    durationMs,
    coverUrl: highestImage(entity),
  };
}

/** spotDL-inspired: artist + title + official audio, with duration window. */
export function buildYoutubeSearchQuery(meta: SpotifyTrackMeta): string {
  const artist = meta.artists[0] ?? "";
  return `ytsearch5:${artist} ${meta.title} official audio`.trim();
}

export function durationMatchFilter(durationMs?: number): string | undefined {
  if (!durationMs || durationMs <= 0) return undefined;
  const seconds = Math.round(durationMs / 1000);
  const margin = Math.max(30, Math.round(seconds * 0.3));
  const min = Math.max(1, seconds - margin);
  const max = seconds + margin;
  return `duration>=${min} & duration<=${max}`;
}
