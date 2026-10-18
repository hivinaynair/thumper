export type CookieStatusMap = Record<
  "youtube" | "soundcloud",
  { present: boolean; updatedAt: string | null; premium?: boolean | null }
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
  /bot check|stale cookies|no playable formats|Sign in to confirm|Re-sync|Sync YouTube cookies|refresh SoundCloud cookies/i;

export function cookieNeedsRefresh(error: string | null | undefined): boolean {
  if (!error) return false;
  return COOKIE_REFRESH_RE.test(error);
}

export function cookieProvidersNeeded(error: string): Array<"youtube" | "soundcloud"> {
  if (/refresh SoundCloud cookies|Sync SoundCloud cookies/i.test(error)) {
    return ["soundcloud"];
  }
  return ["youtube"];
}

export function jobsToRetry(target: RetryableJob, allJobs: RetryableJob[]): RetryableJob[] {
  const childIds = Array.isArray(target.result?.childJobIds)
    ? target.result.childJobIds.filter((id) => typeof id === "string")
    : [];
  const byId = new Map(allJobs.map((row) => [row.id, row]));
  const children = childIds
    .map((id) => byId.get(id))
    .filter((row): row is RetryableJob => Boolean(row));

  // Every failure is retryable now: some causes will fail again the same way,
  // but which ones are worth re-running is the user's call, not a regex's.
  const failed = (rows: RetryableJob[]) => rows.filter((row) => row.status === "failed");

  if (children.length > 0) return failed(children);
  return failed([target]);
}

const PROVIDER_LABELS: Record<"youtube" | "soundcloud", string> = {
  youtube: "YouTube",
  soundcloud: "SoundCloud",
};

export type CookieSplit = {
  ready: RetryableJob[];
  blocked: RetryableJob[];
  /** Why the blocked ones were held back; null when none were. */
  reason: string | null;
};

/**
 * Split a retry batch by whether each job's failure needs a cookie the user
 * has not synced. Refusing the whole batch — which is what this replaced —
 * means one stale YouTube session blocks the rate-limited tracks beside it,
 * which would have gone through fine.
 */
export function splitByCookieReadiness(
  targets: RetryableJob[],
  cookies: CookieStatusMap | null,
): CookieSplit {
  const ready: RetryableJob[] = [];
  const blocked: RetryableJob[] = [];
  const missing = new Set<"youtube" | "soundcloud">();

  for (const target of targets) {
    const needed = cookieNeedsRefresh(target.error)
      ? cookieProvidersNeeded(target.error ?? "")
      : [];
    const unmet = needed.filter((provider) => !cookies?.[provider]?.present);
    if (unmet.length === 0) {
      ready.push(target);
      continue;
    }
    blocked.push(target);
    for (const provider of unmet) missing.add(provider);
  }

  const names = [...missing].map((provider) => PROVIDER_LABELS[provider]);
  return {
    ready,
    blocked,
    reason:
      names.length === 0
        ? null
        : `Sync ${names.join(" and ")} cookies to retry ${blocked.length} more`,
  };
}

export function retryButtonLabel(count: number): string {
  if (count <= 1) return "Retry";
  return `Retry ${count} failed`;
}
