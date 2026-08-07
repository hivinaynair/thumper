# Club-Ready-Only Download Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a downloader switch that discards any track whose measured audio does not reach 19 kHz, trying alternate sources before giving up.

**Architecture:** The measurement already exists — `classifyForDj` in `packages/pipeline/src/audio-verify.ts` returns a `master`/`club`/`marginal`/`unsuitable` tier from the real spectral cutoff, and `run-job.ts` already runs it on the pre-conversion source. This work makes that verdict binding behind a new `clubReadyOnly` boolean, plumbed exactly like the existing `freeDownloadsOnly` flag, and reroutes rejections into the SoundCloud→YouTube fallback that is already wired for preview-only and geo-blocked tracks.

**Tech Stack:** Bun 1.3 (test runner is `bun test`, built in), TypeScript, Turborepo monorepo, zod v4, Drizzle ORM + Postgres, Next.js 16 (App Router), pg-boss (local worker) / Modal (prod worker), ffmpeg + ffprobe (shelled out).

**Design doc:** `docs/plans/2026-08-07-club-ready-only-design.md`

---

## Background for the engineer

Read this before starting. It is not obvious from the code.

**The problem being solved.** A file can be lossless as a *container* and lossy as *audio*: take a 128 kbps stream, re-encode it as FLAC, and every container-level check now says "lossless" while the audio still has nothing above 15 kHz. On a club system that reads as dull, grainy highs. The only honest test is to decode the audio and look at where the frequency content stops — which is exactly what `analyzeAudioFile` does (`cutoffHz`). Never "improve" this by checking codec names or bitrates instead.

**Why the check runs where it does.** `verifyForDj` is called on the *downloaded source file*, before `convertAudio` rewraps it as AIFF/FLAC. After conversion the truth is gone. Do not move it later in the pipeline.

**Why rejection is expensive.** You cannot measure a spectrum without the bytes. "Doesn't download" really means "downloads, measures, discards, doesn't deliver." A rejected SoundCloud track may cost two downloads because a YouTube mirror is tried too. This is inherent; do not try to optimise it away.

**The monorepo.** One root `.env` for the whole repo; run everything from the repo root. `cd packages/pipeline && bun test` works for tests, but `bun run dev` must be run from root or turbo will not forward env vars.

**Testing conventions.** Tests live beside their source as `*.test.ts` and use `bun:test` (`import { describe, expect, it } from "bun:test"`). Everything tested is a pure function — there is no integration harness that runs real downloads, and this plan does not build one. Follow that: if logic needs testing, extract it as a pure function first.

**Type checking is strict.** `noUncheckedIndexedAccess` is on, so `array[0]` is `T | undefined` and must be narrowed. Run `bun run check-types` from root before every commit.

---

## Task 1: The `isClubReady` predicate

The threshold, as one pure function with tests. Nothing consumes it yet.

**Files:**
- Modify: `packages/pipeline/src/audio-verify.ts` (append after `classifyForDj`, before `verifyForDj`)
- Test: `packages/pipeline/src/audio-verify.test.ts`

**Step 1: Write the failing test**

Append to `packages/pipeline/src/audio-verify.test.ts`:

```ts
describe("isClubReady", () => {
  it("accepts master and club", () => {
    expect(isClubReady("master")).toBe(true);
    expect(isClubReady("club")).toBe(true);
  });

  it("rejects marginal and unsuitable", () => {
    expect(isClubReady("marginal")).toBe(false);
    expect(isClubReady("unsuitable")).toBe(false);
  });

  it("rejects a lossless container carrying lossy audio", () => {
    // The case the whole module exists for: FLAC wrapper, 16 kHz content.
    const tier = classifyForDj(
      analysis({ codec: "flac", cutoffHz: 16000, cutoffRatio: 16000 / (SR / 2) }),
    ).tier;
    expect(isClubReady(tier)).toBe(false);
  });
});
```

Add `isClubReady` to the existing import block at the top of the file, and `type DjTier` if not already imported.

**Step 2: Run the test to verify it fails**

```bash
cd packages/pipeline && bun test src/audio-verify.test.ts
```

Expected: FAIL — `isClubReady` is not exported.

**Step 3: Write the implementation**

