# Preserve SoundCloud Artist Originals Implementation Plan

> **For the implementing agent:** Use test-driven development and complete each task in order.

**Goal:** Deliver SoundCloud and Hypeddit artist originals without audio processing, except for an unfiltered, lossless WAV-to-FLAC metadata conversion.

**Architecture:** Add a small pure policy that chooses `convert-wav` or
`preserve-original` from artist-original provenance and the downloaded
extension. Both the direct SoundCloud and Hypeddit paths use that policy before
conversion. Refactor artifact delivery just enough that the existing storage,
Drive, database, cleanup, and result code can accept either the downloaded
source or a converted output.

**Tech Stack:** Bun, TypeScript, FFmpeg/FFprobe, Drizzle, object storage, Google Drive.

---

### Task 1: Encode the artist-original policy

**Files:**

- Create: `packages/pipeline/src/artist-original.ts`
- Create: `packages/pipeline/src/artist-original.test.ts`
- Modify: `packages/pipeline/src/index.ts`

1. Write failing table-driven tests for a pure
   `artistOriginalAction({ artistOriginal, extension })` function:
   - artist-original `wav` and case variants return `convert-wav`;
   - artist-original MP3, AIFF, AIF, FLAC, M4A, and unknown formats return
     `preserve-original`;
   - non-original inputs return `normal-conversion`.
2. Run `bun test src/artist-original.test.ts` from `packages/pipeline` and
   confirm the missing API causes the expected failure.
3. Implement the minimal normalized-extension policy and export it.
4. Re-run the focused test and confirm it passes.

### Task 2: Prove WAV-to-FLAC is unfiltered and bit-depth preserving

**Files:**

- Modify: `packages/pipeline/src/convert.ts`
- Modify: `packages/pipeline/src/convert.test.ts`

1. Extract or expose the FFmpeg argument construction behind `convertAudio` so
   tests can inspect it without spawning FFmpeg.
2. Write failing tests proving a lossless WAV source converted to FLAC:
   - has no `-af`, `volume`, or `alimiter`;
   - keeps the source sample rate and channels;
   - does not force 16-bit output;
   - still embeds supplied metadata and artwork.
3. Run `bun test src/convert.test.ts` and confirm the new argument-level tests
   fail before the extraction/implementation.
4. Implement the smallest argument-builder seam while preserving current
   stream behavior.
5. Add an FFmpeg-backed fixture test that creates a 24-bit WAV, converts it,
   probes the FLAC, and asserts `bits_per_raw_sample=24`.
6. Re-run the focused tests.

### Task 3: Preserve direct SoundCloud originals

**Files:**

- Modify: `packages/pipeline/src/run-job.ts`
- Create: `packages/pipeline/src/run-job-original.test.ts`

1. Extract a testable artifact-selection function receiving provenance,
   downloaded path/extension, requested output format, and resolved tags.
2. Write failing tests proving:
   - direct SoundCloud `format_id=download` WAV selects FLAC conversion with
     `peakLimitLossy` disabled;
   - every other direct artist-original extension selects the downloaded path
     and never calls conversion;
   - the requested output format cannot override either decision;
   - non-original streams retain normal conversion and stream peak limiting.
3. Run the focused test and confirm it fails for the current unconditional
   conversion.
4. Implement the policy branch after source verification.
5. For preserved originals, use the downloaded file as the delivery artifact,
   retain its extension, derive its MIME type, and skip artwork download and
   FFmpeg entirely.
6. Keep quality analysis read-only and preserve existing quality-gate behavior.
7. Re-run the focused tests.

### Task 4: Apply the same policy to Hypeddit originals

**Files:**

- Modify: `packages/pipeline/src/run-job.ts`
- Modify: `packages/pipeline/src/retag-job.ts`
- Modify: `packages/pipeline/src/run-job-original.test.ts`

1. Write failing tests proving Hypeddit MP3, AIFF, FLAC, and unknown files
   bypass `runRetagJob`/FFmpeg, while Hypeddit WAV enters the WAV-to-FLAC path.
2. Run the focused tests and confirm the current unconditional `runRetagJob`
   call fails them.
3. Pass source-extension/provenance intent through the existing Hypeddit
   handoff, or bypass the retag job for preserved originals—choose the smaller
   implementation that reuses the direct-path delivery logic.
4. Ensure preserved Hypeddit files report their real MIME type and extension;
   WAV conversions report FLAC.
5. Re-run the focused tests.

### Task 5: Unify and verify artifact delivery

**Files:**

- Modify: `packages/pipeline/src/run-job.ts`
- Modify: `packages/pipeline/src/retag-job.ts` only if still needed
- Modify: relevant focused tests

