import fs from "node:fs/promises";
import { resolveSoundCloudClientId } from "./soundcloud-client";

export { resolveSoundCloudClientId } from "./soundcloud-client";

export type SoundCloudPurchaseKind = "stream" | "other" | "none";

export type SoundCloudPurchase = {
  kind: SoundCloudPurchaseKind;
  url?: string;
  title?: string | null;
};

function oauthTokenFromNetscape(cookieText: string): string | null {
  for (const line of cookieText.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length >= 7 && parts[5] === "oauth_token" && parts[6]) {
      return parts[6];
    }
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(host: string, names: readonly string[]): boolean {
  return names.some((name) => host === name || host.endsWith(`.${name}`));
}

/**
 * Only `purchase_url` counts. Description links are ordinary artist links —
 * socials, merch, other releases — and treating one as this track's download
 * source would fail the job over something unrelated to it.
 */
export function pickPreferredSoundCloudPurchase(params: {
  purchaseUrl?: string | null;
  purchaseTitle?: string | null;
}): SoundCloudPurchase {
  const purchaseUrl = params.purchaseUrl?.trim();
  if (!purchaseUrl) return { kind: "none" };
  return {
    kind: classifySoundCloudPurchaseUrl(purchaseUrl),
    url: purchaseUrl,
    title: params.purchaseTitle ?? null,
  };
}

const STREAM_HOSTS = [
  "ffm.to",
  "feature.fm",
  "fanlink.to",
  "fanlink.tv",
  "smarturl.it",
  "lnk.to",
  "listen.ukf.com",
  "monster.cat",
  "outnow.io",
  "found.ee",
  "orcd.co",
] as const;

export function classifySoundCloudPurchaseUrl(
  url: string,
): Exclude<SoundCloudPurchaseKind, "none"> {
  const host = hostOf(url);
  if (!host) return "other";
  if (hostMatches(host, STREAM_HOSTS)) return "stream";
  return "other";
}

export function soundCloudPurchaseApiUrl(trackUrl: string, clientId: string): URL {
  const id = trackUrl.match(/^https?:\/\/api(?:-v2)?\.soundcloud\.com\/tracks\/(\d+)/i)?.[1];
  if (id) {
    const direct = new URL(`https://api-v2.soundcloud.com/tracks/${id}`);
    direct.searchParams.set("client_id", clientId);
    return direct;
  }
  const resolveUrl = new URL("https://api-v2.soundcloud.com/resolve");
  resolveUrl.searchParams.set("url", trackUrl);
  resolveUrl.searchParams.set("client_id", clientId);
  return resolveUrl;
}

/**
 * Resolve a SoundCloud track's Buy link (`purchase_url`).
 * Requires a Netscape cookie jar that includes `oauth_token` for reliable API access.
 */
export async function resolveSoundCloudPurchase(params: {
  trackUrl: string;
  cookiePath: string | null;
  signal?: AbortSignal;
}): Promise<SoundCloudPurchase> {
  const { trackUrl, cookiePath, signal } = params;
  if (!cookiePath) return { kind: "none" };

  let cookieText: string;
  try {
    cookieText = await fs.readFile(cookiePath, "utf8");
  } catch {
    return { kind: "none" };
  }

  const oauth = oauthTokenFromNetscape(cookieText);
  const clientId = await resolveSoundCloudClientId(signal);
  const requestUrl = soundCloudPurchaseApiUrl(trackUrl, clientId);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };
  if (oauth) headers.Authorization = `OAuth ${oauth}`;

  const res = await fetch(requestUrl, { headers, signal });
  if (!res.ok) return { kind: "none" };

  const data = (await res.json()) as {
    purchase_url?: string | null;
    purchase_title?: string | null;
  };
  return pickPreferredSoundCloudPurchase({
    purchaseUrl: data.purchase_url,
    purchaseTitle: data.purchase_title,
  });
}

export class ManualDownloadRequiredError extends Error {
  readonly manualDownloadUrl: string;
  readonly purchaseTitle: string | null;

  constructor(url: string, purchaseTitle?: string | null) {
    super(
      `Manual download required: ${url}${
        purchaseTitle ? ` (${purchaseTitle})` : ""
      }. This link is a stream or store page, not a file. Download it yourself, then upload it on Retag.`,
    );
    this.name = "ManualDownloadRequiredError";
    this.manualDownloadUrl = url;
    this.purchaseTitle = purchaseTitle ?? null;
  }
}

export function isManualDownloadRequiredError(err: unknown): err is ManualDownloadRequiredError {
  return err instanceof ManualDownloadRequiredError;
}
