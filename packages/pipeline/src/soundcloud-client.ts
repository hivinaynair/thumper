/**
 * SoundCloud API / yt-dlp client_id resolution.
 * yt-dlp scrapes this from the site; when that fails on Modal we inject it via
 * `--extractor-args soundcloud:client_id=…`.
 */

const DEFAULT_CLIENT_ID = "f17476445ba4b72bc5760aa679820d27";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

let cachedClientId: string | null = null;

function clientIdFromEnv(): string | null {
  const fromEnv = process.env.SOUNDCLOUD_CLIENT_ID?.trim();
  return fromEnv && /^[a-zA-Z0-9]{16,}$/.test(fromEnv) ? fromEnv : null;
}

function matchClientId(text: string): string | null {
  const patterns = [
    /client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/,
    /client_id=["']([a-zA-Z0-9]{32})["']/,
    /"clientId"\s*:\s*"([a-zA-Z0-9]{32})"/,
    /client_id=([a-zA-Z0-9]{32})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function scrapeClientIdFromScripts(signal?: AbortSignal): Promise<string | null> {
  const res = await fetch("https://soundcloud.com/", {
    signal,
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const fromHtml = matchClientId(html);
  if (fromHtml) return fromHtml;

  const scriptUrls = [
    ...html.matchAll(
      /src=["'](https:\/\/[^"']*sndcdn\.com\/assets\/[^"']+\.js)["']/gi,
    ),
  ]
    .map((m) => m[1])
    .filter((u): u is string => Boolean(u))
    .slice(0, 8);

  for (const src of scriptUrls) {
    try {
      const jsRes = await fetch(src, {
        signal,
        headers: { "User-Agent": UA },
      });
      if (!jsRes.ok) continue;
      const js = await jsRes.text();
      const id = matchClientId(js);
      if (id) return id;
    } catch {
      /* try next script */
    }
  }
  return null;
}

/** Best-effort SoundCloud web client_id (rotates). */
export async function resolveSoundCloudClientId(
  signal?: AbortSignal,
): Promise<string> {
  const envId = clientIdFromEnv();
  if (envId) return envId;
  if (cachedClientId) return cachedClientId;

  try {
    const scraped = await scrapeClientIdFromScripts(signal);
    if (scraped) {
      cachedClientId = scraped;
      return scraped;
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_CLIENT_ID;
}

/** yt-dlp `--extractor-args` value for SoundCloud. */
export async function soundcloudExtractorArgs(
  signal?: AbortSignal,
): Promise<string> {
  const id = await resolveSoundCloudClientId(signal);
  return `soundcloud:client_id=${id}`;
}

/** Test helper — clear memoized id. */
export function resetSoundCloudClientIdCache(): void {
  cachedClientId = null;
}
