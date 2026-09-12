export const COOKIE_STALE_MS = 12 * 60 * 60 * 1000;

export function isCookieStale(iso: string | null, now = Date.now()): boolean {
  if (!iso) return false;
  const ms = now - new Date(iso).getTime();
  return Number.isFinite(ms) && ms >= COOKIE_STALE_MS;
}

export function shouldRefreshCookiesBeforeQueue(input: {
  youtubePresent: boolean;
  youtubeUpdatedAt: string | null;
  extensionReady: boolean;
  now?: number;
}): boolean {
  return (
    input.extensionReady &&
    input.youtubePresent &&
    isCookieStale(input.youtubeUpdatedAt, input.now ?? Date.now())
  );
}
