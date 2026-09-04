/**
 * Pure view logic for the downloader queue: what a job is called, how a
 * playlist's children roll up, and what verdict the job carries.
 *
 * Kept out of page.tsx so it can be tested without a browser.
 */
import { trackDisplayName } from "@thumper/shared";
import { HYPEDDIT_ORIGINAL_COPY } from "./result-copy";

export type DjTier = "master" | "club" | "marginal" | "unsuitable";

export type Job = {
  id: string;
  status: string;
  stage: string;
  progress: number;
  sourceUrl: string;
  matchedUrl?: string | null;
  title?: string | null;
  artist?: string | null;
  audioFormat: string;
  destination: string;
  error?: string | null;
  result?: {
    fileId?: string;
    driveUrl?: string;
    qualityLabel?: string;
    playlist?: boolean;
    trackCount?: number;
    childJobIds?: string[];
    unmatchedCount?: number;
    matchScore?: number;
    djTier?: DjTier;
    djHeadline?: string;
    warnings?: string[];
    cutoffHz?: number;
    sourceFormatId?: string;
    /** SoundCloud free-download / original upload (`format_id=download`). */
    soundcloudOriginal?: boolean;
    /** Hypeddit artist original; WAV is tagged FLAC, other formats unchanged. */
    hypedditOriginal?: boolean;
    /** Non-Hypeddit purchase link — open and download manually. */
    manualDownloadUrl?: string;
    manualDownloadTitle?: string | null;
    freeDownloadsOnly?: boolean;
    clubReadyOnly?: boolean;
    qualityRejected?: boolean;
  } | null;
};

export type CookieProviderStatus = {
  present: boolean;
  updatedAt: string | null;
};

export type CookieStatus = {
  youtube: CookieProviderStatus;
  soundcloud: CookieProviderStatus;
  spotify: CookieProviderStatus;
};

export type PlaylistRollup = {
  total: number;
  done: number;
  failed: number;
  pending: number;
  failedTracks: Job[];
};

export function jobLabel(job: Job): string {
  if (job.title || job.artist) return trackDisplayName(job.artist, job.title);
  return job.sourceUrl;
}

/**
 * A playlist parent finishes as soon as its tracks are queued, so the only
 * honest progress report is the live state of its children.
 */
export function playlistRollup(
  job: Job,
  byId: Map<string, Job>,
): PlaylistRollup | null {
  if (!job.result?.playlist) return null;
  const children = (job.result.childJobIds ?? [])
    .map((id) => byId.get(id))
    .filter((child): child is Job => Boolean(child));
  if (children.length === 0) return null;

  const failedTracks = children.filter(
    (child) => child.status === "failed" || child.status === "cancelled",
  );
  const done = children.filter((child) => child.status === "completed").length;
  return {
    total: children.length,
    done,
    failed: failedTracks.length,
    pending: children.length - done - failedTracks.length,
    failedTracks,
  };
}

export function rollupSummary(rollup: PlaylistRollup): string {
  const parts = [`${rollup.done}/${rollup.total} downloaded`];
  if (rollup.failed) parts.push(`${rollup.failed} failed`);
  if (rollup.pending) parts.push(`${rollup.pending} in progress`);
  return parts.join(" · ");
}

/**
 * Split the flat job list into parents and their playlist children.
 *
 * The queue arrives flat, so a 30-track playlist would otherwise render as 31
 * sibling entries with the relationship expressed only as a summary string.
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

export type VerdictTier =
  | "original"
  | "master"
  | "club"
  | "marginal"
  | "unsuitable"
  | "pending";

export type Verdict = {
  tier: VerdictTier;
  /** One word, for a dense row. */
  lead: string;
  /** Full sentence, when there is room for it. */
  detail: string | null;
};

/**
 * Every job carries a verdict — playlist children included, which is where it
 * matters most, since that is the list you scan for the bad ones.
 *
 * Order is deliberate and lossy: an outright failure outranks a quality
 * rejection, which outranks a provenance win. A track that is both an artist
 * original and marginal-quality reports "original" — provenance is treated as
 * the stronger signal, because the file came from the artist rather than a
 * re-encode.
 */
export function verdictOf(job: Job): Verdict {
  const result = job.result;
  if (job.error) {
    return { tier: "unsuitable", lead: "failed", detail: job.error };
  }
  if (result?.qualityRejected) {
    return {
      tier: "unsuitable",
      lead: "rejected",
      detail:
        "Audio stops short of 19 kHz — a lossy stream, whatever the file says it is.",
    };
  }
  if (result?.manualDownloadUrl) {
    return {
      tier: "unsuitable",
      lead: "manual",
      detail:
        "A stream or store page, not a file gate. Open it, download by hand, then use Retag to tag it.",
    };
  }
  if (result?.hypedditOriginal) {
    return {
      tier: "original",
      lead: "original",
      detail: HYPEDDIT_ORIGINAL_COPY,
    };
  }
  if (result?.soundcloudOriginal) {
    return {
      tier: "original",
      lead: "original",
      detail: "Free download from the artist's own upload, not a stream.",
    };
  }
  if (result?.djTier) {
    return { tier: result.djTier, lead: result.djTier, detail: result.djHeadline ?? null };
  }
  if (result?.qualityLabel) {
    return { tier: "club", lead: result.qualityLabel, detail: null };
  }
  return { tier: "pending", lead: job.stage, detail: null };
}