In `packages/pipeline/src/audio-verify.ts`, after `classifyForDj`:

```ts
/**
 * The bar for "club-ready only" mode: measured content reaching CLUB_HZ,
 * whatever the container claims. Deliberately a tier check rather than a raw
 * cutoff comparison so the threshold lives in exactly one place.
 */
export const isClubReady = (tier: DjTier): boolean =>
  tier === "master" || tier === "club";
```

**Step 4: Run the test to verify it passes**

```bash
cd packages/pipeline && bun test src/audio-verify.test.ts
```

Expected: PASS, all tests in the file.

**Step 5: Commit**

```bash
git add packages/pipeline/src/audio-verify.ts packages/pipeline/src/audio-verify.test.ts && git commit -m "feat: isClubReady tier predicate"
```

---

## Task 2: `QualityGateError`

The typed rejection. Lives in `audio-verify.ts` beside the classifier, following the `ManualDownloadRequiredError` pattern in `soundcloud-purchase.ts:89`.

**Files:**
- Modify: `packages/pipeline/src/audio-verify.ts`
- Test: `packages/pipeline/src/audio-verify.test.ts`

**Step 1: Write the failing test**

```ts
describe("QualityGateError", () => {
  it("names the tier and where the audio stops", () => {
    const err = new QualityGateError({
      tier: "marginal",
      cutoffHz: 16200,
      source: "SoundCloud stream",
    });
    expect(err.message).toContain("16.2 kHz");
    expect(err.message).toContain("SoundCloud stream");
    expect(err.tier).toBe("marginal");
    expect(isQualityGateError(err)).toBe(true);
  });

  it("says so plainly when the audio could not be measured", () => {
    const err = new QualityGateError({ tier: null, source: "YouTube mirror" });
    expect(err.message).toContain("could not be verified");
    expect(isQualityGateError(err)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isQualityGateError(new Error("nope"))).toBe(false);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/pipeline && bun test src/audio-verify.test.ts
```

Expected: FAIL — `QualityGateError` is not exported.

**Step 3: Write the implementation**

In `packages/pipeline/src/audio-verify.ts`:

```ts
/**
 * Thrown when club-ready-only mode rejects a downloaded source.
 *
 * `tier: null` means the analysis itself failed — an unmeasurable file is not
 * evidence of a good one, so the gate treats it as a rejection.
 */
export class QualityGateError extends Error {
  readonly tier: DjTier | null;
  readonly cutoffHz: number | null;

  constructor(params: {
    tier: DjTier | null;
    cutoffHz?: number;
    /** Human name of the attempted source, e.g. "SoundCloud stream". */
    source: string;
  }) {
    super(
      params.tier === null
        ? `${params.source} could not be verified, and club-ready-only mode does not ship unverified audio. Turn the switch off to download it anyway.`
        : `${params.source} is not club-ready — audio stops at ${kHz(
            params.cutoffHz ?? 0,
          )}. Turn the switch off to download it anyway.`,
    );
    this.name = "QualityGateError";
    this.tier = params.tier;
    this.cutoffHz = params.cutoffHz ?? null;
  }
}

export function isQualityGateError(err: unknown): err is QualityGateError {
  return err instanceof QualityGateError;
}
```

`kHz` is the existing module-private helper at `audio-verify.ts:247`. Add `QualityGateError` and `isQualityGateError` to the test file's import block.

**Step 4: Run the test to verify it passes**

```bash
cd packages/pipeline && bun test src/audio-verify.test.ts
```

Expected: PASS.

**Step 5: Type check and commit**

```bash
bun run check-types
git add packages/pipeline/src/audio-verify.ts packages/pipeline/src/audio-verify.test.ts && git commit -m "feat: QualityGateError for club-ready rejections"
```

---

## Task 3: Plumb `clubReadyOnly` through the schemas

Pure plumbing, no behaviour. Mirror `freeDownloadsOnly` at every site — do not invent a different shape.

**Files:**
- Modify: `packages/shared/src/index.ts` (two schemas)
- Modify: `packages/db/src/schema.ts:98` area
- Modify: `apps/web/app/api/jobs/route.ts:203-208`, `:273`
- Modify: `apps/worker/src/process-one.ts:147-167`, `:221-232`, `:245-249`, `:269`
- Modify: `apps/worker/src/index.ts:148-162`, `:180`

