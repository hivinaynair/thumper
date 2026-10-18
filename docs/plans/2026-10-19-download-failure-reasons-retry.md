# Download failure reasons and retry — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every failed download in the queue says why it failed, in words, and any failure can be re-run — one track or the whole batch.

**Architecture:** A pure classifier in the web app turns the string already stored in `jobs.error` into a short headline plus a next step; the downloader renders it inline under each failed track and expands to the raw text on click. `jobsToRetry` drops its cookie-only filter so every failed job is retryable, and the existing `POST /api/jobs/[id]/retry` route gains partial cookie gating so a mixed batch is not blocked wholesale. No database migration.

**Tech Stack:** Next.js 16 (App Router, RSC + client components), React 19, Drizzle ORM on Postgres, pg-boss or Modal for the worker, Bun's built-in test runner (`bun:test`), Biome for lint/format, Tailwind v4 with CSS custom properties.

**Background reading before you start:**
- `docs/plans/2026-10-19-download-failure-reasons-retry-design.md` — the approved design and why the classifier reads strings rather than an error-code column.
- `apps/web/app/downloader/job-view.ts` — the existing pure view layer. `verdictOf` owns the one-word tier badge; your classifier owns the explanation. Do not merge them.
- `apps/web/lib/cookie-retry.ts` and `apps/web/lib/retry-job.ts` — the retry helpers.
- `apps/web/app/api/jobs/[id]/retry/route.ts` — the route. It already handles Drive folder context, pg-boss vs Modal, and concurrency-limited waking. Do not rewrite it.

**Conventions you will be held to:**
- Tests are `bun:test` (`import { describe, expect, it } from "bun:test"`) and live next to the file they test, named `<name>.test.ts`.
- Run a single package's tests with `bun test` from inside `apps/web`. Run everything with `bun run test` from the repo root.
- Comments in this codebase explain *why*, never *what*. Read a few in `job-view.ts` before writing any. A comment restating the code will be rejected.
- Commit after each task. Prefix nothing — this repo's commit subjects are plain sentences ending in a period.

---

## Task 1: Failure classifier

Turn `jobs.error` into `{ code, headline, detail, raw }`.

**Files:**
- Create: `apps/web/app/downloader/failure.ts`
- Create: `apps/web/app/downloader/failure.test.ts`

**Step 1: Write the failing test**

Create `apps/web/app/downloader/failure.test.ts`. The strings below are copied verbatim out of `packages/pipeline/src/download.ts`, `run-job.ts`, `audio-verify.ts`, `soundcloud-purchase.ts` and `packages/shared/src/index.ts`. That is the point of the test: if someone edits the pipeline copy and a regex stops matching, this fails instead of silently degrading every row to `unknown`.

```ts
import { describe, expect, it } from "bun:test";
import { classifyFailure } from "./failure";
import type { Job } from "./job-view";

function job(partial: Partial<Job> & Pick<Job, "id">): Job {
  return {
    status: "failed",
    stage: "error",
    progress: 0,
    sourceUrl: `https://example.com/${partial.id}`,
    audioFormat: "flac",
    destination: "browser",
    error: null,
    result: null,
    ...partial,
  };
}

function codeFor(error: string, result: Job["result"] = null): string | undefined {
  return classifyFailure(job({ id: "t", error, result }))?.code;
}

describe("classifyFailure", () => {
  it("says nothing about a job that has not failed", () => {
    expect(classifyFailure(job({ id: "t", status: "completed" }))).toBeNull();
    expect(classifyFailure(job({ id: "t", status: "running" }))).toBeNull();
    expect(classifyFailure(job({ id: "t", status: "cancelled", error: "Cancelled" }))).toBeNull();
  });

  it("falls back to the raw error rather than inventing friendly copy", () => {
    const failure = classifyFailure(job({ id: "t", error: "ffmpeg exited with code 1" }));
    expect(failure).toEqual({
      code: "unknown",
      headline: "Download failed",
      detail: "ffmpeg exited with code 1",
      raw: "ffmpeg exited with code 1",
    });
  });

  it("handles a failed job with no error string at all", () => {
    const failure = classifyFailure(job({ id: "t", error: null }));
    expect(failure?.code).toBe("unknown");
    expect(failure?.detail).toBe("No reason recorded.");
  });
});