1. Introduce a private delivery-artifact structure containing `path`,
   `filename`, `mime`, `qualityLabel`, and whether audio was converted.
2. Route browser/object-storage, Drive, file-row creation, result metadata, and
   cleanup through that structure.
3. Ensure cleanup never removes the preserved source before successful
   delivery.
4. Run:
   - `bun test src/artist-original.test.ts`
   - `bun test src/convert.test.ts`
   - `bun test src/run-job-original.test.ts`
     from `packages/pipeline`.
5. Run the complete pipeline suite with `bun test` from `packages/pipeline`.
6. Run the repository typecheck/lint commands defined in the root
   `package.json`.
7. Inspect `git diff --check` and the final diff. Do not commit unless the user
   explicitly requests it.

### Task 6: Fix Instagram and Spotify Hypeddit gates

**Files:**

- Modify: `packages/pipeline/src/hypeddit.ts`
- Modify: `packages/pipeline/src/hypeddit.test.ts`
- Modify: `packages/pipeline/src/run-job.ts`
- Modify: `packages/pipeline/package.json`
- Modify: `apps/modal/thumper_worker.py`
- Modify: `Dockerfile`
- Modify: `bun.lock`

1. Write failing parser/request tests proving `externID` is captured from the
   gate page and sent as `external_id` for browserless Instagram gates.
2. Replace the unrestricted “skip every non-email step” behavior with an
   explicit browserless allowlist: email, SoundCloud, Instagram, TikTok,
   YouTube, and Facebook. Return a typed browser-required result for Spotify or
   unknown steps.
3. Run `bun test src/hypeddit.test.ts` and verify the expected failures, then
   implement the minimal HTTP fix and rerun.
4. Add `puppeteer-core` as a pipeline dependency and install system Chromium in
   both worker images. Keep its value import in a dynamically loaded
   worker-only module. Configure `PUPPETEER_EXECUTABLE_PATH` to a Python
   setuid wrapper that drops Chromium to dedicated uid/gid 922 with a minimal
   environment and disposable owned profile. Do not use `setpriv` (its bounding
   set is blocked in Docker/Modal). The wrapper scopes `--no-sandbox` to the
   already-isolated container because Docker/Modal block nested Chromium
   namespaces; no browser binary is downloaded by the package manager.
5. Write failing unit tests around Netscape-cookie parsing, browser-fallback
   selection, selector safety, popup/no-popup OAuth completion, cancellation,
   and unconditional browser cleanup. Keep Puppeteer behind injected interfaces
   so focused tests do not launch Chrome.
6. Implement an isolated headless Spotify flow:
   - materialize the user's encrypted Spotify cookie file;
   - import only Spotify-domain cookies;
   - open the Hypeddit gate and select the Spotify step;
   - opt out of optional marketing where offered;
   - authorize in an OAuth popup when one appears, or continue when already
     authorized;
   - let Hypeddit's OAuth callback perform its configured follow/save action,
     require its authoritative `input#nwSteps` pending state to parse and no
     longer contain `sp`, then download the resulting file; generic controls
     are not completion evidence;
   - abort and close the browser on cancellation or failure.
7. Update `processHypedditRetag` to try HTTP first and invoke the browser only
   for a typed browser-required result. If cookies are missing or stale, return
   a specific refresh message.
8. Run focused Hypeddit tests, the full pipeline suite, extension/worker
   typechecks, repository lint, and `git diff --check`.

### Task 7: Retry transient Modal cleanup connections

**Files:**

- Modify: `apps/modal/thumper_worker.py`
- Create: `apps/modal/test_thumper_worker.py` or an equivalent isolated unit test

1. Write a failing test that runs a fake sweep command returning `ETIMEDOUT`
   once and success once, and asserts two attempts and a successful result.
2. Extract the existing bounded subprocess retry used by `process_job` into a
   small helper shared with `sweep_expired`.
3. Retry only known transient connection failures (`ETIMEDOUT` and
   `CONNECT_TIMEOUT`), at most once. All other failures still raise immediately.
4. Run the focused Python test and preserve the existing output truncation in
   raised errors.

### Task 8: Release

1. Run all focused tests, full repository tests, typechecks, lint, builds, and
   `git diff --check`.
2. Review the complete branch diff against the approved design.
3. Commit the reviewed changes, push `feat/preserve-soundcloud-originals`, and
   record the pushed commit SHA.
4. Deploy `apps/modal/thumper_worker.py` to the existing Modal `main`
   environment and verify the scheduled function is registered.
5. Deploy the linked Vercel project to production and verify the production URL
   reports READY.