**Step 1: `packages/shared/src/index.ts`**

In `CreateJobInputSchema`, after `freeDownloadsOnly`:

```ts
  /**
   * Reject any track whose measured audio does not reach 19 kHz, after trying
   * alternate sources. Applies to every source kind, not just SoundCloud.
   */
  clubReadyOnly: z.boolean().optional().default(false),
```

In `DownloadJobPayloadSchema`, after its `freeDownloadsOnly`:

```ts
  /** When true, only club-ready sources are delivered; the rest fail. */
  clubReadyOnly: z.boolean().optional().default(false),
```

**Step 2: `packages/db/src/schema.ts`**

In the `jobs.result` type, after the `freeDownloadsOnly?: boolean;` line:

```ts
    /** Club-ready-only mode was on for this job. */
    clubReadyOnly?: boolean;
    /** Set when the club-ready gate rejected every source. */
    qualityRejected?: boolean;
```

No migration is needed — `result` is `jsonb` and this is a type-level change only. Do **not** run `db:generate`.

**Step 3: `apps/web/app/api/jobs/route.ts`**

After the `freeDownloadsOnly` const (~line 203):

```ts
  // Unlike freeDownloadsOnly this is not SoundCloud-specific — a YouTube-only
  // job can flunk the bar just as easily.
  const clubReadyOnly = Boolean(input.clubReadyOnly);
```

Add to `jobResult`:

```ts
    ...(clubReadyOnly ? { clubReadyOnly: true } : {}),
```

Add `clubReadyOnly,` to the `boss.send` payload beside `freeDownloadsOnly` (~line 273).

**Step 4: `apps/worker/src/process-one.ts`**

Add `clubReadyOnly?: boolean;` to the `gateMeta` type (~line 151). Add to the `payload` object (~line 166):

```ts
    clubReadyOnly: Boolean(gateMeta?.clubReadyOnly),
```

In `enqueueChildTracks`, widen the child-row condition and add the field — three sites:

```ts
// ~line 221 — condition
...((p.gateEmail || p.freeDownloadsOnly || p.clubReadyOnly)
  ? {
      result: {
        ...(p.gateEmail ? { gateEmail: p.gateEmail, gateName: p.gateName } : {}),
        ...(p.freeDownloadsOnly ? { freeDownloadsOnly: true } : {}),
        ...(p.clubReadyOnly ? { clubReadyOnly: true } : {}),
      },
    }
  : {}),

// ~line 248 — parent rollup result
...(p.clubReadyOnly ? { clubReadyOnly: true } : {}),

// ~line 269 — recursive runOne payload
clubReadyOnly: p.clubReadyOnly,
```

**Step 5: `apps/worker/src/index.ts`**

Same three edits against `parent` instead of `p`: widen the condition at ~line 148, add `...(parent.clubReadyOnly ? { clubReadyOnly: true } : {})` to the child result, and `clubReadyOnly: parent.clubReadyOnly,` to the `boss.send` payload at ~line 180.

**Step 6: Verify nothing broke**

```bash
bun run check-types && bun run lint && bun run test
```

Expected: all pass. The `satisfies DownloadJobPayload` in `index.ts` is what catches a missed field — if it errors, a site was skipped.

**Step 7: Commit**

```bash
git add -A && git commit -m "feat: plumb clubReadyOnly flag through job schemas"
```

---

## Task 4: Enforce the gate in `processTrack`

The behaviour change. `packages/pipeline/src/run-job.ts`, at the existing verdict site (~line 395).

**Files:**
- Modify: `packages/pipeline/src/run-job.ts`

**Step 1: Extend the fallback reason union**

In `fallbackSoundCloudToYoutube` (~line 695) add `"low-quality"` to the `reason` union, and extend the no-mirror message (~line 721):

```ts
    const because =
      params.reason === "preview-only"
        ? "SoundCloud only has a preview (often geo-blocked or Go+)"
        : params.reason === "low-quality"
          ? "SoundCloud's audio isn't club-ready"
          : "SoundCloud audio is unavailable (DRM or region-locked)";
```

**Step 2: Make analysis failure a rejection**

Replace the verify block at ~line 395:

