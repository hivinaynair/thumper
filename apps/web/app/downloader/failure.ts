/**
 * Why a download failed, in words, and what to do about it.
 *
 * Classifies the sentence the pipeline already wrote to `jobs.error` rather
 * than reading an error-code column, because those sentences are written as
 * user-facing copy and because jobs that failed before this shipped still
 * carry them — a column would leave every one of them unexplained.
 *
 * `failure.test.ts` pins the regexes to the literal strings thrown in
 * `packages/pipeline`. Change the copy there and the test fails here, which
 * is the only thing keeping this from rotting into `unknown` for everything.
 */
import type { Job } from "./job-view";

export type FailureCode =
  | "youtube-bot-check"
  | "youtube-no-formats"
  | "soundcloud-preview"
  | "soundcloud-session"
  | "no-mirror"
  | "quality-gate"
  | "manual-download"
  | "rate-limited"
  | "drive"
  | "playlist-unreadable"
  | "unknown";

export type Failure = {
  code: FailureCode;
  /** Short enough to sit in a dense track row. */
  headline: string;
  /** The one line worth reading; the raw error when nothing shorter will do. */
  detail: string;
  /** Verbatim `jobs.error`, for the expanded view. */
  raw: string;
};

type Rule = {
  code: FailureCode;
  test: RegExp;
  headline: string;
  /** Null where the pipeline's own sentence is already the best next step. */
  hint: string | null;
};

/**
 * Order is load-bearing. A SoundCloud track that is preview-only *and* has no
 * YouTube mirror reports one error containing both phrases; "Preview only" is
 * the honest headline, because the track was found and the stream was the
 * problem, so that rule has to win over `no-mirror`.
 */
const RULES: Rule[] = [
  {
    code: "youtube-bot-check",
    test: /bot check/i,
    headline: "YouTube bot check",
    hint: "Re-sync YouTube cookies from a signed-in browser, then retry.",
  },
  {
    code: "youtube-no-formats",
    test: /no playable formats|Authenticated YouTube audio is unavailable|did not report a real format id/i,
    headline: "No playable YouTube audio",
    hint: "Cookies may be stale, or the track is DRM-locked. Re-sync and retry.",
  },
  {
    code: "soundcloud-session",
    test: /refresh SoundCloud cookies|SoundCloud session is no longer usable/i,
    headline: "SoundCloud session expired",
    hint: "Re-sync SoundCloud cookies, then retry.",
  },
  {
    code: "soundcloud-preview",
    test: /preview-only|only has a preview|has no full stream/i,
    headline: "Preview only",
    hint: "Geo-blocked or Go+. If the artist offers a free download, grab it and use Retag.",
  },
  {
    code: "no-mirror",
    test: /no confident (YouTube )?mirror|No YouTube mirror to fall back on/i,
    headline: "No match found",
    hint: "Queue the YouTube or SoundCloud link directly.",
  },
  {
    code: "rate-limited",
    test: /HTTP Error 429|Too Many Requests|rate[_ ]?limit/i,
    headline: "Rate limited",
    hint: "The source throttled us. Wait a minute, then retry.",
  },
  {
    code: "drive",
    test: /drive\.file|Drive upload|Google token/i,
    headline: "Google Drive",
    hint: "Reconnect Google from your account menu, then retry.",
  },
  {
    code: "playlist-unreadable",
    test: /returned no track list|Could not read this playlist|Could not read Spotify catalog/i,
    headline: "Playlist unreadable",
    hint: "Retry in a minute, or queue the tracks individually.",
  },
];

const NO_REASON = "No reason recorded.";

function build(code: FailureCode, headline: string, hint: string | null, raw: string): Failure {
  return { code, headline, detail: hint ?? raw, raw };
}

/**
 * Null for anything that has not failed — a cancelled job is a decision, not
 * a fault, and nothing useful can be said about it.
 */
export function classifyFailure(job: Job): Failure | null {
  if (job.status !== "failed") return null;

  const raw = job.error?.trim() || NO_REASON;

  // Result flags outrank the string: the pipeline sets them on exactly the two
  // failures it can name structurally, so there is no regex to get wrong.
  if (job.result?.manualDownloadUrl) {
    return build(
      "manual-download",
      "Store or stream page",
      "Open the link, download it by hand, then tag it with Retag.",
      raw,
    );
  }
  if (job.result?.qualityRejected) {
    // No hint: the raw sentence carries the measured cutoff, which is the only
    // part that tells you whether the switch is worth turning off.
    return build("quality-gate", "Below club-ready", null, raw);
  }

  for (const rule of RULES) {
    if (rule.test.test(raw)) return build(rule.code, rule.headline, rule.hint, raw);
  }

  return build("unknown", "Download failed", null, raw);
}