describe("classifyFailure — pipeline strings", () => {
  it("reads YouTube bot checks, cookies or not", () => {
    expect(
      codeFor(
        "YouTube blocked this download (bot check), even with your synced cookies. Re-sync fresh YouTube cookies from a signed-in browser and retry.",
      ),
    ).toBe("youtube-bot-check");
    expect(
      codeFor(
        "YouTube blocked this download (bot check). Sync YouTube cookies from a signed-in browser, then retry.",
      ),
    ).toBe("youtube-bot-check");
  });

  it("reads the three ways YouTube reports no usable audio", () => {
    expect(
      codeFor(
        "YouTube returned no playable formats. Sync YouTube cookies from a signed-in browser and retry.",
      ),
    ).toBe("youtube-no-formats");
    expect(
      codeFor(
        "Authenticated YouTube audio is unavailable (cookies may be stale, or this client is DRM-locked). Re-sync fresh YouTube cookies from a signed-in browser and retry.",
      ),
    ).toBe("youtube-no-formats");
    expect(
      codeFor(
        "YouTube quality verification failed: yt-dlp did not report a real format id, audio codec, and positive audio bitrate.",
      ),
    ).toBe("youtube-no-formats");
  });

  it("reads an expired SoundCloud session", () => {
    expect(
      codeFor("SoundCloud session is no longer usable — refresh SoundCloud cookies and retry."),
    ).toBe("soundcloud-session");
  });

  it("reads preview-only SoundCloud streams", () => {
    expect(
      codeFor(
        "SoundCloud has no full stream (preview-only, geo-blocked, or DRM). Falling back to YouTube when possible.",
      ),
    ).toBe("soundcloud-preview");
    expect(codeFor("SoundCloud returned a preview-only stream. Falling back to YouTube when possible.")).toBe(
      "soundcloud-preview",
    );
  });

  it("blames the preview, not the missing mirror, when both are true", () => {
    expect(
      codeFor(
        "SoundCloud only has a preview (often geo-blocked or Go+) and no confident YouTube mirror found for “Pearson Sound – Untitled”",
      ),
    ).toBe("soundcloud-preview");
  });

  it("reads a Spotify track with no mirror anywhere", () => {
    expect(codeFor("No confident mirror for “Hodge – Ghost Cassette” on YouTube/SoundCloud")).toBe(
      "no-mirror",
    );
    expect(
      codeFor(
        "No YouTube mirror to fall back on. If the artist offers a Free Download on SoundCloud, grab it there and upload it on Retag.",
      ),
    ).toBe("no-mirror");
  });

  it("reads rate limiting", () => {
    expect(codeFor("ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests")).toBe(
      "rate-limited",
    );
  });

  it("reads a missing Google Drive token", () => {
    expect(
      codeFor(
        "Google Drive selected but no Google token with drive.file — open your account menu and reconnect Google",
      ),
    ).toBe("drive");
    expect(codeFor("Drive upload returned no file id")).toBe("drive");
  });

  it("reads an unreadable playlist", () => {
    expect(
      codeFor(
        "Could not read this playlist — YouTube returned no track list. Try again in a minute, or queue the tracks individually.",
      ),
    ).toBe("playlist-unreadable");
    expect(codeFor("Could not read Spotify catalog metadata")).toBe("playlist-unreadable");
  });
});