```ts
  let verdict: DjVerdict | null = null;
  try {
    verdict = await verifyForDj(downloaded.filePath, { signal });
  } catch (err) {
    if (err instanceof ProcessCancelledError) throw err;
    // Verification is advisory — never fail a job because analysis broke.
    // Except in club-ready-only mode: a file we could not measure is not
    // evidence of a good file, and the switch promises a floor.
    if (payload.clubReadyOnly) {
      await fs.unlink(downloaded.filePath).catch(() => undefined);
      throw new QualityGateError({ tier: null, source: sourceLabel });
    }
  }
```

Define `sourceLabel` just above the block:

```ts
  const sourceLabel = soundcloud ? "SoundCloud" : "YouTube";
```

**Step 3: Reject a measured-but-poor source, trying a mirror first**

Immediately after the verify block, before `const warnings = ...`:

```ts
  if (payload.clubReadyOnly && verdict && !isClubReady(verdict.tier)) {
    await fs.unlink(downloaded.filePath).catch(() => undefined);
    // A SoundCloud stream that flunks is often fine on YouTube (Premium Opus
    // beats SC's AAC). The mirror attempt runs with allowYoutubeFallback:false,
    // so this recurses at most one hop.
    if (
      soundcloud &&
      !youtubeAlreadyTried &&
      params.allowYoutubeFallback !== false
    ) {
      await fallbackSoundCloudToYoutube({
        deps,
        trackUrl: params.trackUrl,
        titleHint: params.titleHint,
        artistHint: params.artistHint,
        scCookieTmp: cookieTmp,
        workDir,
        outDir,
        matchScore: params.matchScore,
        catalogUrl: params.catalogUrl ?? params.trackUrl,
        reason: "low-quality",
      });
      return;
    }
    throw new QualityGateError({
      tier: verdict.tier,
      cutoffHz: verdict.analysis.cutoffHz,
      source: `${sourceLabel} audio`,
    });
  }
```

Import `isClubReady` and `QualityGateError` from `./audio-verify` in the existing import at `run-job.ts:17`.

**Step 4: Nothing to do for the YouTube-first path**

`trySoundCloudViaYoutubeFirst` (~line 675) already catches every non-cancel error and returns `"youtube_failed"`, so a mirror that flunks the gate falls through to the SoundCloud stream attempt on its own. Confirm by reading it; do not change it.

**Step 5: Widen the `update` callback's result type**

The `update` callback declares its own inline `result` shape at `run-job.ts:71-103`, a third copy of the result type that Task 3 did not touch. Add to it, beside `gateEmail` / `gateName`:

```ts
    freeDownloadsOnly?: boolean;
    clubReadyOnly?: boolean;
    qualityRejected?: boolean;
```

`freeDownloadsOnly` is included because `run-job.ts:964` already writes it, and the type has been silently tolerating it.

**Step 6: Surface the rejection on the job row**

**Critical, and not obvious:** result writes *overwrite*, they do not merge — `apps/worker/src/process-one.ts:63` is `values.result = patch.result`. So the `clubReadyOnly: true` seeded at enqueue is gone the moment the pipeline writes its first result. Every terminal write must therefore be self-contained and re-state the mode.

In the outer `catch` of `runDownloadJob` (~line 1001), add a branch before the generic handler, after the `isManualDownloadRequiredError` one:

```ts
    if (isQualityGateError(err)) {
      await update({
        status: "failed",
        stage: "error",
        error: err.message,
        result: {
          // Re-stated because result writes overwrite rather than merge; the
          // flag seeded at enqueue is long gone by now.
          clubReadyOnly: true,
          qualityRejected: true,
          ...(err.tier != null ? { djTier: err.tier } : {}),
          ...(err.cutoffHz != null ? { cutoffHz: err.cutoffHz } : {}),
        },
      });
      throw err;
    }
```

Also add to the **success** result write at `run-job.ts:525`, so a completed job still shows the mode it ran under:

```ts
      ...(payload.clubReadyOnly ? { clubReadyOnly: true } : {}),
```

Add `isQualityGateError` to the `./audio-verify` import.

**Step 6: Verify**

```bash
bun run check-types && bun run lint && bun run test
```

Expected: all pass. There is no integration test for this path — the behaviour is verified manually in Task 7.

