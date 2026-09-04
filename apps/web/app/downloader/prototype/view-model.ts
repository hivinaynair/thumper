/**
 * PROTOTYPE — throwaway. See ./README.md.
 *
 * Everything the downloader page owns, handed to a variant so the variant is
 * free to throw out the layout entirely. Data fetching, polling and mutations
 * all stay in page.tsx; only the rendered subtree swaps.
 */
import type { FormEvent } from "react";
import type { CookieStatus, Job, PlaylistRollup } from "../page";
import { HYPEDDIT_ORIGINAL_COPY } from "../result-copy";

export type DownloaderViewModel = {
  // Queue form
  url: string;
  setUrl: (value: string) => void;
  destination: string;
  setDestination: (value: string) => void;
  freeDownloadsOnly: boolean;
  setFreeDownloadsOnly: (value: boolean) => void;
  clubReadyOnly: boolean;
  setClubReadyOnly: (value: boolean) => void;
  busy: boolean;
  canQueue: boolean;
  gate: { ready: boolean; reason: string | null };
  createJob: (event: FormEvent) => void;
  message: string | null;
  messageTone: "ok" | "error";

  // Jobs
  jobs: Job[];
  rollups: Map<string, PlaylistRollup>;
  finishedCount: number;
  downloadableCount: number;
  retryingId: string | null;
  clearing: boolean;
  cancelJob: (id: string) => void;
  clearFinishedJobs: () => void;
  retryWithNewCookies: (id: string) => void;

  // Cookie sync
  cookies: CookieStatus | null;
  syncing: boolean;
  syncCookies: () => void;
  extensionReady: boolean;
  anyCookiesPresent: boolean;
  youtubeStale: boolean;
  failedNeedRefresh: boolean;
  cookieSyncTooOld: boolean;
};

/** "0" is the shipped design, kept in the cycle so variants are judged against it. */
export const VARIANT_KEYS = ["0", "A", "B", "C"] as const;
export type VariantKey = (typeof VARIANT_KEYS)[number];

export const VARIANT_NAMES: Record<VariantKey, string> = {
  "0": "Current — shipped design",
  A: "Console — dense table",
  B: "Focus — list + detail",
  C: "Feed — composer + timeline",
};

/**
 * The current page renders parents and their playlist children as one flat
 * stack. Every variant groups them instead, so grouping is shared plumbing
 * rather than a design decision any one variant owns.
 */
export function groupJobs(jobs: Job[]) {
  const parentOf = new Map<string, string>();
  for (const job of jobs) {
    for (const childId of job.result?.childJobIds ?? []) {
      parentOf.set(childId, job.id);
    }
  }
  const topLevel = jobs.filter((job) => !parentOf.has(job.id));
  const childrenOf = (id: string) =>
    jobs.filter((job) => parentOf.get(job.id) === id);
  return { topLevel, childrenOf, parentOf };
}

export function shortSource(job: Job): string {
  const raw = job.matchedUrl ?? job.sourceUrl;
  try {
    return new URL(raw).hostname.replace(/^www\./, "").replace(/\.com$/, "");
  } catch {
    return raw.slice(0, 24);
  }
}

/**
 * Every job carries a quality verdict — playlist children included, which is
 * where it matters most, since that's the list you scan for the bad ones.
 *
 * Derivation is shared so all three variants agree on *what* the verdict is;
 * each renders it differently. `lead` is for dense UI, `detail` for roomy UI.
 */
export type VerdictTier =
  | "original"
  | "master"
  | "club"
  | "marginal"
  | "unsuitable"
  | "pending";

export type Verdict = { tier: VerdictTier; lead: string; detail: string | null };

export function verdictOf(job: Job): Verdict {
  const r = job.result;
  if (job.error) {
    return { tier: "unsuitable", lead: "failed", detail: job.error };
  }
  if (r?.qualityRejected) {
    return {
      tier: "unsuitable",
      lead: "rejected",
      detail: "Audio stops short of 19 kHz — a lossy stream, whatever the file says it is.",
    };
  }
  if (r?.manualDownloadUrl) {
    return {
      tier: "unsuitable",
      lead: "manual",
      detail:
        "A stream or store page, not a file gate. Open it, download by hand, then use Retag to tag it.",
    };
  }
  if (r?.hypedditOriginal) {
    return { tier: "original", lead: "original", detail: HYPEDDIT_ORIGINAL_COPY };
  }
  if (r?.soundcloudOriginal) {
    return {
      tier: "original",
      lead: "original",
      detail: "Free download from the artist's own upload, not a stream.",
    };
  }
  if (r?.djTier) {
    return { tier: r.djTier, lead: r.djTier, detail: r.djHeadline ?? null };
  }
  if (r?.qualityLabel) {
    return { tier: "club", lead: r.qualityLabel, detail: null };
  }
  return { tier: "pending", lead: job.stage, detail: null };
}
