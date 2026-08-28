export type CookieStatusMap = Record<
  "youtube" | "soundcloud" | "spotify" | "instagram",
  { present: boolean; updatedAt: string | null }
>;

export type RetryableJob = {
  id: string;
  status: string;
  error?: string | null;
  result?: {
    playlist?: boolean;
    childJobIds?: string[];
  } | null;
};

const COOKIE_REFRESH_RE =
  /bot check|stale cookies|no playable formats|Sign in to confirm|Re-sync|Sync YouTube cookies|refresh (Spotify|Instagram|SoundCloud) cookies/i;

export function cookieNeedsRefresh(error: string | null | undefined): boolean {
  if (!error) return false;
  return COOKIE_REFRESH_RE.test(error);
}

export function cookieProvidersNeeded(
  error: string,
): Array<"youtube" | "soundcloud" | "spotify" | "instagram"> {
  if (/refresh Instagram cookies/i.test(error)) return ["instagram"];
  if (/refresh Spotify cookies/i.test(error)) return ["spotify"];
  if (/refresh SoundCloud cookies|Sync SoundCloud cookies/i.test(error)) {
    return ["soundcloud"];
  }
  return ["youtube"];
}

export function jobsToRetry(
  target: RetryableJob,
  allJobs: RetryableJob[],
): RetryableJob[] {
  const childIds = Array.isArray(target.result?.childJobIds)
    ? target.result.childJobIds.filter((id) => typeof id === "string")
    : [];
  const byId = new Map(allJobs.map((row) => [row.id, row]));
  const children = childIds
    .map((id) => byId.get(id))
    .filter((row): row is RetryableJob => Boolean(row));

  const cookieFailed = (rows: RetryableJob[]) =>
    rows.filter(
      (row) => row.status === "failed" && cookieNeedsRefresh(row.error),
    );

  if (children.length > 0) return cookieFailed(children);
  return cookieFailed([target]);
}

export function missingCookiesForRetry(
  targets: RetryableJob[],
  cookies: CookieStatusMap | null,
): string | null {
  if (!cookies) return "Sync cookies before retrying";
  const needed = new Set<"youtube" | "soundcloud" | "spotify" | "instagram">();
  for (const target of targets) {
    if (!target.error) continue;
    for (const provider of cookieProvidersNeeded(target.error)) {
      needed.add(provider);
    }
  }
  const labels: Record<string, string> = {
    youtube: "YouTube",
    soundcloud: "SoundCloud",
    spotify: "Spotify",
    instagram: "Instagram",
  };
  for (const provider of needed) {
    if (!cookies[provider]?.present) {
      return `Sync ${labels[provider]} cookies before retrying`;
    }
  }
  return null;
}

export function retryButtonLabel(count: number): string {
  if (count <= 1) return "Retry with new cookies";
  return `Retry ${count} with new cookies`;
}