**Step 7: Commit**

```bash
git add packages/pipeline/src/run-job.ts && git commit -m "feat: enforce club-ready gate with mirror fallback"
```

---

## Task 5: Gate the Hypeddit path

`processHypedditRetag` (`run-job.ts:163`) hands the gate download straight to retag with no verification at all. A Hypeddit "free download" is frequently a 320 kbps MP3 that then gets rewrapped as AIFF — the exact laundered-lossy case.

**Files:**
- Modify: `packages/pipeline/src/run-job.ts:187-211`

**Step 1: Verify before the retag handoff**

After `downloadHypedditGate` returns and before the `contentType` block:

```ts
  if (payload.clubReadyOnly) {
    let hypedditVerdict: DjVerdict | null = null;
    try {
      hypedditVerdict = await verifyForDj(downloaded.filePath, { signal });
    } catch (err) {
      if (err instanceof ProcessCancelledError) throw err;
    }
    if (!hypedditVerdict || !isClubReady(hypedditVerdict.tier)) {
      await fs.unlink(downloaded.filePath).catch(() => undefined);
      // Split rather than `tier ?? null`: QualityGateError's constructor is a
      // discriminated union, so a known tier must carry its measurement.
      throw hypedditVerdict
        ? new QualityGateError({
            tier: hypedditVerdict.tier,
            cutoffHz: hypedditVerdict.analysis.cutoffHz,
            source: "This Hypeddit Free Download",
          })
        : new QualityGateError({
            tier: null,
            source: "This Hypeddit Free Download",
          });
    }
  }
```

There is no alternate source here — the gate link is the only route — so this fails outright rather than falling back. Use `source: "The Hypeddit Free Download"` to match the source-naming convention Task 4 established.

**Step 1b: Keep the flag alive through the retag handoff**

Hypeddit successes are written by `runRetagJob` in a different module, which knows nothing about `clubReadyOnly`. Because result writes overwrite rather than merge, a Hypeddit-delivered track would come back with the flag absent — no badge on exactly the highest-quality path.

Thread it the same way `hypedditOriginal` is already threaded:

- `packages/shared/src/index.ts` — add `clubReadyOnly: z.boolean().optional().default(false),` to `RetagJobPayloadSchema`.
- `run-job.ts` — pass `clubReadyOnly: payload.clubReadyOnly` in the `runRetagJob` call inside `processHypedditRetag`.
- `packages/pipeline/src/retag-job.ts` — add `...(payload.clubReadyOnly ? { clubReadyOnly: true } : {}),` to the completion `result`, beside the existing `hypedditOriginal` spread.

**Step 2: Verify**

```bash
bun run check-types && bun run lint && bun run test
```

**Step 3: Commit**

```bash
git add packages/pipeline/src/run-job.ts && git commit -m "feat: gate Hypeddit free downloads on club-ready"
```

---

## Task 6: The switch and the rejected chip

**Files:**
- Modify: `apps/web/app/downloader/page.tsx`
- Modify: `apps/web/app/globals.css`

**Step 1: Extend the `Job` result type**

In the `Job` type (~line 20), beside `freeDownloadsOnly`:

```ts
		clubReadyOnly?: boolean;
		qualityRejected?: boolean;
```

**Step 2: State, persisted in localStorage**

Sticky per browser. There is no settings API and the `user_settings` table is unused — leave it that way.

Beside the other `useState` calls (~line 280):

```ts
	const [clubReadyOnly, setClubReadyOnly] = useState(false);
```

Then, after the existing `extensionReady` effect:

```ts
	// Read after mount, not in the initializer: this page renders on the server
	// and touching localStorage during render would break hydration.
	useEffect(() => {
		setClubReadyOnly(
			window.localStorage.getItem("thumper.clubReadyOnly") === "true",
		);
	}, []);

	useEffect(() => {
		window.localStorage.setItem(
			"thumper.clubReadyOnly",
			String(clubReadyOnly),
		);
	}, [clubReadyOnly]);
```

**Step 3: Send it**

Add `clubReadyOnly,` to the `createJob` fetch body (~line 376), beside `freeDownloadsOnly`.

**Step 4: The control**

After the free-downloads-only `label.check-row` (~line 586):

