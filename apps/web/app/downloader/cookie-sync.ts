/** First Cookie Sync version that opens Instagram and uploads those cookies. */
export const COOKIE_SYNC_MIN_VERSION = "0.5.0";
export const COOKIE_SYNC_EXTENSION_VERSION = "0.5.1";

export const COOKIE_SYNC_RELOAD_MESSAGE =
  `This Cookie Sync build never opens Instagram. Download v${COOKIE_SYNC_EXTENSION_VERSION}, Reload it on chrome://extensions, then refresh this page.`;

function versionParts(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".").map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

export function isCookieSyncTooOld(
  version: string | null | undefined,
): boolean {
  if (version == null || version === "") return true;
  const [major, minor] = versionParts(version);
  if (major > 0) return false;
  return minor < 5;
}

export function cookieSyncMissingInstagram(result: {
  results?: { instagram?: unknown };
}): boolean {
  return Boolean(result.results && result.results.instagram === undefined);
}
