import type { CookieStatusMap } from "./cookie-retry";

export type CookieProviderKey = keyof CookieStatusMap;

export type CookieSetupInput = {
  /** Version the extension announced, or null when it never answered. */
  extensionVersion: string | null;
  expectedVersion: string;
  cookies: CookieStatusMap | null;
  /** Providers the last sync skipped because the browser wasn't signed in. */
  skipped: CookieProviderKey[];
  youtubeStale: boolean;
  failedNeedRefresh: boolean;
};

export type CookieSetupState =
  | { step: "install" }
  | { step: "update"; installed: string }
  | { step: "signin"; providers: CookieProviderKey[] }
  | { step: "sync" }
  | { step: "refresh"; reason: "stale" | "failed" }
  | { step: "ready" };

/**
 * The single next action a user should take to get downloads working.
 *
 * Ordered most-blocking first: there is no point telling someone their session
 * is stale when the extension that refreshes it isn't installed. Only one step
 * is ever shown, so the panel stays a single instruction rather than a list of
 * everything that happens to be wrong.
 */
export function cookieSetupState(input: CookieSetupInput): CookieSetupState {
  if (!input.extensionVersion) return { step: "install" };
  if (input.extensionVersion !== input.expectedVersion) {
    return { step: "update", installed: input.extensionVersion };
  }
  if (input.skipped.length > 0) {
    return { step: "signin", providers: input.skipped };
  }
  // Null means the status request hasn't landed yet — don't flash "sync me" at
  // someone who is already synced.
  if (input.cookies) {
    const anyPresent = Object.values(input.cookies).some((c) => c.present);
    if (!anyPresent) return { step: "sync" };
  }
  if (input.failedNeedRefresh) return { step: "refresh", reason: "failed" };
  if (input.youtubeStale) return { step: "refresh", reason: "stale" };
  return { step: "ready" };
}