```tsx
					<label className="check-row">
						<input
							type="checkbox"
							checked={clubReadyOnly}
							onChange={(e) => setClubReadyOnly(e.target.checked)}
						/>
						<span>
							Club-ready only
							<span className="check-row-hint">
								Measures the downloaded audio and rejects anything that
								doesn’t reach 19 kHz. Tries a YouTube mirror before giving
								up, so a rejected track can cost two downloads.
							</span>
						</span>
					</label>
```

Use the existing `check-row` markup rather than introducing a Switch component — the form already has one checkbox of this kind and a second styled differently would look accidental.

**Step 5: Job meta and the rejected chip**

In `job-meta` (~line 634), beside the free-downloads-only entry:

```tsx
										{job.result?.clubReadyOnly ? " · club-ready only" : ""}
```

Before the existing `QualityBadge` block (~line 684), add the rejection chip:

```tsx
									{job.result?.qualityRejected ? (
										<div className="quality-badge unsuitable">
											<strong>Rejected — not club-ready</strong>
											{job.result.cutoffHz
												? ` — audio stopped at ${(
														job.result.cutoffHz / 1000
													).toFixed(1)} kHz`
												: " — quality could not be verified"}
										</div>
									) : null}
```

Then guard the existing `QualityBadge` so a rejected job does not show two badges:

```tsx
									{job.result?.djTier &&
									job.result.djTier !== "master" &&
									!job.result.qualityRejected ? (
```

The `cutoffHz` ternary is load-bearing, not defensive: a `tier: null` rejection ("couldn't measure it") writes no `cutoffHz` at all, and rendering it unguarded would print "undefined kHz".

**Step 5b: Known gaps, do not try to fix here**

The `· club-ready only` meta line is driven by `result.clubReadyOnly`, which is only present on quality rejections and successes. A Hypeddit job that dies during convert or upload writes an `error` with no `result`, so the line will blink out on those. Accept it — making it stable means reading the job's request flag rather than its result, which is a wider change than this task.

The manual-download failure branch (`run-job.ts`, `isManualDownloadRequiredError`) writes a `result` containing only its two manual-download fields, discarding the enqueue-seeded `clubReadyOnly`. `freeDownloadsOnly` already has this hole and the existing UI already reads through it. Leave it; just don't expect the "club-ready only" meta line on a manual-download failure.

**Step 6: CSS**

`.quality-badge.unsuitable` already exists at `globals.css:855` and carries the right styling. No CSS changes needed — verify by reading it, and only add a rule if the chip is unreadable.

**Step 7: Verify**

```bash
bun run check-types && bun run lint
```

**Step 8: Commit**

```bash
git add apps/web && git commit -m "feat: club-ready-only switch and rejected chip"
```

---

## Task 7: Manual verification

No integration harness exists, so the end-to-end behaviour is checked by hand. Do not skip this and do not report the feature working without it.

**Step 1: Start the stack**

```bash
docker compose up -d postgres && bun run dev
```

Open http://localhost:3004/downloader.

**Step 2: Switch off — nothing regressed**

Queue any SoundCloud track with the switch off. Expect: completes as before, quality badge unchanged.

**Step 3: Switch on — a good track still lands**

Queue a track you know is a proper master (an artist free download). Expect: completes, no rejection chip.

**Step 4: Switch on — a bad track is rejected**

Queue a track whose badge previously read `marginal` or `unsuitable`. Expect: status `failed`, the "Rejected — not club-ready" chip with a kHz figure, and no file delivered. Confirm the worker log shows a YouTube mirror was attempted first.

**Step 5: Stickiness**

Reload the page. The switch keeps its position.

**Step 6: Playlist**

Queue a SoundCloud set with the switch on. Expect: rejected tracks fail individually, the parent still completes, and the failed-tracks rollup names them.

**Step 7: Commit anything the verification turned up**

If steps 2–6 required fixes, commit them with a message describing the actual defect found.

---

## Out of scope

Do not build these, even if they seem natural:

- The `/retag` upload page — the switch is downloader-only.
- A configurable minimum-tier dropdown.
- Wiring `defaultFormat` / `defaultDestination` in the unused `user_settings` table.
- Rejecting on clipping or missing headroom — that warning stays advisory by explicit decision.