describe("classifyFailure — result flags beat the string", () => {
  it("reads a club-ready rejection from the result flag", () => {
    const failure = classifyFailure(
      job({
        id: "t",
        error: "SoundCloud stream is not club-ready — audio stops at 16.0 kHz. Turn off Club-ready only to download it anyway.",
        result: { qualityRejected: true, cutoffHz: 16000, djTier: "marginal" },
      }),
    );
    expect(failure?.code).toBe("quality-gate");
    expect(failure?.headline).toBe("Below club-ready");
    // The measured cutoff only exists in the raw sentence, so that is the detail.
    expect(failure?.detail).toContain("16.0 kHz");
  });

  it("reads a store or stream page from the result flag", () => {
    const failure = classifyFailure(
      job({
        id: "t",
        error:
          "Manual download required: https://shop.example/track. This link is a stream or store page, not a file. Download it yourself, then upload it on Retag.",
        result: { manualDownloadUrl: "https://shop.example/track" },
      }),
    );
    expect(failure?.code).toBe("manual-download");
    expect(failure?.headline).toBe("Store or stream page");
  });
});

describe("classifyFailure — detail and raw", () => {
  it("keeps the raw text available when the hint is shorter", () => {
    const raw =
      "YouTube blocked this download (bot check), even with your synced cookies. Re-sync fresh YouTube cookies from a signed-in browser and retry.";
    const failure = classifyFailure(job({ id: "t", error: raw }));
    expect(failure?.raw).toBe(raw);
    expect(failure?.detail).not.toBe(raw);
  });

  it("makes detail and raw identical when there is nothing shorter to say", () => {
    const failure = classifyFailure(job({ id: "t", error: "ffmpeg exited with code 1" }));
    expect(failure?.detail).toBe(failure?.raw);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun test app/downloader/failure.test.ts
```

Expected: fails to resolve `./failure`.

**Step 3: Write the implementation**

Create `apps/web/app/downloader/failure.ts`:

```ts
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
 * YouTube mirror reports one error containing both phrases; "Preview only"
 * is the honest headline, because the track was found and the stream was the
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

  // Result flags outrank the string: the pipeline sets them on exactly the
  // two failures it can name structurally, so there is no regex to get wrong.
  if (job.result?.manualDownloadUrl) {
    return build(
      "manual-download",
      "Store or stream page",
      "Open the link, download it by hand, then tag it with Retag.",
      raw,
    );
  }
  if (job.result?.qualityRejected) {
    // No hint: the raw sentence carries the measured cutoff, which is the
    // only part that tells you whether the switch is worth turning off.
    return build("quality-gate", "Below club-ready", null, raw);
  }

  for (const rule of RULES) {
    if (rule.test.test(raw)) return build(rule.code, rule.headline, rule.hint, raw);
  }

  return build("unknown", "Download failed", null, raw);
}
```

**Step 4: Run the test to verify it passes**

```bash
cd apps/web && bun test app/downloader/failure.test.ts
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add apps/web/app/downloader/failure.ts apps/web/app/downloader/failure.test.ts
git commit -m "Classify download failures into a headline and a next step."
```

---

## Task 2: Retry every failure, not just cookie ones

**Files:**
- Modify: `apps/web/lib/cookie-retry.ts` — `jobsToRetry`, `retryButtonLabel`
- Modify: `apps/web/lib/cookie-retry.test.ts`

`cookieNeedsRefresh` and `cookieProvidersNeeded` stay exactly as they are. They still drive the cookie-setup banner (`failedNeedRefresh` in `page.tsx`) and, after Task 3, the partial cookie gate. Only the retry filter widens.

**Step 1: Update the failing tests**

In `apps/web/lib/cookie-retry.test.ts`:

Rename the test `"retries only cookie-failed children of a still-running playlist"` to `"retries every failed child of a still-running playlist"` and change its expectation to include the quality failure:

```ts
    expect(jobsToRetry(parent, [parent, ...children]).map((row) => row.id)).toEqual([
      "fail-a",
      "fail-b",
      "quality",
    ]);
```

Replace the `retryButtonLabel` describe block with:

```ts
describe("retryButtonLabel", () => {
  it("names a single retry plainly and a batch by its size", () => {
    expect(retryButtonLabel(1)).toBe("Retry");
    expect(retryButtonLabel(11)).toBe("Retry 11 failed");
  });
});
```

Add one new test inside the `jobsToRetry` describe block, which is the per-track case the UI now depends on:

```ts
  it("retries a child posted on its own id, with no parent in the catalog", () => {
    const child = job({ id: "fail-a", error: "ffmpeg exited with code 1" });
    expect(jobsToRetry(child, [child]).map((row) => row.id)).toEqual(["fail-a"]);
  });
```

Leave `"does not retry cancelled tracks"` alone — it must keep passing.

**Step 2: Run the tests to verify they fail**

```bash
cd apps/web && bun test lib/cookie-retry.test.ts
```

Expected: three failures — the playlist case missing `"quality"`, the two label assertions, and the new non-cookie child case returning `[]`.

**Step 3: Write the implementation**

In `apps/web/lib/cookie-retry.ts`, replace the body of `jobsToRetry`'s filter and the label:

```ts
  // Every failure is retryable now: some causes will fail again the same way,
  // but which ones are worth re-running is the user's call, not a regex's.
  const failed = (rows: RetryableJob[]) => rows.filter((row) => row.status === "failed");

  if (children.length > 0) return failed(children);
  return failed([target]);
```

```ts
export function retryButtonLabel(count: number): string {
  if (count <= 1) return "Retry";
  return `Retry ${count} failed`;
}
```

Delete the now-unused local `cookieFailed`.

**Step 4: Run the tests to verify they pass**

```bash
cd apps/web && bun test lib/cookie-retry.test.ts
```

Expected: all pass.

**Step 5: Commit**

```bash
git add apps/web/lib/cookie-retry.ts apps/web/lib/cookie-retry.test.ts
git commit -m "Make every failed download retryable, not just cookie failures."
```

---

## Task 3: Partial cookie gating

Today a batch with one cookie failure and four rate-limit failures returns 400 and retries nothing. Retry what can be retried and report the rest.

**Files:**
- Modify: `apps/web/lib/cookie-retry.ts` — replace `missingCookiesForRetry` with `splitByCookieReadiness`
- Modify: `apps/web/lib/cookie-retry.test.ts`
- Modify: `apps/web/app/api/jobs/[id]/retry/route.ts`

**Step 1: Write the failing test**

Replace the whole `describe("missingCookiesForRetry", …)` block in `apps/web/lib/cookie-retry.test.ts` with:

```ts
describe("splitByCookieReadiness", () => {
  const present = {
    youtube: { present: true, updatedAt: "2026-10-18T10:00:00.000Z" },
    soundcloud: { present: true, updatedAt: null },
  };
  const noYoutube = {
    youtube: { present: false, updatedAt: null },
    soundcloud: { present: true, updatedAt: null },
  };

  it("lets everything through when the needed cookies are synced", () => {
    const failed = job({ id: "track-1", error: BOT_CHECK });
    const split = splitByCookieReadiness([failed], present);
    expect(split.ready.map((row) => row.id)).toEqual(["track-1"]);
    expect(split.blocked).toEqual([]);
    expect(split.reason).toBeNull();
  });

  it("holds back only the tracks that actually need the missing cookies", () => {
    const botCheck = job({ id: "bot", error: BOT_CHECK });
    const throttled = job({ id: "slow", error: "HTTP Error 429: Too Many Requests" });
    const split = splitByCookieReadiness([botCheck, throttled], noYoutube);
    expect(split.ready.map((row) => row.id)).toEqual(["slow"]);
    expect(split.blocked.map((row) => row.id)).toEqual(["bot"]);
    expect(split.reason).toBe("Sync YouTube cookies to retry 1 more");
  });

  it("retries non-cookie failures even with no cookie status at all", () => {
    const throttled = job({ id: "slow", error: "HTTP Error 429: Too Many Requests" });
    const split = splitByCookieReadiness([throttled], null);
    expect(split.ready.map((row) => row.id)).toEqual(["slow"]);
    expect(split.reason).toBeNull();
  });

  it("names both providers when a batch needs both", () => {
    const yt = job({ id: "yt", error: BOT_CHECK });
    const sc = job({
      id: "sc",
      error: "SoundCloud session is no longer usable — refresh SoundCloud cookies and retry.",
    });
    const split = splitByCookieReadiness([yt, sc], {
      youtube: { present: false, updatedAt: null },
      soundcloud: { present: false, updatedAt: null },
    });
    expect(split.ready).toEqual([]);
    expect(split.reason).toBe("Sync YouTube and SoundCloud cookies to retry 2 more");
  });
});
```

Update the import at the top of the file: drop `missingCookiesForRetry`, add `splitByCookieReadiness`.

**Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun test lib/cookie-retry.test.ts
```

Expected: `splitByCookieReadiness is not a function`.

**Step 3: Write the implementation**

In `apps/web/lib/cookie-retry.ts`, delete `missingCookiesForRetry` and add:

```ts
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
    reason: names.length === 0 ? null : `Sync ${names.join(" and ")} cookies to retry ${blocked.length} more`,
  };
}
```

Then in `apps/web/app/api/jobs/[id]/retry/route.ts`, swap the import `missingCookiesForRetry` for `splitByCookieReadiness` and replace this block:

```ts
  const cookies = await getCookieStatus(userId);
  const missing = missingCookiesForRetry(targets, cookies);
  if (missing) {
    return NextResponse.json({ error: missing }, { status: 400 });
  }

  const targetIds = targets.map((row) => row.id);
```

with:

```ts
  const cookies = await getCookieStatus(userId);
  const { ready, blocked, reason } = splitByCookieReadiness(targets, cookies);
  if (ready.length === 0) {
    return NextResponse.json({ error: reason ?? "Nothing to retry" }, { status: 400 });
  }

  const targetIds = ready.map((row) => row.id);
```

and change the success response at the bottom of the file to carry the skip:

```ts
  return NextResponse.json({
    ok: true,
    retried: woken,
    failedToWake: failures,
    skipped: blocked.length,
    skippedReason: blocked.length > 0 ? reason : null,
  });
```

**Step 4: Run the tests to verify they pass**

```bash
cd apps/web && bun test lib/cookie-retry.test.ts
```

Expected: all pass. The `"requeues from the retry route using the shared helpers"` test asserts `route).toContain("missingCookiesForRetry")` — update that string to `"splitByCookieReadiness"` and it should pass too.

**Step 5: Commit**

```bash
git add apps/web/lib/cookie-retry.ts apps/web/lib/cookie-retry.test.ts "apps/web/app/api/jobs/[id]/retry/route.ts"
git commit -m "Retry what can be retried instead of refusing a mixed batch."
```

---

## Task 4: Clear stale failure flags on requeue

`requeueFields()` clears `error` but not `result`, so a requeued job keeps `qualityRejected` / `manualDownloadUrl` / `djTier` and renders a stale "Open link" button while it sits in the queue.

**Files:**
- Modify: `apps/web/lib/retry-job.ts`
- Modify: `apps/web/lib/retry-job.test.ts`
- Modify: `apps/web/app/api/jobs/[id]/retry/route.ts`

**Step 1: Write the failing test**

Add to `apps/web/lib/retry-job.test.ts`:

```ts
describe("clearedFailureResult", () => {
  it("drops what the failure wrote and keeps what the retry needs", () => {
    expect(
      clearedFailureResult({
        parentJobId: "uk-140",
        driveFolderId: "folder-uk-140",
        clubReadyOnly: true,
        qualityRejected: true,
        djTier: "marginal",
        djHeadline: "Rolls off at 16 kHz",
        cutoffHz: 16000,
        manualDownloadUrl: "https://shop.example/track",
        manualDownloadTitle: "Buy on Bandcamp",
        warnings: ["Downloaded without your account"],
      }),
    ).toEqual({
      parentJobId: "uk-140",
      driveFolderId: "folder-uk-140",
      clubReadyOnly: true,
    });
  });

  it("leaves a job that never had a result alone", () => {
    expect(clearedFailureResult(null)).toBeNull();
  });
});
```

Add `clearedFailureResult` to the import at the top of that file.

**Step 2: Run the test to verify it fails**

```bash
cd apps/web && bun test lib/retry-job.test.ts
```

Expected: `clearedFailureResult is not a function`.

**Step 3: Write the implementation**

In `apps/web/lib/retry-job.ts`:

```ts
/**
 * Keys a *failure* wrote. Everything else in `result` — the playlist wiring
 * and the club-ready switch — is what the retry needs to run the same job
 * again, so it survives.
 */
const FAILURE_RESULT_KEYS = [
  "qualityRejected",
  "djTier",
  "djHeadline",
  "cutoffHz",
  "manualDownloadUrl",
  "manualDownloadTitle",
  "warnings",
] as const;

/**
 * Without this a requeued job shows its old "Open link" button and rejection
 * badge for as long as it sits in the queue, because `result` is replaced
 * only once the new run reaches a write.
 */
export function clearedFailureResult(
  result: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!result) return null;
  const next = { ...result };
  for (const key of FAILURE_RESULT_KEYS) delete next[key];
  return next;
}
```

Then wire it into `apps/web/app/api/jobs/[id]/retry/route.ts`. **Delete** the bulk update:

```ts
  const now = new Date();
  await db
    .update(jobs)
    .set({ ...requeueFields(), updatedAt: now })
    .where(and(eq(jobs.userId, userId), inArray(jobs.id, targetIds)));
```

and move the requeue into the existing `mapWithConcurrency` loop, as its first statement, because the cleared `result` differs per row:

```ts
  const outcomes = await mapWithConcurrency(retryTargets, 8, async (row) => {
    const ctxForChild = playlistContextForChild(row.id, catalog);
    // Before the enqueue, never after: a worker that picks the job up must
    // never see it still marked failed.
    await db
      .update(jobs)
      .set({
        ...requeueFields(),
        result: clearedFailureResult(row.result as Record<string, unknown> | null),
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.userId, userId), eq(jobs.id, row.id)));
    try {
```

Import `clearedFailureResult` from `../../../../../lib/retry-job`. Remove the now-unused `now` constant. `retryTargets` is read from `catalog`, which was fetched before any of this, so `row.result` still holds the pre-clear values that `downloadPayloadFromJob` reads — leave that call as it is.

Check whether `inArray` is still used anywhere in the file; if not, drop it from the `drizzle-orm` import so Biome does not flag it.

**Step 4: Run the tests to verify they pass**

```bash
cd apps/web && bun test lib/retry-job.test.ts && bun test lib/cookie-retry.test.ts
```

Expected: all pass.

**Step 5: Commit**

```bash
git add apps/web/lib/retry-job.ts apps/web/lib/retry-job.test.ts "apps/web/app/api/jobs/[id]/retry/route.ts"
git commit -m "Clear stale failure flags when a job is requeued."
```

---

## Task 5: Show the reason inline

**Files:**
- Modify: `apps/web/app/downloader/page.tsx`

No CSS file changes. The child list is already styled with Tailwind utilities inline; stay consistent with that rather than adding classes to `downloader.css`.

**Step 1: Add the import and the expand state**

Add to the imports:

```tsx
import { classifyFailure } from "./failure";
```

Next to `const [retryingId, setRetryingId] = useState<string | null>(null);` add:

```tsx
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
```

**Step 2: Render the reason on failed child tracks**

Replace the `kids.map(...)` body. The existing `<li>` becomes two rows: the track line as it is now, and the reason under it.

```tsx
                          {kids.map((kid) => {
                            const kidVerdict = verdictOf(kid);
                            const kidFailure = classifyFailure(kid);
                            const expanded = expandedIds.has(kid.id);
                            return (
                              <li key={kid.id} className="space-y-1">
                                <div className="flex items-center gap-2.5 text-xs">
                                  <StatusDot status={kid.status} />
                                  <span
                                    title={jobLabel(kid)}
                                    className="min-w-0 flex-1 truncate text-muted-foreground"
                                  >
                                    {jobLabel(kid)}
                                  </span>
                                  <span
                                    className={`text-[10px] font-medium tracking-wider uppercase ${TIER_TEXT[kidVerdict.tier]}`}
                                  >
                                    {kidVerdict.lead}
                                  </span>
                                  {kid.result?.fileId ? (
                                    <Button
                                      asChild
                                      variant="secondary"
                                      size="sm"
                                      className="h-6 px-2 text-[11px]"
                                    >
                                      <a
                                        href={`/api/files/${kid.result.fileId}`}
                                        aria-label={`Download ${jobLabel(kid)}`}
                                      >
                                        Download
                                      </a>
                                    </Button>
                                  ) : null}
                                </div>
                                {kidFailure ? (
                                  <button
                                    type="button"
                                    aria-expanded={expanded}
                                    aria-label={`Why ${jobLabel(kid)} failed`}
                                    onClick={() => toggleExpanded(kid.id)}
                                    className="block w-full pl-[18px] text-left text-[11px] leading-relaxed text-muted-foreground hover:text-foreground"
                                  >
                                    <span
                                      className={`font-medium ${TIER_TEXT.unsuitable}`}
                                    >
                                      {kidFailure.headline}
                                    </span>
                                    <span>
                                      {" — "}
                                      {expanded ? kidFailure.raw : kidFailure.detail}
                                    </span>
                                  </button>
                                ) : null}
                              </li>
                            );
                          })}
```

Note the `title={kidVerdict.detail}` tooltip on the tier badge is gone — the reason it carried is now on the page.

**Step 3: Replace the verdict paragraph for failed top-level jobs**

`verdictOf` already returns `{ tier: "unsuitable", lead: "failed", detail: job.error }` for a failed job, which would duplicate the new block. Inside the `topLevel.map` callback add, next to `const verdict = verdictOf(job);`:

```tsx
                const failure = classifyFailure(job);
```

and in `download-row-details`, replace the verdict paragraph's opening condition so the failure block wins:

```tsx
                      {failure ? (
                        <button
                          type="button"
                          aria-expanded={expandedIds.has(job.id)}
                          aria-label={`Why ${jobLabel(job)} failed`}
                          onClick={() => toggleExpanded(job.id)}
                          className={`mt-3 block w-full border-l-2 bg-muted/50 py-2 pl-3 text-left text-[13px] leading-relaxed ${TIER_RULE.unsuitable}`}
                        >
                          <span
                            className={`font-semibold tracking-wide uppercase ${TIER_TEXT.unsuitable}`}
                          >
                            {failure.headline}
                          </span>
                          <span className="text-muted-foreground">
                            {" — "}
                            {expandedIds.has(job.id) ? failure.raw : failure.detail}
                          </span>
                        </button>
                      ) : verdict.tier !== "pending" ? (
                        <p
                          className={`mt-3 border-l-2 bg-muted/50 py-2 pl-3 text-[13px] leading-relaxed ${TIER_RULE[verdict.tier]}`}
                        >
                          ...unchanged...
                        </p>
                      ) : null}
```

**Step 4: Verify in the browser**

```bash
bun run dev:web
```

Open `http://localhost:3004/downloader`. A playlist with failures should show a reason line under each failed track, and clicking one should swap the short hint for the full error. Nothing should change for a queue with no failures.

**Step 5: Commit**

```bash
git add apps/web/app/downloader/page.tsx
git commit -m "Show why each download failed, inline, with the raw error on click."
```

---

## Task 6: Bulk and per-track retry buttons

**Files:**
- Modify: `apps/web/app/downloader/page.tsx`
- Modify: `apps/web/lib/cookie-retry.test.ts` (the `"downloader wiring"` assertions)

**Step 1: Generalise the retry handler**

Rename `retryWithNewCookies` to `retryJob` and make the cookie sync conditional — re-syncing cookies before retrying a rate-limited track is a wasted round trip:

```tsx
  async function retryJob(jobId: string, needsCookies: boolean) {
    setRetryingId(jobId);
    setMessage(null);
    try {
      if (needsCookies && extensionReady) {
        const result = await requestExtensionSync();
        if (result.ok) {
          await refreshCookies();
        }
      }
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        retried?: number;
        skipped?: number;
        skippedReason?: string | null;
      };
      if (!res.ok) throw new Error(data.error ?? "Retry failed");
      setMessageTone("ok");
      const retried = data.retried === 1 ? "Retrying 1 track" : `Retrying ${data.retried} tracks`;
      setMessage(data.skippedReason ? `${retried} — ${data.skippedReason}` : retried);
      await refreshJobs();
    } catch (err) {
      setMessageTone("error");
      setMessage(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetryingId(null);
    }
  }
```

**Step 2: Wire the bulk button**

In `download-row-actions`, the existing block already computes `retryTargets` from the widened `jobsToRetry`, so only the call site changes:

```tsx
                      {retryTargets.length > 0 ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={retryingId !== null}
                          onClick={() =>
                            void retryJob(
                              job.id,
                              retryTargets.some((row) => cookieNeedsRefresh(row.error)),
                            )
                          }
                        >
                          {retryingId === job.id
                            ? "Retrying…"
                            : retryButtonLabel(retryTargets.length)}
                        </Button>
                      ) : null}
```

**Step 3: Wire the per-track button**

In the child row from Task 5, add a retry button before the Download button, shown only when that track failed:

```tsx
                                  {kidFailure ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-2 text-[11px]"
                                      disabled={retryingId !== null}
                                      onClick={() =>
                                        void retryJob(kid.id, cookieNeedsRefresh(kid.error))
                                      }
                                    >
                                      {retryingId === kid.id ? "Retrying…" : "Retry"}
                                    </Button>
                                  ) : null}
```

**Step 4: Update the wiring assertions**

In `apps/web/lib/cookie-retry.test.ts`, the `"downloader wiring"` test asserts `page).toContain("retryWithNewCookies")`. Change that expectation to `"retryJob"` and add `expect(page).toContain("classifyFailure");`.

**Step 5: Verify**

```bash
cd apps/web && bun test
```

Expected: all pass. Then in the browser, a failed playlist row should offer `Retry 11 failed` and each failed track its own `Retry`; clicking either should flip the rows to `Waiting to start`.

**Step 6: Commit**

```bash
git add apps/web/app/downloader/page.tsx apps/web/lib/cookie-retry.test.ts
git commit -m "Retry a whole failed batch or a single track."
```

---

## Task 7: Full verification

**Step 1: Types**

```bash
bun run check-types
```

Expected: clean. If `apps/web` complains about an unused `inArray` or `missingCookiesForRetry` import, that is Task 3 or 4 left half-done.

**Step 2: Tests**

```bash
bun run test
```

Expected: every package green, including `packages/pipeline` (untouched here, but `failure.test.ts` pins its copy — a failure there means someone changed an error string).

**Step 3: Lint and format**

```bash
bun run format-and-lint
```

Fix anything it reports with `bun run format-and-lint:fix`, then re-run.

**Step 4: Manual pass**

With `bun run dev:web`, confirm on `/downloader`:
- A failed track shows headline and hint; clicking expands to the raw error and clicking again collapses it.
- An `unknown` failure shows the raw error in both states (nothing to expand to, which is correct).
- A completed queue renders exactly as before — no reason lines, no retry buttons.
- The cookie-setup banner still appears when a cookie-class failure is present.

**Step 5: Commit anything outstanding**

```bash
git status
```

Expected: clean.
