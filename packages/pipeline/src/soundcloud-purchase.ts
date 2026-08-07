import fs from "node:fs/promises";
import { resolveSoundCloudClientId } from "./soundcloud-client";

export { resolveSoundCloudClientId } from "./soundcloud-client";

export type SoundCloudPurchaseKind = "hypeddit" | "other" | "none";

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

export function classifySoundCloudPurchaseUrl(
  url: string,
): "hypeddit" | "other" {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host === "hypeddit.com" || host.endsWith(".hypeddit.com")) {
      return "hypeddit";
    }
  } catch {
    /* treat unparseable as other store link */
  }
  return "other";
}

/**
 * Resolve a SoundCloud track's Free Download / Buy link (`purchase_url`).
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
  const resolveUrl = new URL("https://api-v2.soundcloud.com/resolve");
  resolveUrl.searchParams.set("url", trackUrl);
  resolveUrl.searchParams.set("client_id", clientId);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };
  if (oauth) headers.Authorization = `OAuth ${oauth}`;

  const res = await fetch(resolveUrl, { headers, signal });
  if (!res.ok) return { kind: "none" };

  const data = (await res.json()) as {
    purchase_url?: string | null;
    purchase_title?: string | null;
  };
  const purchaseUrl = data.purchase_url?.trim();
  if (!purchaseUrl) return { kind: "none" };

  const kind = classifySoundCloudPurchaseUrl(purchaseUrl);
  return {
    kind,
    url: purchaseUrl,
    title: data.purchase_title ?? null,
  };
}

export class ManualDownloadRequiredError extends Error {
  readonly manualDownloadUrl: string;
  readonly purchaseTitle: string | null;

  constructor(url: string, purchaseTitle?: string | null) {
    super(
      `Manual download required (not Hypeddit): ${url}${
        purchaseTitle ? ` (${purchaseTitle})` : ""
      }. Download it yourself, then use WAV → AIFF to tag.`,
    );
    this.name = "ManualDownloadRequiredError";
    this.manualDownloadUrl = url;
    this.purchaseTitle = purchaseTitle ?? null;
  }
}

export function isManualDownloadRequiredError(
  err: unknown,
): err is ManualDownloadRequiredError {
  return err instanceof ManualDownloadRequiredError;
}
